import { CookieJar, HTTPFailure, decodeBody, iterLines, openUrl } from "../http.js";
import { ProviderError } from "../errors.js";
import { netOf } from "./base.js";
import { NotTrackAdapter, buildInput } from "./nottrack.js";

const SESSION_TTL = 600 * 1000;
export const PERSONAS = ["concise", "normal", "detailed", "creative"];

export class NotTrackAIAdapter extends NotTrackAdapter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  async _jar(spec, ua, timeout, net, force = false) {
    const key = `${net.proxy || ""}|${net.transport || ""}|${spec.baseUrl}`;
    const hit = this.sessions.get(key);
    if (hit && !force && Date.now() - hit.born < SESSION_TTL) return hit.jar;
    const jar = new CookieJar();
    await decodeBody(await openUrl(spec.baseUrl.replace(/\/+$/, "") + "/chat", { headers: { "User-Agent": ua, Accept: "text/html,*/*" }, timeout, ...netOf(net), jar }));
    this.sessions.set(key, { jar, born: Date.now() });
    return jar;
  }

  async _open(spec, messages, opts, timeout) {
    const persona = opts.extra?.persona;
    const data = Buffer.from(JSON.stringify({
      user_input: buildInput(messages), mode: "usual", model: "C", persona: PERSONAS.includes(persona) ? persona : "normal",
      max_turns: 6, chat_id: null, attachments: [], regenerate: false, edit: false, edit_mid: null, via: "typed",
    }));
    const base = spec.baseUrl.replace(/\/+$/, "");
    const headers = { "Content-Type": "application/json", Accept: "text/event-stream", "User-Agent": opts.userAgent, Origin: base, Referer: base + "/chat", ...spec.headers };
    for (const attempt of [0, 1]) {
      const jar = await this._jar(spec, opts.userAgent, timeout, opts, !!attempt);
      try {
        return await openUrl(spec.chatUrl, { headers, data, timeout, ...netOf(opts), jar });
      } catch (e) {
        if (attempt === 0 && e instanceof HTTPFailure && [401, 403, 419].includes(e.status)) continue;
        throw e;
      }
    }
  }

  async *_events(spec, model, resp, timeout = 0) {
    let gotDelta = false;
    const whole = [];
    for await (const raw of iterLines(resp, { idleSeconds: timeout })) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      if (!ev || typeof ev !== "object") continue;
      if (ev.type === "error") throw new ProviderError(spec.name, model, String(ev.message || ev.error || "error event"), { status: 502, code: "event_error" });
      if (ev.type === "delta" && ev.chunk) { gotDelta = true; yield String(ev.chunk); }
      else if (ev.type === "message" && ev.content) whole.push(String(ev.content));
      else if (ev.type === "done") break;
    }
    if (!gotDelta && whole.length) yield whole.join("\n\n");
  }
}
