import { CookieJar, HTTPFailure, decodeBody, openUrl } from "../http.js";
import { ProviderError } from "../errors.js";
import { netOf } from "./base.js";
import { OpenAIAdapter } from "./openai.js";

const SESSION_TTL = 7000;
const META = /<meta[^>]+name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i;
const META_REV = /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i;

export class ChatAIAdapter extends OpenAIAdapter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  async _session(spec, ua, timeout, net, force = false) {
    const key = `${net.proxy || ""}|${net.transport || ""}|${spec.baseUrl}`;
    const hit = this.sessions.get(key);
    if (hit && !force && Date.now() - hit.born < SESSION_TTL * 1000) return hit;
    const jar = new CookieJar();
    const html = await decodeBody(await openUrl(spec.baseUrl.replace(/\/+$/, "") + "/chat", { headers: { "User-Agent": ua, Accept: "text/html" }, timeout, ...netOf(net), jar }));
    const m = META.exec(html) || META_REV.exec(html);
    if (!m) throw new TypeError("csrf-token meta tag not found (site layout changed?)");
    const sess = { jar, csrf: m[1], born: Date.now() };
    this.sessions.set(key, sess);
    return sess;
  }

  _request(spec, model, messages, opts) {

    const base = spec.baseUrl.replace(/\/+$/, "");
    const headers = { "Content-Type": "application/json", Accept: "text/event-stream", "User-Agent": opts.userAgent, Origin: base, Referer: base + "/chat", ...spec.headers };
    return [spec.chatUrl, headers, Buffer.from(JSON.stringify({ model, messages }))];
  }

  async _open(spec, url, headers, data, timeout, opts) {
    for (const attempt of [0, 1]) {
      const sess = await this._session(spec, opts.userAgent, timeout, opts, !!attempt);
      try {
        return await openUrl(url, { headers: { ...headers, "X-CSRF-Token": sess.csrf }, data, timeout, ...netOf(opts), jar: sess.jar });
      } catch (e) {
        if (attempt === 0 && e instanceof HTTPFailure && [401, 403, 419].includes(e.status)) continue;
        throw e;
      }
    }
  }

  async complete(spec, model, messages, opts, timeout) {
    let text = "";
    for await (const piece of this.stream(spec, model, messages, opts, timeout)) text += piece;
    text = text.trim();
    if (!text) throw new ProviderError(spec.name, model, "empty answer", { status: 200, code: "empty" });
    return { text, reasoning: null, usage: null, finishReason: "stop", toolCalls: null, raw: null };
  }

  async listModels() {
    return [];
  }
}
