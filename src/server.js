import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { timingSafeEqual as sec_timingSafeEqual } from "node:crypto";
import { AllProvidersFailed, LLMFError, ModelNotFound } from "./errors.js";
import * as sec from "./security.js";
import { ChatCompletion, ChatCompletionChunk } from "./types.js";
import { randomHex } from "./util.js";
import { AppProcess, StaticSite, asset, contentType, proxyRequest } from "./web.js";
import { Tunnel, TunnelError } from "./tunnel.js";

const MAX_BODY = 20 * 1024 * 1024;
const APP_MAX_BODY = 25 * 1024 * 1024;
const ALIASES = ["auto", "fast", "best", "code", "vision", "reasoning"];
const PARAMS = ["max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "tools", "response_format"];
const LOOPBACK = /^(localhost|127(\.\d+){3}|::1)$/i;

export class ConfigError extends TypeError {}

const DEFAULTS = {
  apiKey: null, cors: false, corsOrigins: [], strictModels: false, fallback: true,
  maxConcurrent: null, rate: null, ipRate: null, sessionRate: 12, allowIp: [], denyIp: [],
  trustProxy: false, maxBody: null, maxTokensCap: null, sessionMaxTokens: 1024, logFile: null,
  banAfter: null, antibot: null, powBits: 16, turnstileSecret: null, turnstileSitekey: null,
  ui: false, web: null, appPort: null, csp: null, tlsCert: null, tlsKey: null, public: false,
  socketTimeout: null, maxConnections: null, secret: null, fetch: null, sessionTtl: 1800, bindHost: null,
};
const LOCAL = { maxConcurrent: 48, rate: 0, ipRate: 0, maxBody: MAX_BODY, maxTokensCap: 0, banAfter: 0, socketTimeout: 60 };
const PUBLIC = { maxConcurrent: 32, rate: 120, ipRate: 240, maxBody: 1024 * 1024, maxTokensCap: 4096, banAfter: 10, socketTimeout: 30 };

const err = (message, type, code = null) => ({ error: { message, type, code } });
const flag = (k) => "--" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

function callOptions(body) {
  const o = {};
  if (body.max_tokens != null) o.maxTokens = body.max_tokens;
  else if (body.max_completion_tokens != null) o.maxTokens = body.max_completion_tokens;
  if (body.temperature != null) o.temperature = body.temperature;
  if (body.top_p != null) o.topP = body.top_p;
  if (body.stop != null) o.stop = body.stop;
  if (body.tools != null) o.tools = body.tools;
  if (body.response_format?.type === "json_object" || body.response_format?.type === "json_schema") o.json = true;
  return o;
}

function resolveConfig(client, opts) {
  const unknown = Object.keys(opts).filter((k) => !(k in DEFAULTS));
  if (unknown.length) throw new ConfigError(`unknown server option(s): ${unknown.sort().join(", ")}`);
  const o = { ...DEFAULTS };
  for (const [k, v] of Object.entries(opts)) if (v !== undefined) o[k] = v;
  for (const [k, v] of Object.entries(o.public ? PUBLIC : LOCAL)) if (o[k] === null) o[k] = v;
  if (o.tlsKey && !o.tlsCert) throw new ConfigError("--tls-key needs --tls-cert");
  const bad = (k, why) => { throw new ConfigError(`${flag(k)} must be ${why}`); };
  if (!Number.isInteger(o.powBits) || o.powBits < 8 || o.powBits > 28) throw new ConfigError("--pow-bits must be between 8 and 28 (higher is too slow for phones)");
  if (!Number.isInteger(o.maxConcurrent) || o.maxConcurrent < 0) bad("maxConcurrent", "an integer >= 0 (0 = unlimited)");
  for (const k of ["maxBody", "socketTimeout"]) if (!(Number(o[k]) >= 0)) bad(k, "not negative");
  if (Number(o.maxBody) === 0) throw new ConfigError("--max-body must be at least 1");
  for (const k of ["rate", "ipRate", "sessionRate", "maxTokensCap", "sessionMaxTokens", "maxConnections"]) if (o[k] !== null && !(Number(o[k]) >= 0)) bad(k, "not negative");
  if (o.appPort !== null && !(Number.isInteger(o.appPort) && o.appPort >= 0 && o.appPort <= 65535)) throw new ConfigError("--app-port must be between 0 and 65535");

  const cfg = { client, public: !!o.public, generatedKey: null, apiKeys: [], loopbackOnly: false, hosts: new Set(), ...o };
  cfg.apiKeys = (typeof o.apiKey === "string" ? [o.apiKey] : [...(o.apiKey || [])]).filter(Boolean);
  if (cfg.public && !cfg.apiKeys.length) { cfg.generatedKey = sec.newApiKey(); cfg.apiKeys.push(cfg.generatedKey); }
  cfg.kid = new Map(cfg.apiKeys.map((k) => [k, sec.keyId(k)]));
  cfg.requireAuth = cfg.apiKeys.length > 0 || cfg.public;
  cfg.cors = !!o.cors;
  cfg.corsOrigins = (o.corsOrigins || []).map((x) => String(x).replace(/\/+$/, ""));
  try { cfg.allow = sec.parseNetworks(o.allowIp); cfg.deny = sec.parseNetworks(o.denyIp); } catch (e) { throw new ConfigError(e.message); }
  cfg.ipLimiter = new sec.RateLimiter(Number(o.ipRate), Math.max(10, Number(o.ipRate) / 4));
  cfg.keyLimiter = new sec.RateLimiter(Number(o.rate), Math.max(5, Number(o.rate) / 4));
  cfg.sessionLimiter = new sec.RateLimiter(Number(o.sessionRate), Math.max(3, Number(o.sessionRate) / 3));
  cfg.challengeLimiter = new sec.RateLimiter(cfg.public ? 30 : 0, 10);
  cfg.bans = new sec.BanList(Number(o.banAfter));
  cfg.static = o.web ? new StaticSite(o.web) : null;
  cfg.tls = !!o.tlsCert;
  cfg.sessions = !!(cfg.ui || cfg.static || cfg.appPort !== null || o.antibot);
  cfg.antibot = null;
  if (cfg.sessions) {
    try {
      cfg.antibot = new sec.Antibot(o.antibot || (cfg.public ? "pow" : "off"), { bits: o.powBits, sessionTtl: o.sessionTtl, secret: o.secret, turnstileSecret: o.turnstileSecret, turnstileSitekey: o.turnstileSitekey, fetch: o.fetch });
    } catch (e) { throw new ConfigError(e.message); }
  }
  cfg.logFd = null;
  if (o.logFile) {
    if (o.logFile === "-") cfg.logFd = 2;
    else { try { cfg.logFd = fs.openSync(o.logFile, "a", 0o600); } catch (e) { throw new ConfigError(`cannot open the log file ${o.logFile}: ${e.message}`); } }
  }
  cfg.log = (entry) => {
    if (cfg.logFd === null) return;
    try { fs.writeSync(cfg.logFd, JSON.stringify({ ...entry, t: new Date().toISOString() }) + "\n"); } catch {   }
  };
  cfg.close = () => { if (cfg.logFd !== null && cfg.logFd > 2) { try { fs.closeSync(cfg.logFd); } catch {   } cfg.logFd = null; } };
  return cfg;
}

export function createServer(client, opts = {}) {
  const cfg = resolveConfig(client, opts);
  const bindHost = cfg.bindHost;
  cfg.loopbackOnly = !cfg.public && !cfg.trustProxy && !!bindHost && LOOPBACK.test(bindHost);
  cfg.hosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1", String(bindHost || "").toLowerCase()]);
  let active = 0;

  const send = (res, code, obj, extra = {}) => {
    const data = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": data.length, "Cache-Control": "no-store", ...extra });
    res.end(res.req?.method === "HEAD" ? undefined : data);
  };
  const limited = (res, wait, message, code = "rate_limited") => send(res, 429, err(message, "rate_limit_error", code), { "Retry-After": String(Math.max(1, Math.ceil(wait))) });
  const bytes = (res, data, ctype, extra = {}) => {
    res.writeHead(200, { "Content-Type": ctype, "Content-Length": data.length, "Cache-Control": "no-cache", ...extra });
    res.end(res.req?.method === "HEAD" ? undefined : data);
  };

  function applyHeaders(req, res, proxied = false) {
    const origin = String(req.headers.origin || "").replace(/\/+$/, "");
    if (cfg.cors) res.setHeader("Access-Control-Allow-Origin", "*");
    else if (origin && cfg.corsOrigins.includes(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
    if (res.hasHeader("Access-Control-Allow-Origin")) {
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (!proxied) {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      if (cfg.tls) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    }
    if (cfg.csp) res.setHeader("Content-Security-Policy", cfg.csp);
  }

  const peerIp = (req) => sec.normIp(req.socket.remoteAddress || "") || req.socket.remoteAddress || "?";
  function clientIp(req) {
    const peer = peerIp(req);
    if (cfg.trustProxy && sec.isLoopback(peer)) {
      const cf = sec.normIp(String(req.headers["cf-connecting-ip"] || ""));
      if (cf) return cf;
      const xff = String(req.headers["x-forwarded-for"] || "");
      if (xff) { const last = sec.normIp(xff.split(",").at(-1)); if (last) return last; }
    }
    return peer;
  }
  function scheme(req) {
    if (cfg.trustProxy && sec.isLoopback(peerIp(req))) {
      const fp = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
      if (fp === "http" || fp === "https") return fp;
    }
    return cfg.tls ? "https" : "http";
  }
  const bearer = (req) => { const h = String(req.headers.authorization || ""); return h.slice(0, 7).toLowerCase() === "bearer " ? h.slice(7).trim() : ""; };
  const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && sec_timingSafeEqual(x, y); };
  const isCredential = (header) => {
    const tok = header.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7).trim() : "";
    return !!tok && (tok.startsWith(sec.SESSION_PREFIX) || cfg.apiKeys.some((k) => eq(tok, k)));
  };
  function principal(req, ip) {
    const tok = bearer(req);
    if (tok) {
      let found = null;
      for (const k of cfg.apiKeys) if (eq(tok, k)) found = k;
      if (found !== null) return ["key", cfg.kid.get(found)];
      if (cfg.antibot && cfg.antibot.validToken(tok, ip)) return ["session", ip];
    }
    return cfg.requireAuth ? null : ["anon", ip];
  }
  function denyAuth(res, ip) {
    const banned = cfg.bans.strike(ip);
    send(res, 401, err("invalid or missing credentials", "invalid_request_error", "invalid_api_key"), { "WWW-Authenticate": 'Bearer realm="llmf"' });
    if (banned) cfg.log({ event: "ban", ip });
  }

  function guard(req, res) {
    const hostRaw = String(req.headers.host || "").toLowerCase();
    if (cfg.loopbackOnly && hostRaw) {
      const name = hostRaw.endsWith("]") ? hostRaw : hostRaw.replace(/:\d*$/, "");
      if (!cfg.hosts.has(name)) { send(res, 403, err("forbidden host", "invalid_request_error", "forbidden")); return false; }
    }
    const origin = String(req.headers.origin || "").replace(/\/+$/, "").toLowerCase();
    if (origin && !cfg.cors && !cfg.corsOrigins.some((o) => o.toLowerCase() === origin)) {
      if (origin.split("://").at(-1) !== hostRaw) { send(res, 403, err("cross-origin request not allowed", "invalid_request_error", "forbidden")); return false; }
    }
    return true;
  }

  function readBody(req, res, limit) {
    return new Promise((resolve) => {
      if (/chunked/i.test(String(req.headers["transfer-encoding"] || ""))) { send(res, 411, err("Content-Length required", "invalid_request_error")); return resolve(null); }
      const raw = req.headers["content-length"];
      const n = raw === undefined || raw === "" ? NaN : Number(raw);
      if (!Number.isFinite(n) || n < 0) { send(res, 411, err("Content-Length required", "invalid_request_error")); return resolve(null); }
      if (n > limit) { send(res, 413, err("request too large", "invalid_request_error")); return resolve(null); }
      const chunks = [];
      let got = 0;
      req.on("data", (c) => { got += c.length; if (got <= n) chunks.push(c); });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", () => resolve(null));
    });
  }
  async function readJson(req, res, limit) {
    const buf = await readBody(req, res, limit);
    if (buf === null) return null;
    try {
      const body = JSON.parse(buf.toString() || "{}");
      if (body === null || typeof body !== "object" || Array.isArray(body)) throw new TypeError("JSON object expected");
      return body;
    } catch (e) { send(res, 400, err(`bad request: ${e.message}`, "invalid_request_error")); return null; }
  }

  async function internal(req, res, path, ip) {
    const ro = req.method === "GET" || req.method === "HEAD";
    if ((path === "/_llmf/client.js" || path === "/_llmf/ui.js") && ro && cfg.sessions) return bytes(res, asset(path.split("/").pop()), "text/javascript; charset=utf-8");
    if (!cfg.sessions || !cfg.antibot) return send(res, 404, err("not found", "invalid_request_error", "not_found"));
    const ab = cfg.antibot;
    if (path === "/_llmf/config" && ro) return send(res, 200, { ...ab.config(), session: true });
    if (path === "/_llmf/challenge" && ro) {
      const [ok, wait] = cfg.challengeLimiter.allow("c:" + ip);
      if (!ok) return limited(res, wait, "too many challenges");
      try { return send(res, 200, ab.challenge(ip)); } catch (e) { return send(res, 400, err(e.message, "invalid_request_error")); }
    }
    if (path === "/_llmf/session" && req.method === "POST") {
      const [ok, wait] = cfg.challengeLimiter.allow("c:" + ip);
      if (!ok) return limited(res, wait, "too many session requests");
      const body = await readJson(req, res, 4096);
      if (body === null) return undefined;
      try {
        const out = await ab.session(ip, body);
        res.llmfWho = "session-new";
        return send(res, 200, out);
      } catch (e) {
        if (!(e instanceof sec.PermissionDenied)) throw e;
        cfg.bans.strike(ip);
        return send(res, 403, err(e.message, "invalid_request_error", "antibot_failed"));
      }
    }
    return send(res, 404, err("not found", "invalid_request_error", "not_found"));
  }

  const pickModel = (requested) => {
    if (typeof requested !== "string" || ["", "auto", "default"].includes(requested.trim().toLowerCase())) return null;
    try { client._reg.resolve(requested); return requested; } catch (e) {
      if (e instanceof ModelNotFound) { if (cfg.strictModels) throw e; return null; }
      throw e;
    }
  };

  function validate(body, kind) {
    const msgs = body.messages;
    if (!Array.isArray(msgs) || !msgs.length) return "bad request: messages must be a non-empty list";
    const limitMsgs = { session: 40, key: 200 }[kind] ?? 1000;
    if (msgs.length > limitMsgs) return `too many messages (max ${limitMsgs})`;
    let chars = 0;
    for (const m of msgs) {
      if (m === null || typeof m !== "object" || typeof m.role !== "string") return "bad request: every message needs a role";
      const c = m.content;
      if (typeof c === "string") chars += c.length;
      else if (Array.isArray(c)) {
        for (const part of c) {
          if (part === null || typeof part !== "object") return "bad request: malformed content part";
          if (part.type === "text") chars += String(part.text ?? "").length;
          else if (kind === "session") return "images are not allowed for web sessions";
        }
      } else if (c !== null && c !== undefined) return "bad request: content must be a string or a list";
    }
    if (kind === "session") {
      if (chars > 24000) return "conversation too long for a web session (max 24000 characters)";
      delete body.tools;
    }
    const cap = kind === "session" ? Number(cfg.sessionMaxTokens) : Number(cfg.maxTokensCap);
    if (cap > 0) {
      for (const key of ["max_tokens", "max_completion_tokens"]) {
        let v = body[key];
        if (v === undefined || v === null) continue;
        v = Number(v);
        if (!Number.isFinite(v)) return "max_tokens must be an integer";
        delete body[key];
        body.max_tokens = Math.min(Math.trunc(v), cap);
      }
    }
    return null;
  }

  async function api(req, res, route, ip) {
    const ro = req.method === "GET" || req.method === "HEAD";
    if (route === "/models" && ro) {
      const who = principal(req, ip);
      if (!who) return denyAuth(res, ip);
      res.llmfWho = `${who[0]}:${who[0] === "key" ? who[1] : ""}`;
      if (who[0] === "key") { const [ok, wait] = cfg.keyLimiter.allow("k:" + who[1]); if (!ok) return limited(res, wait, "rate limit reached, retry shortly"); }
      const now = Math.floor(Date.now() / 1000);
      const ids = [...ALIASES, ...(await client.models.list()).map((m) => m.name)];
      return send(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", created: now, owned_by: "llmf" })) });
    }
    if (route !== "/chat/completions" || req.method !== "POST") return send(res, 404, err(`not found: ${req.url.split("?")[0]}`, "invalid_request_error", "not_found"));
    const who = principal(req, ip);
    if (!who) return denyAuth(res, ip);
    const kind = who[0];
    res.llmfWho = `${kind}:${kind === "key" ? who[1] : ""}`;
    let ok = true, wait = 0;
    if (kind === "key") [ok, wait] = cfg.keyLimiter.allow("k:" + who[1]);
    else if (kind === "session") [ok, wait] = cfg.sessionLimiter.allow("s:" + ip);
    if (!ok) return limited(res, wait, "rate limit reached, retry shortly");
    const body = await readJson(req, res, Number(cfg.maxBody));
    if (body === null) return undefined;
    const bad = validate(body, kind);
    if (bad) return send(res, 400, err(bad, "invalid_request_error"));
    if (cfg.maxConcurrent && active >= cfg.maxConcurrent) return limited(res, 1, "server is busy, retry shortly", "busy");
    active++;
    try { await chat(req, res, body); } finally { active--; }
    return undefined;
  }

  const upstreamMsg = (e) => (cfg.public ? "all upstream providers failed" : e.message);

  async function chat(req, res, body) {
    let model;
    try { model = pickModel(body.model); } catch (e) { return send(res, 404, err(e.message, "invalid_request_error", "model_not_found")); }
    const o = { ...callOptions(body), model, fallback: cfg.fallback ? true : null };
    try {
      if (body.stream) return await streamOut(req, res, client.stream(body.messages, o));
      const reply = await client.chat(body.messages, o);
      res.llmfModel = `${reply.provider}/${reply.model}`;
      return send(res, 200, ChatCompletion.fromReply(reply));
    } catch (e) {
      if (e instanceof AllProvidersFailed) return send(res, 502, err(upstreamMsg(e), "upstream_error", "all_providers_failed"));
      if (e instanceof LLMFError || e instanceof TypeError) return send(res, 400, err(e.message, "invalid_request_error"));
      throw e;
    }
  }

  async function streamOut(req, res, st) {
    const it = st[Symbol.asyncIterator]();
    let closed = false;
    res.once("close", () => { closed = true; it.return?.().catch?.(() => {}); });
    const first = await it.next();
    const id = "chatcmpl-" + randomHex(12), created = Math.floor(Date.now() / 1000), model = `${st.provider}/${st.model}`;
    res.llmfModel = model;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    const out = (obj) => { if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    out(new ChatCompletionChunk(id, created, model, { role: "assistant", content: "" }));
    if (!first.done) out(new ChatCompletionChunk(id, created, model, { content: first.value }));
    try {
      for (let r = first.done ? first : await it.next(); !r.done && !closed; r = await it.next()) out(new ChatCompletionChunk(id, created, model, { content: r.value }));
      out(new ChatCompletionChunk(id, created, model, {}, "stop"));
    } catch (e) {
      if (!(e instanceof LLMFError)) throw e;
      out(err(cfg.public ? "upstream error" : e.message, "upstream_error"));
    }
    if (!closed) { res.write("data: [DONE]\n\n"); res.end(); }
  }

  function uiCsp() {
    const ts = cfg.antibot?.mode === "turnstile";
    const cf = " https://challenges.cloudflare.com";
    return `default-src 'self'; script-src 'self'${ts ? cf : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src${ts ? cf : " 'none'"}; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`;
  }

  async function site(req, res, path, ip) {
    const p = path.replace(/\/+$/, "") || "/";
    const ro = req.method === "GET" || req.method === "HEAD";
    const showUi = cfg.ui && (p === "/chat" || ((p === "/" || p === "/index.html") && !cfg.static && cfg.appPort === null));
    if (showUi && ro) return bytes(res, asset("chat.html"), "text/html; charset=utf-8", { "Content-Security-Policy": uiCsp() });
    if (cfg.appPort !== null) {
      let body = null;
      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) || req.headers["content-length"]) {
        body = await readBody(req, res, APP_MAX_BODY);
        if (body === null) return undefined;
      }
      for (const h of ["X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Permissions-Policy", "Strict-Transport-Security"]) res.removeHeader(h);
      res.llmfWho = "app";
      await proxyRequest(req, res, cfg.appPort, { body, clientIp: ip, scheme: scheme(req), dropAuth: isCredential, fail: (code, msg, type) => send(res, code, err(msg, type)) });
      return undefined;
    }
    if (cfg.static) {
      if (!ro) return send(res, 405, err("method not allowed", "invalid_request_error"), { Allow: "GET, HEAD" });
      const f = cfg.static.find(path);
      if (!f) return send(res, 404, err("not found", "invalid_request_error", "not_found"));
      let st;
      try { st = fs.statSync(f); } catch { return send(res, 404, err("not found", "invalid_request_error", "not_found")); }
      res.writeHead(200, { "Content-Type": contentType(f), "Content-Length": st.size, "Cache-Control": "no-cache" });
      if (req.method === "HEAD") return res.end();
      const rs = fs.createReadStream(f);
      rs.on("error", () => res.destroy());
      rs.pipe(res);
      return new Promise((resolve) => res.once("close", resolve));
    }
    return send(res, 404, err("not found", "invalid_request_error", "not_found"));
  }

  async function dispatch(req, res, ip) {
    if ((cfg.deny.length && sec.ipIn(ip, cfg.deny)) || (cfg.allow.length && !sec.ipIn(ip, cfg.allow))) return send(res, 403, err("forbidden", "invalid_request_error", "forbidden"));
    const left = cfg.bans.banned(ip);
    if (left) return limited(res, left, "temporarily blocked", "blocked");
    const [ok, wait] = cfg.ipLimiter.allow("ip:" + ip);
    if (!ok) return limited(res, wait, "too many requests");
    const path = new URL(req.url, "http://x").pathname || "/";
    if (req.method === "OPTIONS") {
      const origin = String(req.headers.origin || "").replace(/\/+$/, "");
      const allowed = cfg.cors || (origin && (cfg.corsOrigins.includes(origin) || (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })()));
      res.writeHead(allowed ? 204 : 405, { "Content-Length": 0 });
      return res.end();
    }
    const webOnly = path !== "/health" && !path.startsWith("/_llmf/") && path !== "/v1" && !path.startsWith("/v1/");
    const hasSite = !!(cfg.static || cfg.appPort !== null || cfg.ui);
    if (path === "/health") return send(res, 200, { status: "ok", service: "llmf" });
    if (!(webOnly && hasSite) && !guard(req, res)) return undefined;
    if (path === "/health") return send(res, 200, { status: "ok", service: "llmf" });
    if (path.startsWith("/_llmf/")) return internal(req, res, path, ip);
    if (path === "/v1" || path.startsWith("/v1/")) return api(req, res, path.slice(3).replace(/\/+$/, ""), ip);
    if (!hasSite) {
      if (path === "/" || path === "") return send(res, 200, { status: "ok", service: "llmf" });
      const legacy = path.replace(/\/+$/, "");
      if (legacy === "/models" || legacy === "/chat/completions") return api(req, res, legacy, ip);
      return send(res, 404, err(`not found: ${path}`, "invalid_request_error", "not_found"));
    }
    return site(req, res, path, ip);
  }

  const handler = async (req, res) => {
    const t0 = Date.now();
    res.req = req;
    let ip = "?";
    res.once("close", () => cfg.log({ ip, m: req.method, path: String(req.url).split("?")[0].slice(0, 200), status: res.statusCode, ms: Date.now() - t0, who: res.llmfWho || "-", model: res.llmfModel ?? null }));
    try {
      ip = clientIp(req);
      applyHeaders(req, res);
      if (!["GET", "HEAD", "POST", "OPTIONS"].includes(req.method)) return send(res, 405, err("method not allowed", "invalid_request_error", "method_not_allowed"), { Allow: "GET, HEAD, POST, OPTIONS" });
      await dispatch(req, res, ip);
    } catch (e) {
      cfg.log({ event: "error", ip, error: `${e?.name}: ${e?.message}` });
      if (!res.headersSent) send(res, 500, err("internal error", "server_error"));
      else res.destroy();
    }
  };

  let server;
  if (cfg.tlsCert) {
    let cert, key;
    try { cert = fs.readFileSync(cfg.tlsCert); key = fs.readFileSync(cfg.tlsKey || cfg.tlsCert); } catch (e) { throw new ConfigError(`cannot load the TLS certificate/key (${cfg.tlsCert}): ${e.message}`); }
    try { server = https.createServer({ cert, key, minVersion: "TLSv1.2" }, handler); } catch (e) { throw new ConfigError(`cannot load the TLS certificate/key (${cfg.tlsCert}): ${e.message}`); }
    server.on("tlsClientError", () => {});
  } else server = http.createServer(handler);
  const rawError = (status, text, code) => {
    const body = JSON.stringify(err(text, "invalid_request_error", code));
    return `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  };

  server.on("clientError", (e, sock) => {
    if (!sock.writable) return sock.destroy();
    const big = e?.code === "HPE_HEADER_OVERFLOW";
    try { sock.end(rawError(big ? "431 Request Header Fields Too Large" : "400 Bad Request", big ? "request headers too large" : "Bad Request", big ? "headers_too_large" : "bad_request")); } catch { sock.destroy(); }
  });
  server.on("connect", (req, sock) => { try { sock.end(rawError("405 Method Not Allowed", "method not allowed", "method_not_allowed")); } catch { sock.destroy(); } });
  server.maxHeadersCount = 100;
  server.llmf = cfg;
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 30000;
  server.requestTimeout = 60000;
  if (cfg.public) server.maxConnections = Number(cfg.maxConnections || 256);
  else if (cfg.maxConnections) server.maxConnections = Number(cfg.maxConnections);
  return server;
}

export function serve(client, { host, port = 8000, cloudflare = false, tunnelToken = null, app = null, appDir = null, log = (s) => console.error(s), ...opts } = {}) {
  const tunnelled = !!(cloudflare || tunnelToken);
  if (tunnelled) { opts.public = true; opts.trustProxy = true; }
  if (app && !opts.appPort) opts.appPort = 3000;
  if (!Number.isInteger(Number(port)) || port < 0 || port > 65535) throw new ConfigError("--port must be between 0 and 65535");
  const bind = host ?? (opts.public && !tunnelled ? "0.0.0.0" : "127.0.0.1");
  const server = createServer(client, { bindHost: bind, ...opts });
  const cfg = server.llmf;
  return (async () => {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ host: bind, port, backlog: 128 }, resolve); });
    server.removeAllListeners("error");
    server.on("error", () => {});
    let child = null, tunnel = null;
    const shutdown = () => { tunnel?.stop(); child?.stop(); cfg.close(); };
    server.once("close", shutdown);
    try {
      const p = server.address().port;
      if (app) {
        const key = cfg.apiKeys[0] || "llmf-local";
        const base = `${cfg.tls ? "https" : "http"}://127.0.0.1:${p}/v1`;
        child = new AppProcess(app, Number(cfg.appPort), { cwd: appDir, log, env: { LLMF_BASE_URL: base, OPENAI_BASE_URL: base, OPENAI_API_KEY: key, LLMF_API_KEY: key } });
        await child.start();
      }
      if (tunnelled) {
        tunnel = new Tunnel(p, { token: tunnelToken, scheme: cfg.tls ? "https" : "http" });
        cfg.publicUrl = await tunnel.start();
      }
    } catch (e) {
      server.close();
      shutdown();
      if (e instanceof TunnelError || e instanceof Error) throw Object.assign(new Error(e.message), { code: "ELLMF" });
      throw e;
    }
    cfg.tunnelled = tunnelled;
    return server;
  })();
}

export { PARAMS };
