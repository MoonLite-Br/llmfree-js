// Static files, a child "app" process (e.g. ``node main.js``) and a small reverse proxy for ``llmf serve``.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { which } from "./tunnel.js";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".wasm": "application/wasm",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf",
};
export const contentType = (p) => TYPES[path.extname(p).toLowerCase()] || "application/octet-stream";

const here = path.dirname(new URL(import.meta.url).pathname);
const assets = new Map();
/** Built-in browser assets (``chat.html``, ``client.js``, ``ui.js``). */
export function asset(name) {
  if (!["chat.html", "client.js", "ui.js"].includes(name)) throw new Error("no such asset");
  if (!assets.has(name)) assets.set(name, fs.readFileSync(path.join(here, "web", name)));
  return assets.get(name);
}

/**
 * Serves a **single file** (only that file, never its folder) or a directory tree. Directory mode never follows a
 * path outside the root (``..``, symlinks), never serves dotfiles, never lists directories, and falls back to
 * ``index.html`` for extension-less paths (SPA routing).
 */
export class StaticSite {
  constructor(p) {
    const abs = path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
    this.single = this.root = null;
    let st;
    try { st = fs.statSync(abs); } catch { throw new TypeError(`web path does not exist: ${p}`); }
    if (st.isFile()) this.single = abs;
    else if (st.isDirectory()) this.root = fs.realpathSync(abs);
    else throw new TypeError(`web path does not exist: ${p}`);
  }

  describe() { return this.single ? `file ${this.single}` : `directory ${this.root}`; }

  find(urlPath) {
    let rel;
    try { rel = decodeURIComponent(String(urlPath).split("?")[0]); } catch { return null; }
    if (rel.includes("\0") || rel.includes("\\")) return null;
    if (this.single) return ["", "/", "/index.html", "/" + path.basename(this.single)].includes(rel) ? this.single : null;
    const parts = rel.split("/").filter((x) => x !== "" && x !== ".");
    if (parts.some((x) => x === ".." || x.startsWith("."))) return null;
    let cand;
    try { cand = parts.length ? fs.realpathSync(path.join(this.root, ...parts)) : this.root; } catch {
      if (parts.length && !parts.at(-1).includes(".")) cand = null; // SPA fallback below
      else return null;
    }
    if (cand) {
      if (cand !== this.root && !cand.startsWith(this.root + path.sep)) return null;
      if (fs.statSync(cand).isDirectory()) cand = path.join(cand, "index.html");
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    }
    if (parts.length && !parts.at(-1).includes(".")) {
      const idx = path.join(this.root, "index.html");
      if (fs.existsSync(idx)) return idx;
    }
    return null;
  }
}

// ----------------------------------------------------------------------------- child app
/** ``"node main.js"`` -> argv. A bare script path gets its interpreter (``.js`` -> node, ``.py`` -> python3). */
export function resolveCommand(command) {
  const argv = [...String(command).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  if (!argv.length) throw new TypeError('--app needs a command, e.g. --app "node main.js"');
  const ext = path.extname(argv[0]).toLowerCase();
  if (argv.length === 1 && fs.existsSync(argv[0]) && fs.statSync(argv[0]).isFile()) {
    if ([".js", ".mjs", ".cjs"].includes(ext)) argv.unshift(process.execPath);
    else if (ext === ".py") argv.unshift("python3");
  }
  const exists = argv[0].includes(path.sep) ? fs.existsSync(argv[0]) : !!which(argv[0]);
  if (!exists) throw new TypeError(`command not found: ${argv[0]}${["node", "npm", "npx"].includes(argv[0]) ? " (Termux: pkg install nodejs)" : ""}`);
  return argv;
}

export function portOpen(port, host = "127.0.0.1", timeout = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const end = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });
}

/** Runs the user's web project as a child process and waits until it listens on ``port``. */
export class AppProcess {
  constructor(command, port, { cwd = null, env = {}, log = (s) => console.error(s) } = {}) {
    this.argv = resolveCommand(command);
    this.port = port;
    this.log = log;
    const last = this.argv.at(-1);
    this.cwd = cwd || (fs.existsSync(last) && fs.statSync(last).isFile() ? path.dirname(path.resolve(last)) : undefined);
    this.env = { ...process.env, ...env, PORT: String(port) };
    this.env.HOST ??= "127.0.0.1";
    this.proc = null;
    this.tail = [];
  }

  async start(wait = 30) {
    if (await portOpen(this.port)) throw new Error(`port ${this.port} is already in use: pick another with --app-port`);
    const proc = (this.proc = spawn(this.argv[0], this.argv.slice(1), { cwd: this.cwd, env: this.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" }));
    let exited = null;
    proc.once("exit", (code) => { exited = code ?? "signal"; });
    proc.once("error", (e) => { exited = e.message; });
    const pump = (c) => { for (const l of String(c).split(/\r?\n/)) if (l) { this.tail = [...this.tail, l].slice(-50); this.log("[app] " + l); } };
    proc.stdout.on("data", pump);
    proc.stderr.on("data", pump);
    const end = Date.now() + wait * 1000;
    while (Date.now() < end) {
      if (exited !== null) throw new Error(`the app exited with code ${exited} before listening on port ${this.port}:\n${this.tail.slice(-8).join("\n")}`);
      if (await portOpen(this.port)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    this.stop();
    throw new Error(`the app did not listen on port ${this.port} within ${wait}s (does it read the PORT environment variable?)\n${this.tail.slice(-8).join("\n")}`);
  }

  stop() {
    const p = this.proc;
    if (!p || p.exitCode !== null) return;
    try { process.kill(process.platform === "win32" ? p.pid : -p.pid, "SIGTERM"); } catch { try { p.kill(); } catch { /* gone */ } }
    setTimeout(() => { try { process.kill(process.platform === "win32" ? p.pid : -p.pid, "SIGKILL"); } catch { /* already gone */ } }, 3000).unref();
  }
}

// --------------------------------------------------------------------------- reverse proxy
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length"]);

/** Forward the request to ``127.0.0.1:port`` and stream the answer back. Resolves when the response is finished. */
export function proxyRequest(req, res, port, { body = null, clientIp, scheme, dropAuth, timeout = 120, fail }) {
  return new Promise((resolve) => {
    if ((req.headers.upgrade || "").toLowerCase() === "websocket") { fail(501, "WebSocket upgrades are not proxied", "not_implemented"); return resolve(501); }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (HOP.has(lk) || lk.startsWith("x-forwarded-") || lk === "x-real-ip") continue;
      if (lk === "authorization" && dropAuth(String(v))) continue;
      headers[k] = v;
    }
    const host = req.headers.host || "";
    Object.assign(headers, { host, "x-forwarded-for": clientIp, "x-real-ip": clientIp, "x-forwarded-proto": scheme, "x-forwarded-host": host, connection: "close" });
    if (body !== null) headers["content-length"] = String(body.length);
    const up = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers, timeout: timeout * 1000 }, (r) => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
      res.writeHead(r.statusCode, out);
      r.pipe(res);
      r.once("end", () => resolve(r.statusCode));
      r.once("error", () => { res.destroy(); resolve(502); });
    });
    up.once("timeout", () => up.destroy(new Error("timeout")));
    up.once("error", () => { if (!res.headersSent) fail(502, "the app is not responding", "bad_gateway"); else res.destroy(); resolve(502); });
    res.once("close", () => up.destroy());
    up.end(body);
  });
}
