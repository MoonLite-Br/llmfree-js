// Exception hierarchy for llmf.

const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** Remote text made safe to print: no control / escape characters, bounded length. */
export function cleanText(text, limit = 400) {
  return String(text).replace(CONTROL, "").slice(0, limit);
}

/** Base class for every error raised by llmf. */
export class LLMFError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

/** The requested model / alias / provider could not be resolved. */
export class ModelNotFound extends LLMFError {}

/**
 * A single provider/model attempt failed.
 *
 * Fields: provider, model, status (HTTP status or null), code (provider-specific),
 * retryable (may the *same* target help again?), scope ("provider" | "model"),
 * cooldown (seconds the target should be deprioritised).
 */
export class ProviderError extends LLMFError {
  constructor(provider, model, message, { status = null, code = null } = {}) {
    const clean = cleanText(message);
    super(`${provider}/${model}: ${clean}`);
    this.provider = provider;
    this.model = model;
    this.detail = clean; // the provider's message, without the "provider/model:" prefix
    this.status = status;
    this.code = code;
    [this.retryable, this.scope, this.cooldown] = classify(status, code, clean);
  }
}

/** Every candidate was tried and none produced an answer. */
export class AllProvidersFailed extends LLMFError {
  constructor(errors = [], note = "") {
    const list = [...errors];
    const lines = list.map((e) => `  - ${e.message}`);
    const head = "all providers failed" + (note ? ` (${note})` : "");
    super(head + ":\n" + (lines.length ? lines.join("\n") : "  (no candidates were available)"));
    this.errors = list;
  }
}

const RATE_CODES = ["rate_limit_error", "rate_limited", "rate_limit_exceeded"];
const TRANSIENT_CODES = ["FREE_MODEL_FAILED"];
// Free tiers refuse for three different reasons; each needs a different back-off:
const PAID_HINTS = ["paid model", "use a paid", "requires purchase", "purchased tokens", "upgrade your", "premium model", "payment required"];
const CAPACITY_HINTS = ["resourceexhausted", "resource exhausted", "resource_exhausted", "capacity", "overloaded", "no available server", "no capacity"];

function retryAfter(text) {
  const m = /(?:retry (?:after|in)|please wait)\s+(\d+(?:\.\d+)?)\s*(?:second|sec|s\b)/.exec(text);
  return m ? Number(m[1]) : null;
}

/** ``[retryable, scope, cooldownSeconds]`` for a failure. */
export function classify(status, code, message = "") {
  const text = (message || "").toLowerCase();
  if (code === "premium_requires_purchase") return [false, "model", 6 * 3600];
  if (code === "daily_limit") return [false, "provider", 6 * 3600];
  // Capacity wins over "paid": "no capacity, try a paid model" is a temporary overload, not a paywall.
  if (CAPACITY_HINTS.some((h) => text.includes(h))) return [false, "model", 600]; // only that model sleeps
  if (PAID_HINTS.some((h) => text.includes(h))) return [false, "model", 6 * 3600]; // a paid model: only that model sleeps
  const rate = status === 429 || RATE_CODES.includes(code || "");
  const wait = retryAfter(text);
  if (wait !== null && rate) return [false, "provider", Math.max(2, Math.min(wait + 1, 300))]; // the server told us how long
  if (rate) return [false, "provider", 60];
  if (status === null || status === undefined) return [true, "provider", 20];
  if (status === 408 || status === 425 || status >= 500) return [true, "provider", 20];
  if (TRANSIENT_CODES.includes(code)) return [true, "model", 20];
  return [false, "model", 30];
}
