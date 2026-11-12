import { openUrl, decodeBody, iterLines } from "../http.js";
import { ThinkSplitter, splitThink } from "../think.js";
import { ProviderError } from "../errors.js";
import { Adapter, errorFromBody, netOf, translate, guarded } from "./base.js";

export function contentToText(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" ? p.text ?? "" : "")).join("");
  return typeof content === "object" ? JSON.stringify(content) : String(content);
}

export class OpenAIAdapter extends Adapter {

  _open(spec, url, headers, data, timeout, opts) {
    return openUrl(url, { headers, data, timeout, ...netOf(opts) });
  }

  _request(spec, model, messages, opts, stream) {
    const body = { model, messages };
    if (opts.maxTokens !== null) body.max_tokens = opts.maxTokens;
    if (opts.temperature !== null) body.temperature = opts.temperature;
    if (opts.topP !== null) body.top_p = opts.topP;
    if (opts.stop !== null) body.stop = opts.stop;
    if (opts.json) body.response_format = { type: "json_object" };
    if (opts.tools?.length) body.tools = opts.tools;
    if (stream) body.stream = true;
    Object.assign(body, opts.extra);
    const headers = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      "User-Agent": opts.userAgent,
      ...spec.headers,
    };
    return [spec.chatUrl, headers, Buffer.from(JSON.stringify(body))];
  }

  async complete(spec, model, messages, opts, timeout) {
    const [url, headers, data] = this._request(spec, model, messages, opts, false);
    return translate(spec, model, async () => {
      const resp = await this._open(spec, url, headers, data, timeout, opts);
      return this._parse(spec, model, JSON.parse(await decodeBody(resp)));
    });
  }

  _parse(spec, model, obj) {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new TypeError("response is not a JSON object");

    if (obj.error || (obj.code && !obj.choices)) {
      const [code, msg] = errorFromBody(JSON.stringify(obj));
      throw new ProviderError(spec.name, model, msg || "error response", { code, status: code === "FREE_MODEL_FAILED" ? 502 : 400 });
    }
    const choice = obj.choices[0];
    const msg = choice.message || {};
    let text = contentToText(msg.content);
    let reasoning = msg.reasoning || msg.reasoning_content || null;
    if (Array.isArray(reasoning)) reasoning = contentToText(reasoning) || null;
    let think;
    [text, think] = splitThink(text);
    if (think) reasoning = reasoning ? `${reasoning}\n${think}`.trim() : think;
    const finish = choice.finish_reason ?? null;
    const toolCalls = msg.tool_calls?.length ? msg.tool_calls : null;
    if (!text && !toolCalls) {
      throw new ProviderError(spec.name, model, `empty answer (finish_reason=${finish}); try a larger max_tokens`, { status: 200, code: "empty" });
    }
    return { text, reasoning, usage: obj.usage ?? null, finishReason: finish, toolCalls, raw: obj };
  }

  async *stream(spec, model, messages, opts, timeout) {
    const [url, headers, data] = this._request(spec, model, messages, opts, true);
    const resp = await translate(spec, model, () => this._open(spec, url, headers, data, timeout, opts));
    try {
      const splitter = new ThinkSplitter();
      const lines = guarded(spec, model, iterLines(resp, { idleSeconds: timeout }));
      let first = null;
      for (;;) {
        const r = await lines.next();
        if (r.done) break;
        first = r.value.trim();
        if (first) break;
      }
      if (first === null) return;
      if (!/^(data:|:|event:|id:|retry:)/.test(first)) {

        let rest = first;
        for await (const l of lines) rest += l;
        const comp = await translate(spec, model, () => this._parse(spec, model, JSON.parse(rest)));
        yield comp.text;
        return;
      }
      let pending = first;
      for (;;) {
        let line;
        if (pending !== null) {
          line = pending;
          pending = null;
        } else {
          const r = await lines.next();
          if (r.done) break;
          line = r.value.trim();
        }
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") break;
        const piece = await translate(spec, model, () => {
          const obj = JSON.parse(payload);
          if (obj && typeof obj === "object" && obj.error) {
            const [code, msg] = errorFromBody(payload);
            throw new ProviderError(spec.name, model, msg, { code, status: 502 });
          }
          const choices = obj.choices || [];
          const delta = choices.length ? choices[0].delta || {} : {};
          return contentToText(delta.content);
        });
        if (piece) {
          const out = splitter.feed(piece);
          if (out) yield out;
        }
      }
      const tail = splitter.flush();
      if (tail) yield tail;
    } finally {
      resp.close();
    }
  }
}
