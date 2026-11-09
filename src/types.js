// Public value types.
import { randomHex } from "./util.js";

/** The answer text, plus metadata. ``String(reply)`` / template strings give the text. */
export class Reply {
  constructor(text = "", { provider = "", model = "", reasoning = null, usage = null, finishReason = null,
    toolCalls = null, latency = 0, raw = null, attempts = [] } = {}) {
    this.text = text;
    this.provider = provider;
    this.model = model;
    this.reasoning = reasoning;
    this.usage = usage;
    this.finishReason = finishReason;
    this.toolCalls = toolCalls;
    this.latency = latency;
    this.raw = raw;
    this.attempts = attempts;
  }

  /** ``"provider/model"`` that produced this reply. */
  get source() {
    return `${this.provider}/${this.model}`;
  }

  toString() {
    return this.text;
  }

  [Symbol.toPrimitive]() {
    return this.text;
  }

  toJSON() {
    const { raw, attempts, ...rest } = this; // eslint-disable-line no-unused-vars
    return { ...rest, source: this.source };
  }
}

export class ModelInfo {
  constructor(provider, id, { tags = [], vision = false, verified = true, alive = null, samples = 0, streaming = true } = {}) {
    Object.assign(this, { provider, id, tags, vision, verified, alive, samples, streaming });
  }

  /** Fully-qualified name usable as ``model``. */
  get name() {
    return `${this.provider}/${this.id}`;
  }
}

export class HealthResult {
  constructor(provider, model, ok, latency = 0, error = null, answer = null, verified = true) {
    Object.assign(this, { provider, model, ok, latency, error, answer, verified });
  }

  get name() {
    return `${this.provider}/${this.model}`;
  }
}

function usageOf(u) {
  const p = Number(u?.prompt_tokens) || 0;
  const c = Number(u?.completion_tokens) || 0;
  return { prompt_tokens: p, completion_tokens: c, total_tokens: Number(u?.total_tokens) || p + c };
}

/** Drop-in shape of OpenAI's ``chat.completion`` plus llmf routing info. */
export class ChatCompletion {
  constructor({ id, created, model, choices, usage, provider = "", latency = 0, attempts = [] }) {
    this.id = id;
    this.object = "chat.completion";
    this.created = created;
    this.model = model; // "provider/model" that actually answered
    this.choices = choices;
    this.usage = usage;
    this.provider = provider;
    this.latency = latency;
    this.attempts = attempts;
  }

  static fromReply(reply) {
    const message = { role: "assistant", content: reply.text };
    if (reply.reasoning) message.reasoning = reply.reasoning;
    if (reply.toolCalls?.length) message.tool_calls = reply.toolCalls;
    return new ChatCompletion({
      id: "chatcmpl-" + randomHex(12),
      created: Math.floor(Date.now() / 1000),
      model: reply.source,
      choices: [{ index: 0, message, finish_reason: reply.finishReason || "stop" }],
      usage: usageOf(reply.usage),
      provider: reply.provider,
      latency: reply.latency,
      attempts: reply.attempts,
    });
  }

  get outputText() {
    return this.choices[0].message.content;
  }

  toString() {
    return this.outputText;
  }

  /** The OpenAI wire shape (also what ``JSON.stringify`` gives). */
  toJSON() {
    const { id, object, created, model, choices, usage } = this;
    return { id, object, created, model, choices, usage };
  }
}

export class ChatCompletionChunk {
  constructor(id, created, model, delta, finishReason = null) {
    this.id = id;
    this.object = "chat.completion.chunk";
    this.created = created;
    this.model = model;
    this.choices = [{ index: 0, delta, finish_reason: finishReason }];
  }

  get text() {
    return this.choices[0].delta.content || "";
  }

  toJSON() {
    const { id, object, created, model, choices } = this;
    return { id, object, created, model, choices };
  }
}
