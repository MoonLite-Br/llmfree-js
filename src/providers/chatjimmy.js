// Adapter for chatjimmy.ai (raw text + ``<|stats|>{json}<|/stats|>`` trailer).
import { StringDecoder } from "node:string_decoder";
import { openUrl, decodeBody, MAX_BODY, MAX_STREAM_SECONDS } from "../http.js";
import { ProviderError } from "../errors.js";
import { Adapter, netOf, translate } from "./base.js";

const STATS_OPEN = "<|stats|>";
// Greedy first group => the *last* stats block wins, so a prompt that makes the
// model print the sentinel cannot truncate the answer.
const TRAILER = /^([\s\S]*)<\|stats\|>([\s\S]*?)<\|\/stats\|>\s*$/;

export function splitStats(raw) {
  const m = TRAILER.exec(raw);
  if (!m) return [raw.trim(), null];
  let stats = null;
  try { stats = JSON.parse(m[2]); } catch { /* not json */ }
  return [m[1].trim(), stats && typeof stats === "object" && !Array.isArray(stats) ? stats : null];
}

function usageOf(stats) {
  if (!stats) return null;
  const p = stats.prefill_tokens, c = stats.decode_tokens;
  if (p == null && c == null) return null;
  return { prompt_tokens: p, completion_tokens: c, total_tokens: stats.total_tokens || (p || 0) + (c || 0) };
}

/** ChatJimmy takes plain-text content only; flatten content parts. */
function plain(message) {
  let content = message.content;
  if (Array.isArray(content)) content = content.map((p) => (p && typeof p === "object" ? p.text ?? "" : "")).join("");
  return { role: message.role || "user", content: content || "" };
}

export class ChatJimmyAdapter extends Adapter {
  _request(spec, model, messages, opts, stream) {
    const options = { selectedModel: model };
    if (opts.temperature !== null) options.temperature = opts.temperature;
    if (opts.maxTokens !== null) options.max_tokens = opts.maxTokens;
    const body = { chatOptions: options, messages: messages.map(plain), stream: !!stream };
    const headers = { "Content-Type": "application/json", "User-Agent": opts.userAgent, ...spec.headers };
    return [spec.chatUrl, headers, Buffer.from(JSON.stringify(body))];
  }

  async complete(spec, model, messages, opts, timeout) {
    const [url, headers, data] = this._request(spec, model, messages, opts, false);
    const raw = await translate(spec, model, async () => decodeBody(await openUrl(url, { headers, data, timeout, ...netOf(opts) })));
    const [text, stats] = splitStats(raw);
    if (!text) throw new ProviderError(spec.name, model, "empty answer", { status: 200, code: "empty" });
    return { text, reasoning: null, usage: usageOf(stats), finishReason: stats?.done_reason || "stop", toolCalls: null, raw: { text: raw, stats } };
  }

  async *stream(spec, model, messages, opts, timeout) {
    const [url, headers, data] = this._request(spec, model, messages, opts, true);
    const resp = await translate(spec, model, () => openUrl(url, { headers, data, timeout, ...netOf(opts) }));
    const decoder = new StringDecoder("utf8");
    let buf = ""; // not-yet-emitted text
    let holding = false; // a stats sentinel was seen; everything after is held
    let started = false;
    const keep = STATS_OPEN.length - 1;
    const deadline = Date.now() + MAX_STREAM_SECONDS * 1000;
    let got = 0;
    try {
      const it = resp.stream[Symbol.asyncIterator]();
      for (;;) {
        if (Date.now() > deadline || got > MAX_BODY) throw new ProviderError(spec.name, model, "network: stream limit exceeded");
        const r = await translate(spec, model, () => it.next().catch((e) => { throw Object.assign(new Error(e.message), { name: "TypeError" }); }));
        if (r.done) break;
        got += r.value.length;
        buf += decoder.write(r.value);
        if (holding) continue;
        const i = buf.indexOf(STATS_OPEN);
        let out;
        if (i >= 0) {
          out = buf.slice(0, i); buf = buf.slice(i); holding = true;
        } else {
          const cut = Math.max(0, buf.length - keep);
          out = buf.slice(0, cut); buf = buf.slice(cut);
        }
        if (!started) out = out.trimStart();
        if (out) { started = true; yield out; }
      }
      buf += decoder.end();
    } finally {
      resp.close();
    }
    // Stream finished: ``buf`` is a stats trailer, plain tail text, or (rarely) a fake sentinel followed by the real trailer.
    let text = holding ? splitStats(buf)[0] : buf;
    if (holding && !TRAILER.test(buf)) text = buf;
    const tail = started ? text : text.trimStart();
    if (tail.trim() || (tail && started)) yield holding ? tail.trimEnd() : tail;
    else if (!started) throw new ProviderError(spec.name, model, "empty answer", { status: 200, code: "empty" });
  }
}
