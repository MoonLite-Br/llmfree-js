import { decodeBody, openUrl } from "../http.js";
import { ProviderError } from "../errors.js";
import { Adapter, errorFromBody, netOf, translate } from "./base.js";
import { buildInput } from "./nottrack.js";

export class ApiFreeAdapter extends Adapter {
  async complete(spec, model, messages, opts, timeout) {
    const data = Buffer.from(JSON.stringify({ inputCode: [{ role: "user", content: buildInput(messages) }], model, userEmail: null, isPremium: false }));
    const headers = { "Content-Type": "application/json", Accept: "*/*", "User-Agent": opts.userAgent, ...spec.headers };
    const text = (await translate(spec, model, async () => decodeBody(await openUrl(spec.chatUrl, { headers, data, timeout, ...netOf(opts) })))).trim();
    if (text.startsWith("{") && text.slice(0, 40).includes('"error"')) {
      const [code, msg] = errorFromBody(text);
      throw new ProviderError(spec.name, model, msg, { status: String(code || "").includes("limit") ? 429 : 502, code });
    }
    if (!text) throw new ProviderError(spec.name, model, "empty answer", { status: 200, code: "empty" });
    return { text, reasoning: null, usage: null, finishReason: "stop", toolCalls: null, raw: { text } };
  }

  async *stream(spec, model, messages, opts, timeout) {
    yield (await this.complete(spec, model, messages, opts, timeout)).text;
  }

  async listModels() { return []; }
}
