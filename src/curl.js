import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";

const FAMILIES = { chrome: /^(curl_chrome|curl-impersonate-chrome)/, firefox: /^(curl_ff|curl-impersonate-ff)/, safari: /^(curl_safari|curl-impersonate-safari)/, edge: /^curl_edge/ };

export function findCurl(impersonate = "chrome", env = process.env) {
  if (env.LLMF_CURL_BIN) return fs.existsSync(env.LLMF_CURL_BIN) ? env.LLMF_CURL_BIN : null;
  const re = FAMILIES[String(impersonate).toLowerCase()] || FAMILIES.chrome;
  const hits = [];
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (re.test(n) && !n.endsWith(".so")) hits.push(path.join(dir, n));
  }
  hits.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return hits[0] || null;
}

export function available(impersonate = "chrome") {
  return findCurl(impersonate) !== null;
}

export function describe(transport = "node", impersonate = "chrome") {
  if (transport === "node") return "node";
  const bin = findCurl(impersonate);
  return bin ? `curl-impersonate (${path.basename(bin)})` : transport === "auto" ? "node (curl-impersonate not found)" : "curl-impersonate missing";
}

function parseHead(text) {
  const lines = text.split(/\r?\n/);
  const m = /^HTTP\/\S+\s+(\d{3})/.exec(lines[0] || "");
  if (!m) return null;
  const headers = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(":");
    if (i < 1) continue;
    const k = l.slice(0, i).trim().toLowerCase(), v = l.slice(i + 1).trim();
    if (k === "set-cookie") (headers[k] ||= []).push(v);
    else headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
  }
  return { status: Number(m[1]), headers };
}

export function curlOnce(url, method, headers, data, timeoutMs, proxy, impersonate = "chrome") {
  const bin = findCurl(impersonate);
  if (!bin) return Promise.reject(Object.assign(new Error("curl-impersonate not found (set LLMF_CURL_BIN)"), { code: "ENOCURL" }));
  const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
  const args = ["-sS", "-i", "--connect-timeout", String(secs), "-Y", "1", "-y", String(secs), "--max-time", "900", "-X", method];
  if (proxy) args.push("--proxy", proxy);
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (data) args.push("--data-binary", "@-");
  args.push("--", url);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const body = new PassThrough();
    let head = Buffer.alloc(0), stderr = "", settled = false;
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    child.stdin.on("error", () => {});
    child.stdin.end(data || undefined);
    const fail = (msg) => { if (!settled) { settled = true; reject(Object.assign(new Error(msg), { code: "ECURL" })); } };
    child.on("error", (e) => fail(e.message));
    child.stdout.on("data", (chunk) => {
      if (settled) { body.write(chunk); return; }
      head = Buffer.concat([head, chunk]);
      for (;;) {
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const parsed = parseHead(head.subarray(0, end).toString("latin1"));
        const rest = head.subarray(end + 4);
        if (!parsed) { fail("unparsable response from curl"); return; }
        if (parsed.status < 200 || /connection established/i.test(head.subarray(0, end).toString("latin1").split("\n")[0])) { head = rest; continue; }
        settled = true;
        body.statusCode = parsed.status;
        body.headers = parsed.headers;
        body.destroy = ((orig) => (err) => { child.kill("SIGKILL"); return orig.call(body, err); })(body.destroy);
        resolve(body);
        if (rest.length) body.write(rest);
        return;
      }
    });
    child.on("close", (code) => {
      if (!settled) fail(stderr.trim().split("\n").pop() || `curl exited with ${code}`);
      else if (code !== 0 && code !== null && !body.destroyed) body.destroy(new Error(stderr.trim().split("\n").pop() || `curl exited with ${code}`));
      else body.end();
    });
  });
}

export function curlVersion(impersonate = "chrome") {
  const bin = findCurl(impersonate);
  if (!bin) return null;
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? r.stdout.split("\n")[0] : null;
}
