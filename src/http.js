// Tiny HTTP layer on node:http / node:https (no third-party dependencies).
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import zlib from "node:zlib";
import { version } from "./version.js";
import * as socks from "./socks.js";
import { curlOnce, findCurl } from "./curl.js";

export const DEFAULT_UA =
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 llmf-js/${version}`;

export const MAX_BODY = 32 * 1024 * 1024; // a chat / model-list answer is never this big
export const MAX_LINE = 1024 * 1024; // one SSE line
export const MAX_STREAM_SECONDS = 900; // a stream that drips forever is cut off

/** Transport-level failure. ``status === null`` means no HTTP response. */
export class HTTPFailure extends Error {
  constructor(status, body = "", kind = "http") {
    super(`${status ?? kind} ${String(body).slice(0, 120)}`);
    this.name = "HTTPFailure";
    this.status = status;
    this.body = body;
    this.kind = kind; // "http" | "timeout" | "network"
  }
}

/** A response whose body has not been read yet. */
export class Response {
  constructor(res) {
    this._res = res;
    this.status = res.statusCode;
    this.headers = res.headers; // node lower-cases the names
  }

  get stream() {
    const enc = String(this.headers["content-encoding"] || "").toLowerCase();
    if (enc === "gzip") return this._res.pipe(zlib.createGunzip());
    if (enc === "deflate") return this._res.pipe(zlib.createInflate());
    return this._res;
  }

  close() {
    this._res.destroy();
  }
}

function netError(e, timedOut) {
  if (timedOut) return new HTTPFailure(null, "timed out", "timeout");
  return new HTTPFailure(null, e?.message || String(e), "network");
}

// ---------------------------------------------------------------------------------- proxies
/** ``socks5://user:secret@host:1`` -> ``socks5://user:***@host:1`` (for messages and logs). */
export function redactProxy(proxy) {
  try {
    const u = new URL(proxy);
    if (u.password) { u.password = "***"; return u.toString().replace(/\/$/, ""); }
  } catch { /* not a url */ }
  return proxy;
}

/** The proxy schemes llmf understands. */
const PROXY_SCHEMES = /^(https?|socks4a?|socks5h?):\/\//i;

/** Validate a user-supplied proxy URL (returns it unchanged, or ``null``). */
export function checkProxy(proxy) {
  if (typeof proxy === "string" && ["auto", "rotate", "random"].includes(proxy.trim().toLowerCase())) {
    throw new TypeError("proxy='auto' is not supported: llmf never picks or rotates public proxies for you. Pass your own proxy URL, e.g. http://host:port");
  }
  if (proxy && !PROXY_SCHEMES.test(proxy)) {
    throw new TypeError(`proxy must look like http://host:port, https://host:port or socks5://host:port (also socks5h, socks4, socks4a): ${JSON.stringify(redactProxy(proxy))}`);
  }
  if (proxy) { try { new URL(proxy); } catch { throw new TypeError(`bad proxy URL: ${JSON.stringify(redactProxy(proxy))}`); } }
  if (proxy && /^socks/i.test(proxy)) socks.parse(proxy); // validate early
  return proxy || null;
}

/** The proxy the environment asks for (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY, minus NO_PROXY), or ``null``. */
export function envProxy(url, env = process.env) {
  const u = new URL(url);
  const no = (env.NO_PROXY || env.no_proxy || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const host = u.hostname.toLowerCase();
  for (const n of no) {
    if (n === "*") return null;
    const bare = n.replace(/^\*?\./, "").replace(/:\d+$/, "");
    if (host === bare || host.endsWith("." + bare)) return null;
  }
  const pick = u.protocol === "https:"
    ? env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy
    : env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  return pick && PROXY_SCHEMES.test(pick) ? pick : null;
}

function proxyAuth(p) {
  return p.username ? "Basic " + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64") : null;
}

/** HTTP CONNECT through an http(s) proxy; resolves with the raw tunnel socket. */
function connectTunnel(proxyUrl, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const secure = p.protocol === "https:";
    const headers = { Host: `${host}:${port}` };
    const auth = proxyAuth(p);
    if (auth) headers["Proxy-Authorization"] = auth;
    let timedOut = false;
    const req = (secure ? https : http).request({ host: p.hostname, port: p.port || (secure ? 443 : 80), method: "CONNECT", path: `${host}:${port}`, headers, agent: false });
    req.setTimeout(timeoutMs, () => { timedOut = true; req.destroy(); });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new HTTPFailure(null, `proxy refused CONNECT: HTTP ${res.statusCode}`, "network")); return; }
      resolve(socket);
    });
    req.on("error", (e) => reject(netError(e, timedOut)));
    req.end();
  });
}

// ------------------------------------------------------------------------------------ cookies
/** Minimal per-host cookie jar (name=value pairs; enough for the anonymous session flows). */
export class CookieJar {
  constructor() { this.hosts = new Map(); }

  store(url, setCookie) {
    if (!setCookie?.length) return;
    const host = new URL(url).hostname;
    const jar = this.hosts.get(host) || new Map();
    for (const line of setCookie) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const dead = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a)) || attrs.some((a) => /^\s*expires\s*=/i.test(a) && Date.parse(a.split("=")[1]) < Date.now());
      if (dead) jar.delete(name); else jar.set(name, pair.slice(eq + 1).trim());
    }
    this.hosts.set(host, jar);
  }

  header(url) {
    const jar = this.hosts.get(new URL(url).hostname);
    return jar && jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join("; ") : null;
  }
}

/** ``"node"`` (default), ``"curl"`` or ``"auto"`` (curl-impersonate when available, else node). */
export function checkTransport(transport) {
  if (!["node", "curl", "auto"].includes(transport)) throw new TypeError("transport must be 'node', 'curl' or 'auto'");
  return transport;
}

async function once(url, method, headers, data, timeoutMs, proxy, net = {}) {
  let scheme;
  try { scheme = new URL(url).protocol; } catch { throw new HTTPFailure(null, "invalid URL", "network"); }
  if (scheme !== "http:" && scheme !== "https:") throw new HTTPFailure(null, `refusing to open a ${scheme} URL (only http/https)`, "network");
  const transport = net.transport || "node";
  if (transport !== "node" && (transport === "curl" || findCurl(net.impersonate))) {
    try {
      return await curlOnce(url, method, headers, data, timeoutMs, proxy, net.impersonate);
    } catch (e) {
      if (transport === "curl" || e?.code === "ENOCURL") throw netError(e, false); // "auto" falls back to node only when curl is absent
      if (e?.code !== "ECURL") throw e;
      // auto + curl misbehaved before sending a response: fall through to the built-in transport
    }
  }
  const u = new URL(url);
  const secure = u.protocol === "https:";
  let lib = secure ? https : http;
  let opts = { method, headers, agent: false };
  let target = u;
  if (proxy && /^socks/i.test(proxy)) {
    let sock;
    try { sock = await socks.connect(socks.parse(proxy), u.hostname, Number(u.port) || (secure ? 443 : 80), timeoutMs); } catch (e) { throw netError(e, e?.code === "ETIMEDOUT"); }
    opts.createConnection = secure ? () => tls.connect({ socket: sock, servername: u.hostname, ALPNProtocols: ["http/1.1"] }) : () => sock;
  } else if (proxy) {
    const p = new URL(proxy);
    if (secure) {
      const sock = await connectTunnel(proxy, u.hostname, u.port || 443, timeoutMs);
      const tlsSock = tls.connect({ socket: sock, servername: u.hostname, ALPNProtocols: ["http/1.1"] });
      opts.createConnection = () => tlsSock;
    } else {
      // plain http through a proxy: absolute-URI request line, explicit Host
      const pSecure = p.protocol === "https:";
      lib = pSecure ? https : http;
      const h = { ...headers, Host: u.host };
      const auth = proxyAuth(p);
      if (auth) h["Proxy-Authorization"] = auth;
      target = null;
      opts = { ...opts, host: p.hostname, port: p.port || (pSecure ? 443 : 80), path: url, headers: h };
    }
  }
  if (opts.createConnection) delete opts.agent; // node only honours createConnection when no agent is in play
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const req = target ? lib.request(target, opts, resolve) : lib.request(opts, resolve);
    req.setTimeout(timeoutMs, () => { timedOut = true; req.destroy(); });
    req.on("error", (e) => reject(netError(e, timedOut)));
    if (data) req.write(data);
    req.end();
  });
}

/** Read a whole (small) body; refuses anything larger than ``limit`` bytes. */
export async function readBody(stream, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  try {
    for await (const c of stream) {
      size += c.length;
      if (size > limit) throw new HTTPFailure(null, `response larger than ${limit >> 20} MB`, "network");
      chunks.push(c);
    }
  } catch (e) {
    if (e instanceof HTTPFailure) throw e;
    throw netError(e, false);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Open ``url``; resolves with a :class:`Response` (caller must ``close()`` it). Non-2xx -> HTTPFailure.
 * ``proxy``: your own proxy URL (an explicit proxy is never skipped because of NO_PROXY); without it the
 * HTTP(S)_PROXY environment is honoured. ``jar``: a :class:`CookieJar` for session flows.
 */
export async function openUrl(url, { headers = {}, data = null, timeout = 60, proxy = null, jar = null, maxRedirects = 5, transport = "node", impersonate = "chrome" } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new HTTPFailure(null, "refusing a non-http(s) URL", "network");
  let method = data ? "POST" : "GET";
  let body = data;
  const h = { ...headers };
  for (let hop = 0; ; hop++) {
    const via = proxy || envProxy(url);
    const reqHeaders = { ...h };
    const cookie = jar?.header(url);
    if (cookie) reqHeaders.Cookie = cookie;
    const res = await once(url, method, reqHeaders, body, timeout * 1000, via, { transport, impersonate });
    jar?.store(url, res.headers["set-cookie"]);
    const status = res.statusCode;
    const loc = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(status) && loc && hop < maxRedirects) {
      res.resume();
      const next = new URL(loc, url).toString();
      if (new URL(next).origin !== new URL(url).origin) { delete h.Authorization; delete h.authorization; }
      if (status !== 307 && status !== 308) { method = "GET"; body = null; delete h["Content-Type"]; }
      url = next;
      continue;
    }
    if (status >= 400 || (status >= 300 && status < 400)) {
      const resp = new Response(res);
      let text = "";
      try { text = await readBody(resp.stream); } catch { /* unreadable body */ }
      throw new HTTPFailure(status, text);
    }
    return new Response(res);
  }
}

/** Whole body of a response as text (and close it). */
export async function decodeBody(resp, limit = MAX_BODY) {
  try {
    return await readBody(resp.stream, limit);
  } finally {
    resp.close();
  }
}

/** Lines of a streaming body (``\n`` kept), with caps on line size, total size and wall time. */
export async function* iterLines(resp, { maxLine = MAX_LINE, maxTotal = MAX_BODY, maxSeconds = MAX_STREAM_SECONDS } = {}) {
  const stream = resp.stream;
  const timer = setTimeout(() => stream.destroy(new Error(`stream exceeded ${maxSeconds} s`)), maxSeconds * 1000);
  timer.unref?.();
  let pending = Buffer.alloc(0);
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > maxTotal) throw new HTTPFailure(null, "stream line/size limit exceeded", "network");
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let nl;
      while ((nl = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, nl + 1);
        pending = pending.subarray(nl + 1);
        if (line.length > maxLine) throw new HTTPFailure(null, "stream line/size limit exceeded", "network");
        yield line.toString("utf8");
      }
      if (pending.length > maxLine) throw new HTTPFailure(null, "stream line/size limit exceeded", "network");
    }
    if (pending.length) yield pending.toString("utf8");
  } catch (e) {
    if (e instanceof HTTPFailure) throw e;
    throw netError(e, false);
  } finally {
    clearTimeout(timer);
    resp.close();
  }
}
