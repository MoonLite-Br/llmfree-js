import { isIP } from "node:net";
// Small helpers shared across modules.

export const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));

/** Monotonic clock in seconds. */
export const now = () => performance.now() / 1000;

export function randomHex(bytes) {
  return [...globalThis.crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Python's ``difflib.SequenceMatcher.ratio()`` (Ratcliff/Obershelp), for "did you mean" hints. */
export function similarity(a, b) {
  const total = a.length + b.length;
  if (!total) return 1;
  const matches = (alo, ahi, blo, bhi) => {
    let best = 0, ai = alo, bj = blo;
    for (let i = alo; i < ahi; i++) {
      for (let j = blo; j < bhi; j++) {
        let k = 0;
        while (i + k < ahi && j + k < bhi && a[i + k] === b[j + k]) k++;
        if (k > best) [best, ai, bj] = [k, i, j];
      }
    }
    if (!best) return 0;
    return best + matches(alo, ai, blo, bj) + matches(ai + best, ahi, bj + best, bhi);
  };
  return (2 * matches(0, a.length, 0, b.length)) / total;
}

export function closeMatches(word, pool, n = 3, cutoff = 0.6) {
  return pool
    .map((p) => [similarity(word, p), p])
    .filter(([s]) => s >= cutoff)
    .sort((x, y) => y[0] - x[0])
    .slice(0, n)
    .map(([, p]) => p);
}

/** True for a public-looking host name / IP: no loopback, LAN, link-local, CGNAT, ``.local``/``.internal`` or single-label names. */
export function isPublicHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return false;
  const v = isIP(h);
  if (v === 4) {
    const [a, b] = h.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224);
  }
  if (v === 6) {
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (m) return isPublicHost(m[1]);
    return !(h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^ff/.test(h));
  }
  if (!h.includes(".") || /(^|\.)(localhost|local|internal|lan|home|localdomain|intranet)$/.test(h)) return false;
  return true;
}
