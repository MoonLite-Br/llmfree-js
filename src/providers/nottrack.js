// Adapter for nottrack.com ``/api/dispatch`` (SSE, multi-speaker "debate" mode).
//
// Request: ``{"user_input": "..."}``. Response: server-sent events; the answer is the concatenation of
// ``chunk`` fields of ``type == "delta"`` events. Replies are long, uncensored, role-play style, with
// several speakers, so this provider is opt-in only (``provider: "nottrack"``) and never part of the
// automatic chain.
import { iterLines, openUrl } from "../http.js";
import { ProviderError } from "../errors.js";
import { Adapter, guarded, netOf, translate } from "./base.js";

const text = (content) => {
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" ? p.text ?? "" : "")).join("");
  return content == null ? "" : String(content);
};

/** The endpoint takes one string: send a lone user message as is, else a transcript. */
export function buildInput(messages) {
  if (messages.length === 1) return text(messages[0].content);
  const names = { system: "System", user: "User", assistant: "Assistant" };
  return messages.map((m) => `${names[m.role] || "User"}: ${text(m.content)}`).join("\n");
}

export class NotTrackAdapter extends Adapter {
  _open(spec, messages, opts, timeout) {
    const data = Buffer.from(JSON.stringify({ user_input: buildInput(messages) }));
    const headers = { "Content-Type": "application/json", Accept: "text/event-stream", "User-Agent": opts.userAgent, ...spec.headers };
    return openUrl(spec.chatUrl, { headers, data, timeout, ...netOf(opts) });
  }

  /** Yield text pieces; a blank line is added when the speaker changes. */
  async *_events(spec, model, resp) {
    let speaker;
    for await (const raw of iterLines(resp)) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      if (!ev || typeof ev !== "object") continue;
      if (ev.type === "error") throw new ProviderError(spec.name, model, String(ev.message || ev.error || "error event"), { status: 502, code: "event_error" });
      if (ev.type !== "delta" || !ev.chunk) continue;
      if (speaker !== undefined && ev.speaker !== speaker) yield "\n\n";
      speaker = ev.speaker;
      yield String(ev.chunk);
    }
  }

  async complete(spec, model, messages, opts, timeout) {
    const resp = await translate(spec, model, () => this._open(spec, messages, opts, timeout));
    let out = "";
    try {
      for await (const piece of guarded(spec, model, this._events(spec, model, resp))) out += piece;
    } finally { resp.close(); }
    out = out.trim();
    if (!out) throw new ProviderError(spec.name, model, "empty answer", { status: 200, code: "empty" });
    return { text: out, reasoning: null, usage: null, finishReason: "stop", toolCalls: null, raw: null };
  }

  async *stream(spec, model, messages, opts, timeout) {
    const resp = await translate(spec, model, () => this._open(spec, messages, opts, timeout));
    try {
      let started = false;
      for await (let piece of guarded(spec, model, this._events(spec, model, resp))) {
        if (!started) piece = piece.trimStart();
        if (piece) { started = true; yield piece; }
      }
      if (!started) throw new ProviderError(spec.name, model, "empty stream", { status: 200, code: "empty" });
    } finally { resp.close(); }
  }

  async listModels() {
    return [];
  }
}
