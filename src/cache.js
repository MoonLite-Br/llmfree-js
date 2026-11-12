import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_AGE = 24 * 3600;

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

export function save(dir, results) {
  if (!dir) return null;
  try {
    writeAtomic(dir, "health.json", JSON.stringify({ checked_at: Date.now() / 1000, results }));
    return path.join(dir, "health.json");
  } catch {
    return null;
  }
}

export const HISTORY_WINDOW = 20;
export const MIN_SAMPLES = 3;
export const MIN_RATE = 0.5;

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
  } catch {   }
}

export function rate(history) {
  return history ? [...history].filter((c) => c === "1").length / history.length : null;
}

export function unreliable(history) {
  return history.length >= MIN_SAMPLES && rate(history) < MIN_RATE;
}

export const PACE_MIN_INTERVAL = 5;

export function paceLast(dir, provider) {
  if (!dir) return null;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, "pace.json"), "utf8"))[provider];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function paceSet(dir, provider, wall) {
  if (!dir) return;
  let all = {};
  try { all = JSON.parse(fs.readFileSync(path.join(dir, "pace.json"), "utf8")) || {}; } catch {   }
  if (typeof all[provider] === "number" && all[provider] >= wall) return;
  all[provider] = wall;
  try { writeAtomic(dir, "pace.json", JSON.stringify(all)); } catch {   }
}
