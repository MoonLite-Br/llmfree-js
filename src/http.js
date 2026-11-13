import { isPublicHost } from "./util.js";
import { isIP } from "node:net";
import { version } from "./version.js";
import * as socks from "./socks.js";
import { curlOnce, findCurl } from "./curl.js";

export const DEFAULT_UA =
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 llmf-js/${version}`;

export const MAX_BODY = 32 * 1024 * 1024;
export const MAX_LINE = 1024 * 1024;
const SAFE_ON_REDIRECT = new Set(["accept", "accept-language", "accept-encoding", "content-type", "user-agent"]);
export const MAX_STREAM_SECONDS = 900;

export class HTTPFailure extends Error {
  constructor(status, body = "", kind = "http") {
    super(`${status ?? kind} ${String(body).slice(0, 120)}`);
    this.name = "HTTPFailure";
    this.status = status;
    this.body = body;
    this.kind = kind;
  }
}

let http, https, tls, zlib, dns;
async function loadCore() {
  zlib ??= (await import("node:zlib")).default;
  dns ??= (await import("node:dns")).default;
}
async function loadNet(secure) {
  if (secure) {
    https ??= (await import("node:https")).default;
    tls ??= (await import("node:tls")).default;
  } else http ??= (await import("node:http")).default;
}

const DNS_TTL_MS = 120_000;
const dnsCache = new Map();
const dnsInflight = new Map();

function cachedLookup(hostname, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  if (isIP(hostname)) return dns.lookup(hostname, options, cb);
  const family = options?.family || 0;
  const all = !!options?.all;
  const key = `${hostname}|${family}`;
  const reply = (addrs) => process.nextTick(() => (all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family)));
  const hit = dnsCache.get(key);
  if (hit && Date.now() - hit.t < DNS_TTL_MS) return reply(hit.addrs);
  let p = dnsInflight.get(key);
  if (!p) {
    p = new Promise((resolve, reject) => dns.lookup(hostname, { family, all: true, verbatim: true }, (e, a) => (e ? reject(e) : resolve(a))));
    dnsInflight.set(key, p);
    p.then(() => dnsInflight.delete(key), () => dnsInflight.delete(key));
  }
  p.then((addrs) => {
    const sorted = [...addrs].sort((a, b) => a.family - b.family);
    dnsCache.set(key, { t: Date.now(), addrs: sorted });
    reply(sorted);
  }, (e) => cb(e));
  return undefined;
}

let pools = null;

function pooledAgent(secure) {
  if (process.env.LLMF_NO_KEEPALIVE) return false;
  pools ??= {};
  const k = secure ? "s" : "p";
  return (pools[k] ??= new (secure ? https : http).Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: Infinity, maxFreeSockets: 16, scheduling: "lifo", lookup: cachedLookup }));
}

export class Response {
  constructor(res) {
    this._res = res;
    this.status = res.statusCode;
    this.headers = res.headers;
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

export function redactProxy(proxy) {
  try {
    const u = new URL(proxy);
    if (u.password) { u.password = "***"; return u.toString().replace(/\/$/, ""); }
  } catch {   }
  return String(proxy).replace(/(\/\/[^:@/]*:)[^@/]*@/, "$1***@").replace(/^([^:@/]+:)[^@/]*@/, "$1***@");
}

const PROXY_SCHEMES = /^(https?|socks4a?|socks5h?):\/\//i;

export function checkProxy(proxy) {
  if (typeof proxy === "string" && ["auto", "rotate", "random"].includes(proxy.trim().toLowerCase())) {
    throw new TypeError("proxy='auto' is not supported: llmf never picks or rotates public proxies for you. Pass your own proxy URL, e.g. http://host:port");
  }
  if (proxy && !PROXY_SCHEMES.test(proxy)) {
    throw new TypeError(`proxy must look like http://host:port, https://host:port or socks5://host:port (also socks5h, socks4, socks4a): ${JSON.stringify(redactProxy(proxy))}`);
  }
  if (proxy) { try { new URL(proxy); } catch { throw new TypeError(`bad proxy URL: ${JSON.stringify(redactProxy(proxy))}`); } }
  if (proxy && /^socks/i.test(proxy)) socks.parse(proxy);
  return proxy || null;
}

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

async function connectTunnel(proxyUrl, host, port, timeoutMs) {
  const p = new URL(proxyUrl);
  const secure = p.protocol === "https:";
  await loadNet(secure);
  return new Promise((resolve, reject) => {
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

export function checkTransport(transport) {
  if (!["node", "curl", "auto"].includes(transport)) throw new TypeError("transport must be 'node', 'curl' or 'auto'");
  return transport;
}

async function once(url, method, headers, data, timeoutMs, proxy, net = {}, fresh = false) {
  let scheme;
  try { scheme = new URL(url).protocol; } catch { throw new HTTPFailure(null, "invalid URL", "network"); }
  if (scheme !== "http:" && scheme !== "https:") throw new HTTPFailure(null, `refusing to open a ${scheme} URL (only http/https)`, "network");
  const transport = net.transport || "node";
  if (transport !== "node" && (transport === "curl" || findCurl(net.impersonate))) {
    try {
      return await curlOnce(url, method, headers, data, timeoutMs, proxy, net.impersonate);
    } catch (e) {
      if (transport === "curl" || e?.code === "ENOCURL") throw netError(e, false);
      if (e?.code !== "ECURL") throw e;

    }
  }
  const u = new URL(url);
  const secure = u.protocol === "https:";
  await loadNet(secure);
  if (proxy) await loadNet(true);
  let lib = secure ? https : http;
  let opts = { method, headers, agent: false };
  if (!proxy && !fresh) opts.agent = pooledAgent(secure);
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

      const pSecure = p.protocol === "https:";
      await loadNet(pSecure);
      lib = pSecure ? https : http;
      const h = { ...headers, Host: u.host };
      const auth = proxyAuth(p);
      if (auth) h["Proxy-Authorization"] = auth;
      target = null;
      opts = { ...opts, host: p.hostname, port: p.port || (pSecure ? 443 : 80), path: url, headers: h };
    }
  }
  if (opts.createConnection) delete opts.agent;
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let responded = false;
    const onResponse = (res) => { responded = true; resolve(res); };
    const req = target ? lib.request(target, opts, onResponse) : lib.request(opts, onResponse);
    req.setTimeout(timeoutMs, () => { timedOut = true; req.destroy(); });
    req.on("error", (e) => {

      if (!responded && !fresh && req.reusedSocket && (e.code === "ECONNRESET" || e.code === "EPIPE")) {
        once(url, method, headers, data, timeoutMs, proxy, net, true).then(resolve, reject);
        return;
      }
      reject(netError(e, timedOut));
    });
    if (data) req.write(data);
    req.end();
  });
}

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

export async function openUrl(url, { headers = {}, data = null, timeout = 60, proxy = null, jar = null, maxRedirects = 5, transport = "node", impersonate = "chrome" } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new HTTPFailure(null, "refusing a non-http(s) URL", "network");
  await loadCore();
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
      const from = new URL(url);
      const to = new URL(loc, url);
      if (to.protocol !== "http:" && to.protocol !== "https:") throw new HTTPFailure(null, "refusing a redirect to a non-http(s) URL", "network");
      if (from.protocol === "https:" && to.protocol === "http:") throw new HTTPFailure(null, "refusing a redirect from https to http", "network");
      if (isPublicHost(from.hostname) && !isPublicHost(to.hostname)) throw new HTTPFailure(null, "refusing a redirect from a public host to a local or private address", "network");
      const next = to.toString();
      if (to.origin !== from.origin) {
        for (const k of Object.keys(h)) if (!SAFE_ON_REDIRECT.has(k.toLowerCase())) delete h[k];
      }
      if (status !== 307 && status !== 308) { method = "GET"; body = null; delete h["Content-Type"]; }
      url = next;
      continue;
    }
    if (status >= 400 || (status >= 300 && status < 400)) {
      const resp = new Response(res);
      let text = "";
      try { text = await readBody(resp.stream); } catch {   }
      throw new HTTPFailure(status, text);
    }
    return new Response(res);
  }
}

export async function decodeBody(resp, limit = MAX_BODY) {
  try {
    return await readBody(resp.stream, limit);
  } finally {
    resp.close();
  }
}

export async function* iterLines(resp, { maxLine = MAX_LINE, maxTotal = MAX_BODY, maxSeconds = MAX_STREAM_SECONDS, idleSeconds = 0 } = {}) {
  const stream = resp.stream;
  const timer = setTimeout(() => stream.destroy(new Error(`stream exceeded ${maxSeconds} s`)), maxSeconds * 1000);
  timer.unref?.();
  let idleHit = false;
  let idle = null;
  const arm = () => {
    if (!idleSeconds) return;
    clearTimeout(idle);
    idle = setTimeout(() => { idleHit = true; stream.destroy(new Error("idle")); }, idleSeconds * 1000);
    idle.unref?.();
  };
  arm();
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
        const text = line.toString("utf8");
        if (text.trim() && text[0] !== ":") arm();
        yield text;
      }
      if (pending.length > maxLine) throw new HTTPFailure(null, "stream line/size limit exceeded", "network");
    }
    if (pending.length) yield pending.toString("utf8");
  } catch (e) {
    if (e instanceof HTTPFailure) throw e;
    throw netError(e, idleHit);
  } finally {
    clearTimeout(timer);
    clearTimeout(idle);
    resp.close();
  }
}
