// On-disk health/latency cache written by ``llmf doctor`` and read by the Client.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_AGE = 24 * 3600; // seconds

/** Directory for cache files, or ``null`` when caching is disabled (``LLMF_NO_CACHE=1``). */
export function cacheDir() {
  if (process.env.LLMF_NO_CACHE) return null;
  if (process.env.LLMF_CACHE_DIR) return process.env.LLMF_CACHE_DIR;
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "llmf");
}

function writeAtomic(dir, name, data) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, path.join(dir, name));
}

/** Recent results (``provider``, ``model``, ``ok``, ``latency``) or ``[]``. */
export function load(dir) {
  if (!dir) return [];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, "health.json"), "utf8"));
    if (Date.now() / 1000 - Number(data.checked_at || 0) > MAX_AGE) return [];
    return (data.results || []).filter((r) => r && typeof r === "object");
  } catch {
    return [];
  }
}

/** Atomically write results; returns the file path (or ``null`` if it cannot). */
export function save(dir, results) {
  if (!dir) return null;
  try {
    writeAtomic(dir, "health.json", JSON.stringify({ checked_at: Date.now() / 1000, results }));
    return path.join(dir, "health.json");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- survival history
export const HISTORY_WINDOW = 20; // keep the last N doctor results per model
export const MIN_SAMPLES = 3; // a model needs this many samples before its rate demotes it
export const MIN_RATE = 0.5; // ... and a success rate below this demotes it

/** ``{"provider/model": "1101..."}`` (newest last; ``1`` = answered, ``0`` = failed). */
export function loadHistory(dir) {
  if (!dir) return {};
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, "history.json"), "utf8"));
    const out = {};
    for (const [k, v] of Object.entries(data)) if (typeof v === "string" && /^[01]*$/.test(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Append one doctor result per model to the survival history. */
export function record(dir, rows) {
  if (!dir || !rows.length) return;
  const hist = loadHistory(dir);
  for (const r of rows) {
    if (r?.provider == null || r?.model == null) continue;
    const k = `${r.provider}/${r.model}`;
    hist[k] = ((hist[k] || "") + (r.ok ? "1" : "0")).slice(-HISTORY_WINDOW);
  }
  try {
    writeAtomic(dir, "history.json", JSON.stringify(Object.fromEntries(Object.entries(hist).sort())));
  } catch { /* read-only cache dir: history is a nicety */ }
}

/** Success rate 0..1 of a history string, or ``null`` when there is none. */
export function rate(history) {
  return history ? [...history].filter((c) => c === "1").length / history.length : null;
}

/** Enough samples and a low success rate. */
export function unreliable(history) {
  return history.length >= MIN_SAMPLES && rate(history) < MIN_RATE;
}

// --- pacing across processes: ``llmf ask`` twice in a row must still respect a provider's minimum gap
export const PACE_MIN_INTERVAL = 5; // only providers with a gap this long are tracked (a file write per call otherwise)

/** Wall-clock time (epoch seconds) of the last reserved slot for ``provider``, if recorded and sane. */
export function paceLast(dir, provider) {
  if (!dir) return null;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, "pace.json"), "utf8"))[provider];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Record the slot, never moving an existing (newer) one back. */
export function paceSet(dir, provider, wall) {
  if (!dir) return;
  let all = {};
  try { all = JSON.parse(fs.readFileSync(path.join(dir, "pace.json"), "utf8")) || {}; } catch { /* first write */ }
  if (typeof all[provider] === "number" && all[provider] >= wall) return;
  all[provider] = wall;
  try { writeAtomic(dir, "pace.json", JSON.stringify(all)); } catch { /* pacing memory is a nicety */ }
}
