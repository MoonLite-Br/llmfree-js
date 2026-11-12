import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const QUICK_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/;
const NAMED_OK = /registered tunnel connection|connection [0-9a-f-]+ registered/i;

export class TunnelError extends Error {}

export function which(name, env = process.env) {
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {   }
  }
  return null;
}

export const findCloudflared = () => process.env.CLOUDFLARED || which("cloudflared");

export class Tunnel {
  constructor(port, { token = null, binary = null, scheme = "http" } = {}) {
    Object.assign(this, { port, token, scheme, binary: binary || findCloudflared(), proc: null, url: null, lines: [] });
  }

  argv() {
    if (!this.binary) throw new TunnelError("cloudflared was not found on PATH. Install it (Termux: `pkg install cloudflared`; other systems: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or set CLOUDFLARED=/path/to/cloudflared");
    const base = [this.binary, "tunnel", "--no-autoupdate"];
    return this.token ? [...base, "run"] : [...base, "--url", `${this.scheme}://127.0.0.1:${this.port}`];
  }

  start(timeout = 60) {
    const argv = this.argv();
    if (this.scheme === "https" && !this.token) argv.push("--no-tls-verify");
    return new Promise((resolve, reject) => {
      const env = this.token ? { ...process.env, TUNNEL_TOKEN: this.token } : process.env;
      const proc = (this.proc = spawn(argv[0], argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" }));
      let done = false;
      const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
      const pump = (chunk) => {
        for (const raw of String(chunk).split(/\r?\n/)) {
          if (!raw) continue;
          this.lines = [...this.lines, raw].slice(-60);
          if (this.token ? NAMED_OK.test(raw) : (this.url = QUICK_URL.exec(raw)?.[0] ?? this.url)) finish(resolve, this.url);
        }
      };
      proc.stdout.on("data", pump);
      proc.stderr.on("data", pump);
      proc.once("error", (e) => finish(reject, new TunnelError(`cannot run cloudflared: ${e.message}`)));
      proc.once("exit", (code) => finish(reject, new TunnelError(`cloudflared exited with code ${code}:\n${this.lines.slice(-8).join("\n")}`)));
      const timer = setTimeout(() => { this.stop(); finish(reject, new TunnelError(`cloudflared did not report a tunnel within ${timeout}s:\n${this.lines.slice(-8).join("\n")}`)); }, timeout * 1000);
    });
  }

  stop() {
    const p = this.proc;
    if (!p || p.exitCode !== null || p.killed) return;
    try { process.kill(process.platform === "win32" ? p.pid : -p.pid, "SIGTERM"); } catch { try { p.kill(); } catch {   } }
  }
}
