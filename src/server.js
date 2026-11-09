// ``llmf serve``: local OpenAI-compatible server (node:http only).
//
// Point any OpenAI client at ``http://127.0.0.1:8000/v1`` and it uses the free endpoints, with fallback.
// Local by default: 127.0.0.1, no CORS, optional bearer key.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { AllProvidersFailed, LLMFError, ModelNotFound } from "./errors.js";
import { ChatCompletion, ChatCompletionChunk } from "./types.js";
import { randomHex } from "./util.js";

const LOOPBACK = /^(localhost|127(\.\d+){3}|::1)$/i;
const hostOf = (h) => { try { return new URL("http://" + h).hostname.replace(/^\[|\]$/g, ""); } catch { return null; } };

const MAX_BODY = 20 * 1024 * 1024; // base64 images can be large
const ALIASES = ["auto", "fast", "best", "code", "vision", "reasoning"];
const PARAMS = ["max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "tools", "response_format"];

const err = (message, type, code = null) => ({ error: { message, type, code } });

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Map OpenAI request fields onto llmf call options. */
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

export function createServer(client, { apiKey = null, cors = false, strictModels = false, fallback = true, maxConcurrent = 48, corsOrigins = [], bindHost = null } = {}) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 0) throw new TypeError("maxConcurrent must be an integer >= 0 (0 = unlimited)");
  let active = 0; // chat requests being served right now
  const keys = typeof apiKey === "string" ? [apiKey] : (apiKey || []).filter(Boolean);

  const send = (res, code, obj, extra = {}) => {
    const data = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": data.length, "Cache-Control": "no-store", ...extra });
    res.end(data);
  };

  const readJson = (req, res) => new Promise((resolve) => {
    const n = Number(req.headers["content-length"]);
    if (!Number.isFinite(n) || n < 0) { send(res, 411, err("Content-Length required", "invalid_request_error")); return resolve(null); }
    if (n > MAX_BODY) { send(res, 413, err("request too large", "invalid_request_error")); return resolve(null); }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        if (body === null || typeof body !== "object" || Array.isArray(body)) throw new TypeError("JSON object expected");
        resolve(body);
      } catch (e) { send(res, 400, err(`bad request: ${e.message}`, "invalid_request_error")); resolve(null); }
    });
  });

  const authed = (req) => {
    if (!keys.length) return true;
    const h = req.headers.authorization || "";
    const tok = h.slice(0, 7).toLowerCase() === "bearer " ? h.slice(7).trim() : "";
    return keys.reduce((ok, k) => safeEqual(tok, k) || ok, false);
  };

  const pickModel = (requested) => {
    if (typeof requested !== "string" || ["", "auto", "default"].includes(requested.trim().toLowerCase())) return null;
    try { client._reg.resolve(requested); return requested; } catch (e) {
      if (e instanceof ModelNotFound) { if (strictModels) throw e; return null; } // unknown name from a client app (e.g. "gpt-4o") -> automatic
      throw e;
    }
  };

  async function chat(req, res, body) {
    const msgs = body.messages;
    if (!Array.isArray(msgs) || !msgs.length) return send(res, 400, err("bad request: messages must be a non-empty list", "invalid_request_error"));
    let model;
    try { model = pickModel(body.model); } catch (e) { return send(res, 404, err(e.message, "invalid_request_error", "model_not_found")); }
    const o = { ...callOptions(body), model, fallback: fallback ? true : null };
    try {
      if (body.stream) return await streamOut(res, client.stream(msgs, o), model);
      const reply = await client.chat(msgs, o);
      return send(res, 200, ChatCompletion.fromReply(reply));
    } catch (e) {
      if (e instanceof AllProvidersFailed) return send(res, 502, err(e.message, "upstream_error", "all_providers_failed"));
      if (e instanceof LLMFError || e instanceof TypeError) return send(res, 400, err(e.message, "invalid_request_error"));
      throw e;
    }
  }

  async function streamOut(res, st) {
    const it = st[Symbol.asyncIterator]();
    const first = await it.next(); // fallback between providers happens here, before any bytes
    const id = "chatcmpl-" + randomHex(12), created = Math.floor(Date.now() / 1000), model = `${st.provider}/${st.model}`;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    const out = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    out(new ChatCompletionChunk(id, created, model, { role: "assistant", content: "" }));
    if (!first.done) out(new ChatCompletionChunk(id, created, model, { content: first.value }));
    try {
      for (let r = first.done ? first : await it.next(); !r.done; r = await it.next()) out(new ChatCompletionChunk(id, created, model, { content: r.value }));
      out(new ChatCompletionChunk(id, created, model, {}, "stop"));
    } catch (e) {
      if (!(e instanceof LLMFError)) throw e;
      out(err(e.message, "upstream_error"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  }

  return http.createServer(async (req, res) => {
    try {
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (cors) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      }
      // Local server vs. web pages: refuse DNS rebinding (foreign Host on a loopback-bound server) and cross-site requests.
      const hostHdr = hostOf(req.headers.host || "");
      if (bindHost && LOOPBACK.test(bindHost) && !(hostHdr && LOOPBACK.test(hostHdr))) return send(res, 421, err("unexpected Host header", "invalid_request_error", "bad_host"));
      const origin = req.headers.origin;
      if (origin !== undefined) {
        const allowed = cors || corsOrigins.includes(origin) || (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
        if (!allowed) return send(res, 403, err("cross-site request refused (use --cors / --cors-origin to allow it)", "invalid_request_error", "bad_origin"));
        if (!cors) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); res.setHeader("Access-Control-Allow-Headers", "authorization, content-type"); res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); }
      }
      const path = new URL(req.url, "http://x").pathname.replace(/\/+$/, "") || "/";
      if (req.method === "OPTIONS") { res.writeHead(cors || origin !== undefined ? 204 : 405); return res.end(); }
      if (path === "/health" || path === "/") return send(res, 200, { status: "ok", service: "llmf" });
      const route = path.startsWith("/v1/") ? path.slice(3) : path; // legacy un-prefixed form also works
      if (route === "/models" && req.method === "GET") {
        if (!authed(req)) return send(res, 401, err("invalid or missing credentials", "invalid_request_error", "invalid_api_key"), { "WWW-Authenticate": 'Bearer realm="llmf"' });
        const now = Math.floor(Date.now() / 1000);
        const ids = [...ALIASES, ...(await client.models.list()).map((m) => m.name)];
        return send(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", created: now, owned_by: "llmf" })) });
      }
      if (route === "/chat/completions" && req.method === "POST") {
        if (!authed(req)) return send(res, 401, err("invalid or missing credentials", "invalid_request_error", "invalid_api_key"), { "WWW-Authenticate": 'Bearer realm="llmf"' });
        if (maxConcurrent && active >= maxConcurrent) return send(res, 429, err("server busy: too many requests in flight, retry shortly", "rate_limit_error", "busy"), { "Retry-After": "1" });
        active++;
        try {
          const body = await readJson(req, res);
          if (body) await chat(req, res, body);
        } finally { active--; }
        return undefined;
      }
      return send(res, 404, err(`not found: ${path}`, "invalid_request_error", "not_found"));
    } catch (e) {
      if (!res.headersSent) send(res, 500, err("internal error", "server_error"));
      else res.end();
    }
  });
}

/** Start listening; resolves with the ``http.Server`` once it is up. */
export function serve(client, { host = "127.0.0.1", port = 8000, ...opts } = {}) {
  const server = createServer(client, { bindHost: host, ...opts });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 30000; // a client that never finishes its request cannot hold a socket forever
  server.requestTimeout = 60000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, backlog: 128 }, () => resolve(server));
  });
}

export { PARAMS };
