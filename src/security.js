// Security building blocks for ``llmf serve`` (node:crypto only).
//
// * RateLimiter - token bucket per key (IP, API key id, ...).
// * BanList     - temporary block after repeated authentication failures.
// * parseNetworks / ipIn - allow/deny lists in CIDR notation.
// * Antibot     - stateless proof-of-work (or Cloudflare Turnstile) that turns a visitor into a short-lived,
//                 IP-bound session token, so a public web chat is not open to scripts.
import crypto from "node:crypto";
import { isIP } from "node:net";
import { decodeBody, openUrl } from "./http.js";

export const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const SESSION_PREFIX = "llmf1.";

const mono = () => Number(process.hrtime.bigint()) / 1e9;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

// --------------------------------------------------------------------------- helpers
/** Short, non-reversible id for logs and rate-limit buckets (never log the key itself). */
export const keyId = (secret) => sha256(String(secret)).toString("hex").slice(0, 8);
export const newApiKey = () => "llmf-" + crypto.randomBytes(24).toString("base64url");

function v6ToBig(ip) {
  ip = ip.split("%")[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (tail) { // ::ffff:1.2.3.4 style
    const p = tail[1].split(".").map(Number);
    ip = ip.slice(0, -tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, rest] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = rest !== undefined ? (rest ? rest.split(":") : []) : [];
  const groups = rest !== undefined ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || "0", 16)), 0n);
}

/** ``{ v: 4|6, n: BigInt }`` for an address (IPv4-mapped IPv6 becomes IPv4), or ``null``. */
export function addr(ip) {
  const s = String(ip || "").trim().split("%")[0].replace(/^\[|\]$/g, "");
  const v = isIP(s);
  if (v === 4) return { v: 4, n: s.split(".").reduce((a, p) => (a << 8n) | BigInt(p), 0n) };
  if (v === 6) {
    const n = v6ToBig(s);
    if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn };
    return { v: 6, n };
  }
  return null;
}

/** Parse ``["10.0.0.0/8", "1.2.3.4,::1"]`` into network objects. Throws ``TypeError`` for junk. */
export function parseNetworks(items = []) {
  const out = [];
  for (const raw of [].concat(items || [])) {
    for (let item of String(raw).split(",")) {
      item = item.trim();
      if (!item) continue;
      const [a, len] = item.split("/");
      const ad = addr(a);
      const max = ad?.v === 6 ? 128 : 32;
      const bits = len === undefined ? max : Number(len);
      if (!ad || !/^\d*$/.test(len ?? "") || !Number.isInteger(bits) || bits < 0 || bits > max) throw new TypeError(`not an IP address or CIDR range: ${JSON.stringify(item)}`);
      out.push({ v: ad.v, bits, base: ad.n >> BigInt(max - bits), shift: BigInt(max - bits) });
    }
  }
  return out;
}

export function ipIn(ip, nets) {
  const a = addr(ip);
  return !!a && nets.some((n) => n.v === a.v && a.n >> n.shift === n.base);
}

const LOOP4 = parseNetworks(["127.0.0.0/8"]);
const LOCAL4 = parseNetworks(["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]);
const LOCAL6 = parseNetworks(["::1", "fc00::/7", "fe80::/10"]);
export const isLoopback = (ip) => { const a = addr(ip); return !!a && (a.v === 4 ? ipIn(ip, LOOP4) : a.n === 1n); };
export const isLocal = (ip) => ipIn(ip, LOCAL4) || ipIn(ip, LOCAL6);
/** Canonical text of an address (``::ffff:1.2.3.4`` -> ``1.2.3.4``), or ``""``. */
export function normIp(s) {
  const a = addr(s);
  if (!a) return "";
  if (a.v === 4) return [24n, 16n, 8n, 0n].map((sh) => String((a.n >> sh) & 255n)).join(".");
  return String(s).trim().split("%")[0].replace(/^\[|\]$/g, "").toLowerCase();
}

// ------------------------------------------------------------------------ rate limit
/** Token bucket: ``perMin`` sustained, ``burst`` at once. ``perMin <= 0`` disables it. */
export class RateLimiter {
  constructor(perMin, burst = null, maxKeys = 20000) {
    this.rate = Math.max(0, Number(perMin) || 0) / 60;
    this.burst = Number(burst ?? Math.max(3, Math.trunc(perMin / 4)));
    this.maxKeys = maxKeys;
    this.b = new Map(); // key -> [tokens, lastSeen]
  }

  get enabled() { return this.rate > 0; }

  /** ``[allowed, secondsUntilItWouldBe]`` */
  allow(key, cost = 1) {
    if (this.rate <= 0) return [true, 0];
    const t = mono();
    let [tokens, last] = this.b.get(key) ?? [this.burst, t];
    tokens = Math.min(this.burst, tokens + (t - last) * this.rate);
    let ok, wait;
    if (tokens >= cost) { this.b.set(key, [tokens - cost, t]); ok = true; wait = 0; }
    else { this.b.set(key, [tokens, t]); ok = false; wait = (cost - tokens) / this.rate; }
    if (this.b.size > this.maxKeys) this._gc(t);
    return [ok, wait];
  }

  _gc(t) {
    const idle = this.burst / this.rate;
    for (const [k, [, last]] of this.b) if (t - last >= idle) this.b.delete(k);
    if (this.b.size > this.maxKeys) { // still too many distinct clients: drop the oldest half
      const old = [...this.b].sort((x, y) => x[1][1] - y[1][1]).slice(0, Math.floor(this.b.size / 2));
      for (const [k] of old) this.b.delete(k);
    }
  }
}

/** ``after`` strikes within ``window`` seconds block an IP for ``duration`` seconds. */
export class BanList {
  constructor(after = 10, window = 600, duration = 900, maxEntries = 20000) {
    Object.assign(this, { after, window, duration, maxEntries });
    this.strikes = new Map();
    this.until = new Map();
  }

  get enabled() { return this.after > 0; }

  /** Seconds left on the ban (0 if none). */
  banned(ip) {
    if (!this.enabled) return 0;
    const left = (this.until.get(ip) ?? 0) - mono();
    if (left <= 0) { this.until.delete(ip); return 0; }
    return left;
  }

  /** Record a failure; true when this one triggered a ban. */
  strike(ip) {
    if (!this.enabled) return false;
    const t = mono();
    const s = (this.strikes.get(ip) ?? []).filter((x) => t - x < this.window);
    s.push(t);
    if (s.length >= this.after) { this.until.set(ip, t + this.duration); this.strikes.delete(ip); return true; }
    this.strikes.set(ip, s);
    if (this.strikes.size > this.maxEntries) for (const k of [...this.strikes.keys()].slice(0, Math.floor(this.strikes.size / 2))) this.strikes.delete(k);
    return false;
  }
}

// ----------------------------------------------------------------------------- antibot
export function leadingZeroBits(digest) {
  let n = 0;
  for (const b of digest) {
    if (b === 0) { n += 8; continue; }
    n += Math.clz32(b) - 24;
    break;
  }
  return n;
}

async function formPost(url, fields, timeout = 10) {
  const data = Buffer.from(new URLSearchParams(fields).toString());
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  return JSON.parse(await decodeBody(await openUrl(url, { headers, data, timeout })));
}

export class PermissionDenied extends Error {}

/**
 * Challenge -> proof -> session token, all stateless except a replay cache.
 * ``mode``: ``"pow"`` (SHA-256 leading-zero-bits puzzle, no account needed), ``"turnstile"`` (Cloudflare Turnstile
 * token, verified server-side) or ``"off"`` (sessions without a proof; rate limits still apply).
 */
export class Antibot {
  constructor(mode = "pow", { bits = 16, sessionTtl = 1800, challengeTtl = 120, bindIp = true, secret = null, turnstileSecret = null, turnstileSitekey = null, verifyUrl = TURNSTILE_URL, fetch = null } = {}) {
    if (!["pow", "turnstile", "off"].includes(mode)) throw new TypeError("antibot must be pow, turnstile or off");
    if (mode === "turnstile" && !(turnstileSecret && turnstileSitekey)) throw new TypeError("--antibot turnstile needs --turnstile-secret and --turnstile-sitekey");
    this.mode = mode;
    this.bits = Math.max(8, Math.min(Math.trunc(bits), 28));
    Object.assign(this, { sessionTtl, challengeTtl, bindIp, turnstileSecret, sitekey: turnstileSitekey, verifyUrl });
    this._fetch = fetch || formPost;
    this.secret = secret ? Buffer.from(secret) : crypto.randomBytes(32);
    this.used = new Map();
    this.issued = new Map();
  }

  _mac(...parts) { return crypto.createHmac("sha256", this.secret).update(parts.join("|")).digest("hex").slice(0, 32); }
  _iph(ip) { return this.bindIp ? sha256(ip).toString("hex").slice(0, 12) : "-"; }
  config() { return { antibot: this.mode, turnstile_sitekey: this.mode === "turnstile" ? this.sitekey : null }; }

  /** Base bits, +1 per 4 challenges the same IP asked for in the last 5 minutes (max +6). */
  difficulty(ip) {
    const t = mono();
    const recent = (this.issued.get(ip) ?? []).filter((x) => t - x < 300);
    recent.push(t);
    this.issued.set(ip, recent);
    if (this.issued.size > 10000) for (const k of [...this.issued.keys()].slice(0, 5000)) this.issued.delete(k);
    return this.bits + Math.min(6, Math.floor((recent.length - 1) / 4));
  }

  challenge(ip) {
    if (this.mode !== "pow") throw new TypeError("proof of work is not enabled");
    const ts = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(8).toString("hex"), bits = this.difficulty(ip);
    const mac = this._mac("c", ts, nonce, bits, this._iph(ip));
    return { challenge: `v1.${ts}.${nonce}.${bits}.${mac}`, bits, expires_in: Math.trunc(this.challengeTtl) };
  }

  _eq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

  _checkPow(ip, challenge, counter) {
    const parts = String(challenge).split(".");
    if (parts.length !== 5) throw new PermissionDenied("malformed proof");
    const [ver, tsS, nonce, bitsS, mac] = parts;
    const ts = Number(tsS), bits = Number(bitsS), n = Number(counter);
    if (![ts, bits, n].every(Number.isInteger)) throw new PermissionDenied("malformed proof");
    if (ver !== "v1" || n < 0 || !this._eq(mac, this._mac("c", ts, nonce, bits, this._iph(ip)))) throw new PermissionDenied("invalid challenge");
    const now = Date.now() / 1000;
    if (now - ts > this.challengeTtl || ts > now + 5) throw new PermissionDenied("challenge expired");
    if (leadingZeroBits(sha256(`${challenge}:${n}`)) < bits) throw new PermissionDenied("proof of work not solved");
    const t = mono();
    if (this.used.has(nonce)) throw new PermissionDenied("challenge already used");
    this.used.set(nonce, t + this.challengeTtl);
    if (this.used.size > 5000) for (const [k, v] of this.used) if (v < t) this.used.delete(k);
  }

  async _checkTurnstile(ip, token) {
    if (typeof token !== "string" || !token) throw new PermissionDenied("missing turnstile token");
    let out;
    try { out = await this._fetch(this.verifyUrl, { secret: this.turnstileSecret || "", response: token, remoteip: ip }); }
    catch { throw new PermissionDenied("could not verify turnstile token"); } // network trouble must never let a visitor through
    if (!(out && typeof out === "object" && out.success === true)) throw new PermissionDenied("turnstile rejected the token");
  }

  /** Verify the proof in ``payload`` and mint a session token (rejects with :class:`PermissionDenied`). */
  async session(ip, payload = {}) {
    if (this.mode === "pow") this._checkPow(ip, String(payload.challenge ?? ""), payload.counter);
    else if (this.mode === "turnstile") await this._checkTurnstile(ip, payload.turnstile);
    const exp = Math.floor(Date.now() / 1000 + this.sessionTtl);
    return { token: `${SESSION_PREFIX}${exp}.${this._mac("s", exp, this._iph(ip))}`, expires_in: Math.trunc(this.sessionTtl) };
  }

  validToken(token, ip) {
    if (!String(token).startsWith(SESSION_PREFIX)) return false;
    const [expS, mac] = String(token).slice(SESSION_PREFIX.length).split(".", 2);
    const exp = Number(expS);
    return Number.isInteger(exp) && !!mac && exp > Date.now() / 1000 && this._eq(mac, this._mac("s", exp, this._iph(ip)));
  }
}

/** Test / helper: solve a proof-of-work challenge the way the browser does. */
export function solvePow(challenge) {
  const bits = Number(challenge.split(".")[3]);
  for (let n = 0; ; n++) if (leadingZeroBits(sha256(`${challenge}:${n}`)) >= bits) return n;
}
