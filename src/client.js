// The Client: one unified entry point with automatic fallback.
import * as cache from "./cache.js";
import { DEFAULT_UA, HTTPFailure, checkProxy, checkTransport } from "./http.js";
import { buildMessages } from "./messages.js";
import { fetchSpecs } from "./discover.js";
import { AllProvidersFailed, LLMFError, ModelNotFound, ProviderError } from "./errors.js";
import { ADAPTERS } from "./providers/index.js";
import { model as modelSpec, options as makeOptions, provider as providerSpec } from "./providers/base.js";
import { Registry, Target } from "./registry.js";
import { ChatCompletion, ChatCompletionChunk, HealthResult, ModelInfo, Reply } from "./types.js";
import { now, randomHex, sleep } from "./util.js";

const key = (t) => String(t);

/** Cooldown / rate-limit / latency bookkeeping. */
class State {
  constructor() {
    this.cool = new Map(); // provider name or "provider/model" -> monotonic deadline
    this.last = new Map(); // provider -> last reserved slot
    this.ewma = new Map(); // "provider/model" -> smoothed latency
    this.demoted = new Set();
    this.busy = new Map(); // provider -> requests in flight
  }

  enter(provider) {
    this.busy.set(provider, (this.busy.get(provider) ?? 0) + 1);
  }

  leave(provider) {
    this.busy.set(provider, Math.max(0, (this.busy.get(provider) ?? 0) - 1));
  }

  readyIn(t, minInterval) {
    const t0 = now();
    let wait = Math.max(this.cool.get(t.provider) ?? 0, this.cool.get(key(t)) ?? 0) - t0;
    wait = Math.max(wait, (this.last.get(t.provider) ?? -1e9) + minInterval - t0);
    return Math.max(0, wait);
  }

  /** Reserve a request slot; returns seconds to sleep before using it. */
  /** Reserve a request slot; resolves to seconds to sleep. ``dir`` enables cross-process pacing for slow providers. */
  rateWait(provider, minInterval, dir = null) {
    const t0 = now();
    const track = !!dir && minInterval >= cache.PACE_MIN_INTERVAL;
    if (track && !this.last.has(provider)) { // first use in this process: honour the previous process's slot
      const prev = cache.paceLast(dir, provider);
      const wall = Date.now() / 1000;
      if (prev !== null) this.last.set(provider, t0 - Math.min(Math.max(wall - prev, 0), minInterval + 60)); // a tampered file cannot stall us
    }
    const slot = Math.max(t0, (this.last.get(provider) ?? -1e9) + minInterval);
    this.last.set(provider, slot);
    if (track) cache.paceSet(dir, provider, Date.now() / 1000 + (slot - t0));
    return slot - t0;
  }

  fail(err) {
    this.cool.set(err.scope === "provider" ? err.provider : `${err.provider}/${err.model}`, now() + err.cooldown);
  }

  ok(t, latency = null) {
    this.cool.delete(t.provider);
    this.cool.delete(key(t));
    this.demoted.delete(key(t));
    if (latency !== null) {
      const old = this.ewma.get(key(t));
      this.ewma.set(key(t), old === undefined ? latency : 0.7 * old + 0.3 * latency);
    }
  }

  /** Apply earlier ``doctor`` results: failures are demoted, latencies pre-load the EWMA. */
  seed(rows) {
    for (const r of rows) {
      if (!r || r.provider == null || r.model == null) continue;
      const k = `${r.provider}/${r.model}`;
      if (r.ok) {
        if (!this.ewma.has(k)) this.ewma.set(k, Number(r.latency) || 2);
        this.demoted.delete(k);
      } else {
        this.demoted.add(k);
      }
    }
  }

  /** Models whose recent doctor success rate is low sink to the end of every plan. */
  demoteUnreliable(history) {
    for (const [k, h] of Object.entries(history)) if (cache.unreliable(h) && k.includes("/")) this.demoted.add(k);
  }

  /** Targets whose observed latency is <= ``maxLatency`` (not demoted), fastest first. */
  measured(maxLatency) {
    return [...this.ewma].filter(([k, v]) => v <= maxLatency && !this.demoted.has(k)).sort((a, b) => a[1] - b[1]).map(([k]) => k);
  }

  /** Ready targets first (stable); cooling, demoted, rate-slot-busy or *saturated* ones after. */
  order(targets, intervals, adaptive = false, caps = null) {
    const ready = [], later = [];
    targets.forEach((t, i) => {
      const full = !!caps && (this.busy.get(t.provider) ?? 0) >= (caps[t.provider] ?? Infinity);
      const bad = this.demoted.has(key(t)) || full || this.readyIn(t, intervals[t.provider] ?? 0) > 0;
      (bad ? later : ready).push([i, t]);
    });
    if (adaptive) ready.sort((x, y) => (this.ewma.get(key(x[1])) ?? 2) - (this.ewma.get(key(y[1])) ?? 2) || x[0] - y[0]);
    return [...ready.map((p) => p[1]), ...later.map((p) => p[1])];
  }
}

/** Async iterable of text chunks. After exhaustion, ``.reply`` holds the full answer. */
export class Stream {
  constructor(gen, onDone = null) {
    this.provider = "";
    this.model = "";
    this.reply = null;
    this._parts = [];
    this._onDone = onDone;
    this._it = gen(this);
  }

  async *[Symbol.asyncIterator]() {
    for await (const chunk of this._it) {
      this._parts.push(chunk);
      yield chunk;
    }
    if (this.reply && this._onDone) {
      const cb = this._onDone;
      this._onDone = null;
      cb(this.reply);
    }
  }

  get text() {
    return this._parts.join("");
  }

  async collect() {
    for await (const _ of this) { /* drain */ } // eslint-disable-line no-unused-vars
    return this.reply;
  }
}

/** Async iterable of :class:`ChatCompletionChunk` (what ``create({ stream: true })`` returns). */
export class ChatStream {
  constructor(stream) {
    this._stream = stream;
    this._it = this._gen();
  }

  async *_gen() {
    const id = "chatcmpl-" + randomHex(12), created = Math.floor(Date.now() / 1000);
    const it = this._stream[Symbol.asyncIterator]();
    const first = await it.next(); // fallback between providers happens here
    if (first.done) throw new AllProvidersFailed([], "empty stream");
    const model = `${this._stream.provider}/${this._stream.model}`;
    const chunk = (delta, finish = null) => new ChatCompletionChunk(id, created, model, delta, finish);
    yield chunk({ role: "assistant", content: "" });
    yield chunk({ content: first.value });
    for (let r = await it.next(); !r.done; r = await it.next()) yield chunk({ content: r.value });
    yield chunk({}, "stop");
  }

  [Symbol.asyncIterator]() {
    return this._it;
  }

  get text() {
    return this._stream.text;
  }

  get reply() {
    return this._stream.reply;
  }

  async collect() {
    for await (const _ of this) { /* drain */ } // eslint-disable-line no-unused-vars
    return ChatCompletion.fromReply(this._stream.reply);
  }
}

const FAST_SECONDS = 1.0; // a measured model at or under this latency may join the dynamic "fast" tag
const CHECK_PROMPT = "What is the capital of Vietnam? Answer in one short sentence.";

/** ``provider: "ovh", model: "qwen"`` -> ``"ovh/qwen"`` (provider alone -> its default). */
function join(provider, model) {
  if (!provider) return model;
  if (model != null && typeof model !== "string") throw new TypeError("provider cannot be combined with a list of models");
  return `${provider}/${model || ""}`;
}

export class Client {
  /**
   * @param {object} [o]
   * @param {string|string[]|null} [o.model] default model/alias for every call (null = automatic chain)
   * @param {number} [o.timeout=60] seconds per HTTP request
   * @param {number} [o.deadline=180] overall seconds budget for one call, across all fallbacks
   * @param {number} [o.maxAttempts=8] hard cap on tries per call
   * @param {number} [o.retries=1] extra passes over the candidates for *transient* errors
   * @param {number} [o.maxTokens=1024] default answer budget (reasoning models need >= 200)
   * @param {string[]} [o.only] / [o.exclude] restrict the providers that may be used
   * @param {boolean} [o.builtin=true] load the built-in provider catalogue
   * @param {string} [o.proxy] your own http://, https:// or socks4/4a/5/5h:// proxy URL (never picked or rotated for you)
   * @param {"ranked"|"adaptive"} [o.routing="ranked"] fixed fallback order, or fastest observed first
   * @param {number} [o.race=1] send each request to this many providers at once and keep the first answer
   *   (faster, but uses more of the free quotas)
   * @param {"node"|"curl"|"auto"} [o.transport="node"] "curl"/"auto": browser-like TLS via a ``curl-impersonate`` binary
   *   (LLMF_CURL_BIN or on PATH); "auto" falls back to node when it is missing. Still zero npm dependencies.
   * @param {string} [o.impersonate="chrome"] browser family for the curl transport (chrome, firefox, safari, edge)
   * @param {number} [o.maxInflight=6] simultaneous requests per provider before extra calls spill to the next one
   *   (a provider can set its own ``concurrency``)
   * @param {number} [o.visionTimeout=90] seconds per request when images are attached (image models are slow)
   * @param {boolean} [o.useCache=true] read/write the ``llmf doctor`` health cache (``LLMF_NO_CACHE=1`` disables)
   */
  constructor({ model = null, timeout = 60, deadline = 180, maxAttempts = 8, retries = 1, maxTokens = 1024,
    temperature = null, only = null, exclude = [], builtin = true, userAgent = DEFAULT_UA, proxy = null,
    routing = "ranked", race = 1, useCache = true, cacheDir = null, visionTimeout = 90, transport = "node", impersonate = "chrome", maxInflight = 6 } = {}) {
    Object.assign(this, { model, timeout, deadline, maxAttempts, retries, maxInflight: Math.max(1, Math.trunc(maxInflight)), maxTokens, temperature,
      only: only ? [...only] : null, exclude: [...exclude], userAgent, proxy: checkProxy(proxy),
      routing: Client._checkRouting(routing), race, useCache, cacheDir, visionTimeout,
      transport: checkTransport(transport), impersonate });
    this._reg = new Registry(builtin);
    this._state = new State();
    if (useCache) {
      this._state.seed(cache.load(this._cachePath()));
      this._state.demoteUnreliable(cache.loadHistory(this._cachePath()));
    }
    // OpenAI-style namespaces; each is also directly callable (llm.chat("hi"), llm.models()).
    this.chat = Object.assign((prompt, o) => this._chatImpl(prompt, o), { completions: { create: (p) => this._create(p) } });
    this.models = Object.assign((o) => this._modelsImpl(o), {
      list: (o) => this._modelsImpl(o),
      check: (o) => this._checkImpl(o),
      resolve: (m) => this._reg.resolve(m).map(String),
    });
    this.providers = Object.assign(() => this._providersImpl(), { list: () => this._providersImpl() });
    this.health = Object.assign(() => this._healthImpl(), { check: () => this._healthImpl() });
  }

  static _checkRouting(routing) {
    if (!["ranked", "adaptive"].includes(routing)) throw new TypeError("routing must be 'ranked' or 'adaptive'");
    return routing;
  }

  _net() {
    return { proxy: this.proxy, transport: this.transport, impersonate: this.impersonate };
  }

  _cachePath() {
    return this.cacheDir || cache.cacheDir();
  }

  /** Change settings in place, e.g. ``configure({ timeout: 30, exclude: ["blockrun"] })``. */
  configure(settings) {
    for (const [k, v] of Object.entries(settings)) {
      if (k.startsWith("_") || !(k in this) || typeof this[k] === "function") throw new TypeError(`unknown setting '${k}'`);
      this[k] = k === "proxy" ? checkProxy(v) : k === "transport" ? checkTransport(v) : k === "routing" ? Client._checkRouting(v) : ["only", "exclude"].includes(k) && v ? [...v] : v;
    }
    return this;
  }

  // ------------------------------------------------------------ registration
  /** Add your own OpenAI-compatible endpoint. ``baseUrl`` usually ends in ``/v1``. */
  register(name, baseUrl, models, { headers = {}, chatPath = "/chat/completions", kind = "openai", vision = false,
    minInterval = 0, front = false, auto = true, concurrency = 0, note = "custom" } = {}) {
    if (!(kind in ADAPTERS)) throw new TypeError(`kind must be one of ${Object.keys(ADAPTERS).sort().join(", ")}`);
    const ids = typeof models === "string" ? [models] : [...models];
    if (!ids.length) throw new TypeError("models must not be empty");
    if (baseUrl.replace(/\/+$/, "").endsWith("/chat/completions")) chatPath = "";
    const spec = providerSpec({ name, baseUrl, chatPath, kind, headers: { ...headers }, minInterval, note, auto, concurrency,
      models: ids.map((i) => modelSpec(i, { vision, verified: false })), defaultModel: ids[0] });
    this._reg.add(spec, { front });
    if (vision) this._reg.tagAdd("vision", new Target(name, spec.default));
    return spec;
  }

  /** Pull live keyless endpoints from the stillworks API and register them. */
  async discover({ limit = 5 } = {}) {
    let specs;
    try {
      specs = (await fetchSpecs({ timeout: this.timeout, userAgent: this.userAgent, ...this._net() })).slice(0, limit);
    } catch (e) {
      if (e instanceof HTTPFailure || e instanceof SyntaxError) throw new LLMFError(`discovery failed: ${e.message}`);
      throw e;
    }
    for (const s of specs) this._reg.add(s);
    return specs.map((s) => s.name);
  }

  // --------------------------------------------------------------- introspect
  _providersImpl() {
    return [...this._reg.providers.values()].map((s) => ({ name: s.name, baseUrl: s.chatUrl, kind: s.kind,
      defaultModel: s.default, models: s.models.map((m) => m.id), minInterval: s.minInterval, note: s.note }));
  }

  /** The model catalogue. ``live: true`` also asks each provider for the free *chat* ids it serves now. */
  async _modelsImpl({ live = false, includeNonChat = false } = {}) {
    const hist = this.useCache ? cache.loadHistory(this._cachePath()) : {};
    const out = this._reg.catalog().map((t) => {
      const m = this._reg.modelSpec(t.provider, t.model);
      const h = hist[key(t)] || "";
      return new ModelInfo(t.provider, t.model, { tags: this._reg.tagsOf(t), vision: !!m?.vision, verified: !!(m?.verified && !m?.broken),
        alive: cache.rate(h), samples: h.length, streaming: m ? m.streams !== false : true });
    });
    if (live) {
      const known = new Set(out.map((i) => i.name));
      for (const [name, ids] of Object.entries(await this._liveIds(!includeNonChat)))
        for (const id of ids) if (!known.has(`${name}/${id}`)) out.push(new ModelInfo(name, id, { verified: false }));
    }
    return out;
  }

  async _liveIds(chatOnly = true) {
    const specs = [...this._reg.providers.values()].filter((s) => s.modelsPath);
    const rows = await Promise.all(specs.map(async (s) => {
      try {
        return await ADAPTERS[s.kind].listModels(s, Math.min(this.timeout, 20), this.userAgent, this._net(), chatOnly);
      } catch (e) {
        if (e instanceof LLMFError) return [];
        throw e;
      }
    }));
    return Object.fromEntries(specs.map((s, i) => [s.name, rows[i]]));
  }

  /** Quick ping of every provider's default model. */
  async _healthImpl() {
    const msgs = buildMessages("Reply with the single word: ok");
    return Promise.all([...this._reg.providers.values()].map(async (s) => {
      const t0 = now();
      try {
        await ADAPTERS[s.kind].complete(s, s.default, msgs, this._options({ maxTokens: 256 }), Math.min(this.timeout, 30));
        return new HealthResult(s.name, s.default, true, now() - t0);
      } catch (e) {
        if (e instanceof LLMFError) return new HealthResult(s.name, s.default, false, now() - t0, e.detail ?? e.message);
        throw e;
      }
    }));
  }

  /** Call every catalogued model once (providers in parallel, models in sequence). */
  async _checkImpl({ providers = null, includeLive = false, includeLimited = false, includeNonChat = false, timeout = 30, visionTimeout = null,
    prompt = CHECK_PROMPT, onResult = null, save = true } = {}) {
    const reg = this._reg;
    let wanted = null;
    if (providers?.length) {
      wanted = new Set(providers.flatMap((p) => reg.providerNames(p)));
      if (!wanted.size) throw new ModelNotFound(`unknown provider(s): ${providers.join(", ")}`);
    }
    let targets = reg.catalog();
    if (includeLive) {
      const known = new Set(targets.map(key));
      for (const [name, ids] of Object.entries(await this._liveIds(!includeNonChat))) targets = targets.concat(ids.map((i) => new Target(name, i)).filter((t) => !known.has(key(t))));
    }
    const groups = new Map();
    for (const t of targets) {
      const spec = reg.providers.get(t.provider);
      if ((wanted && !wanted.has(t.provider)) || (!spec.checkable && !includeLimited)) continue;
      if (!groups.has(t.provider)) groups.set(t.provider, []);
      groups.get(t.provider).push(t);
    }
    const msgs = buildMessages(prompt);
    const opts = this._options({ maxTokens: 300 });
    const results = new Map();
    const vtimeout = visionTimeout ?? Math.max(timeout, 60); // image models are slow
    await Promise.all([...groups].map(async ([name, list]) => {
      const spec = reg.providers.get(name);
      for (const t of list) {
        if (spec.minInterval > 0) await sleep(this._state.rateWait(name, spec.minInterval, this.useCache ? this._cachePath() : null));
        const m = reg.modelSpec(t.provider, t.model);
        const t0 = now();
        let r;
        try {
          const comp = await ADAPTERS[spec.kind].complete(spec, t.model, msgs, opts, m?.vision ? vtimeout : timeout);
          r = new HealthResult(name, t.model, true, now() - t0, null, comp.text.split(/\s+/).filter(Boolean).join(" ").slice(0, 80), !!m?.verified);
        } catch (e) {
          if (!(e instanceof LLMFError)) throw e;
          r = new HealthResult(name, t.model, false, now() - t0, e.detail ?? e.message, null, !!m?.verified);
        }
        results.set(key(t), r);
        onResult?.(r);
      }
    }));
    const ordered = targets.map((t) => results.get(key(t))).filter(Boolean);
    const rows = ordered.map((r) => ({ provider: r.provider, model: r.model, ok: r.ok, latency: Math.round(r.latency * 1000) / 1000, error: r.error }));
    this._state.seed(rows);
    if (save && this.useCache && rows.length) {
      const merged = new Map(cache.load(this._cachePath()).map((r) => [`${r.provider}/${r.model}`, r]));
      for (const r of rows) merged.set(`${r.provider}/${r.model}`, r);
      cache.save(this._cachePath(), [...merged.values()]);
      cache.record(this._cachePath(), rows);
      this._state.demoteUnreliable(cache.loadHistory(this._cachePath()));
    }
    return ordered;
  }

  // ------------------------------------------------------------------ planning
  _options({ maxTokens = null, temperature = null, topP = null, json = false, tools = null, extra = {}, stop = null, proxy = null } = {}) {
    return makeOptions({ maxTokens: maxTokens ?? this.maxTokens, temperature: temperature ?? this.temperature,
      topP, stop, json, tools, extra, userAgent: this.userAgent, proxy: proxy ? checkProxy(proxy) : this.proxy,
      transport: this.transport, impersonate: this.impersonate });
  }

  _plan(model, fallback, vision) {
    const reg = this._reg;
    if (model === null || model === undefined) model = this.model;
    const base = vision ? reg.tag("vision") : reg.chain();
    const isFast = typeof model === "string" && model.trim().toLowerCase() === "fast";
    const targets = isFast ? reg.tag("fast") : model !== null && model !== undefined ? reg.resolve(model) : [...base];
    if (isFast) { // "fast" follows measurements: add anything measured quick, sorted by latency
      const catalog = new Set(reg.catalog().filter((t) => !reg.modelSpec(t.provider, t.model)?.broken).map(key));
      for (const k of this._state.measured(FAST_SECONDS)) {
        const t = reg.catalog().find((c) => key(c) === k);
        if (t && catalog.has(k) && !targets.some((x) => key(x) === k)) targets.push(t);
      }
    }
    if (fallback === null || fallback === undefined) fallback = model === null || model === undefined;
    if (fallback) targets.push(...base);
    const seen = new Set();
    const plan = [];
    for (const t of targets) {
      const ok = (!this.only || this.only.includes(t.provider)) && !this.exclude.includes(t.provider);
      if (ok && !seen.has(key(t))) { seen.add(key(t)); plan.push(t); }
    }
    if (!plan.length) throw new ModelNotFound("no usable provider after only/exclude filtering");
    return this._state.order(plan, this._intervals(), this.routing === "adaptive" || isFast);
  }

  /** Live re-ranking of what is left to try: busy / cooling providers go to the back. */
  _reorder(rest) {
    const caps = Object.fromEntries([...this._reg.providers].map(([n, s]) => [n, s.concurrency || this.maxInflight]));
    return this._state.order(rest, this._intervals(), false, caps);
  }

  _intervals() {
    return Object.fromEntries([...this._reg.providers].map(([n, s]) => [n, s.minInterval]));
  }

  _sequence(plan) {
    const seq = [];
    for (let i = 0; i < 1 + Math.max(0, this.retries); i++) seq.push(...plan);
    return seq.slice(0, this.maxAttempts);
  }

  _prepare(prompt, { system = null, images = null, model = null, provider = null, fallback = null }) {
    return [buildMessages(prompt, system, images), this._plan(join(provider, model), fallback, !!images?.length)];
  }

  /** Split call options into known knobs and provider-specific extras. */
  static _split(o = {}) {
    const { model, provider, system, images, maxTokens, temperature, topP, json, tools, fallback, stop, proxy, ...extra } = o;
    return { call: { model, provider, system, images, fallback }, gen: { maxTokens, temperature, topP, json: !!json, tools, stop, extra, proxy } };
  }

  async _throttle(spec, budget) {
    if (spec.minInterval > 0) {
      const wait = this._state.rateWait(spec.name, spec.minInterval, this.useCache ? this._cachePath() : null);
      if (wait > 0) await sleep(Math.min(wait, Math.max(0, budget - 1)));
    }
  }

  // ----------------------------------------------------------------- core: chat
  /** One try. Resolves to ``[Reply, null]`` or ``[null, ProviderError]`` (never rejects). */
  async _attempt(t, messages, opts, end, errors, attempts) {
    const spec = this._reg.providers.get(t.provider);
    this._state.enter(t.provider);
    try {
      await this._throttle(spec, end - now());
    } catch (e) { this._state.leave(t.provider); throw e; }
    const t0 = now();
    try {
      const comp = await ADAPTERS[spec.kind].complete(spec, t.model, messages, opts, Math.max(1, Math.min(opts.timeout || this.timeout, end - now())));
      const lat = now() - t0;
      this._state.ok(t, lat);
      attempts.push({ provider: t.provider, model: t.model, ok: true, latency: lat, error: null });
      return [new Reply(comp.text, { provider: t.provider, model: t.model, reasoning: comp.reasoning, usage: comp.usage,
        finishReason: comp.finishReason, toolCalls: comp.toolCalls, latency: lat, raw: comp.raw, attempts }), null];
    } catch (e) { // an adapter bug or a freak upstream answer must not abort the fallback chain
      const err = e instanceof ProviderError ? e : new ProviderError(t.provider, t.model, `unexpected ${e?.name}: ${e?.message}`, { code: "internal" });
      this._state.fail(err);
      errors.push(err);
      attempts.push({ provider: t.provider, model: t.model, ok: false, latency: now() - t0, error: err.message });
      return [null, err];
    } finally {
      this._state.leave(t.provider);
    }
  }

  /** Try ``batch`` concurrently; first success wins. Resolves to ``[reply, failures]``. */
  _runBatch(batch, messages, opts, end, errors, attempts) {
    if (batch.length === 1) {
      return this._attempt(batch[0], messages, opts, end, errors, attempts).then(([r, e]) => [r, e ? [[batch[0], e]] : []]);
    }
    return new Promise((resolve) => {
      const failures = [];
      let pending = batch.length, done = false;
      for (const t of batch) {
        this._attempt(t, messages, opts, end, errors, attempts).then(([r, e]) => {
          if (done) return; // losers finish in the background and are simply discarded
          if (r) { done = true; resolve([r, failures]); return; }
          failures.push([t, e]);
          if (--pending === 0) { done = true; resolve([null, failures]); }
        });
      }
    });
  }

  /** Ask a question; resolves to a :class:`Reply` (``String(reply)`` is the text). */
  async _chatImpl(prompt, o = {}) {
    const { call, gen } = Client._split(o);
    const [messages, plan] = this._prepare(prompt, call);
    const opts = this._options(gen);
    if (call.images?.length) opts.timeout = Math.max(this.timeout, this.visionTimeout);
    const width = Math.max(1, Math.trunc(o.race ?? this.race));
    const errors = [];
    const attempts = [];
    const dead = new Set();
    const end = now() + Math.max(this.deadline, (opts.timeout || 0) * 1.5);
    const seq = this._sequence(plan);
    let pos = 0, last = 0;
    while (pos < seq.length) {
      seq.splice(pos, seq.length - pos, ...this._reorder(seq.slice(pos)));
      const batch = [];
      while (pos < seq.length && batch.length < width) {
        const t = seq[pos++];
        if (!dead.has(key(t)) && !batch.some((b) => key(b) === key(t))) batch.push(t);
      }
      if (!batch.length) break;
      const left = end - now();
      if (left < 1) throw new AllProvidersFailed(errors, `deadline of ${this.deadline.toFixed(0)}s reached`);
      const pass = Math.floor((pos - 1) / plan.length);
      if (pass > last) { last = pass; await sleep(Math.min(1, left / 4)); } // starting another pass over the candidates
      const [reply, failures] = await this._runBatch(batch, messages, opts, end, errors, attempts);
      if (reply) return reply;
      for (const [t, e] of failures) if (e && !e.retryable) dead.add(key(t));
    }
    throw new AllProvidersFailed(errors);
  }

  /** ``llm.chat.completions.create({ messages, model, stream, ... })`` - the OpenAI-shaped entry point. */
  _create(params = {}) {
    const { messages, stream = false, n, max_completion_tokens, max_tokens, response_format, top_p, ...rest } = params;
    if (n != null && n !== 1) throw new TypeError("n > 1 is not supported");
    const o = { ...rest };
    if (rest.maxTokens == null && (max_tokens ?? max_completion_tokens) != null) o.maxTokens = max_tokens ?? max_completion_tokens;
    if (top_p != null && o.topP == null) o.topP = top_p;
    if (["json_object", "json_schema"].includes(response_format?.type) && o.json === undefined) o.json = true;
    if (!messages) throw new TypeError("messages is required");
    if (stream) return new ChatStream(this.stream(messages, o));
    return this._chatImpl(messages, o).then((r) => ChatCompletion.fromReply(r));
  }

  // --------------------------------------------------------------- core: stream
  /**
   * Like :meth:`chat` but yields text chunks as they arrive: ``for await (const piece of llm.stream("hi"))``.
   * Fallback happens only *before* the first chunk; after that a failure throws.
   */
  stream(prompt, o = {}, _onDone = null) {
    const { call, gen } = Client._split(o);
    const [messages, plan] = this._prepare(prompt, call);
    const opts = this._options(gen);
    if (call.images?.length) opts.timeout = Math.max(this.timeout, this.visionTimeout);
    const self = this;
    return new Stream(async function* (st) {
      const errors = [];
      const attempts = [];
      const dead = new Set();
      const end = now() + self.deadline;
      const seq = self._sequence(plan);
      for (let i = 0; i < seq.length; i++) {
        seq.splice(i, seq.length - i, ...self._reorder(seq.slice(i)));
        const t = seq[i];
        if (dead.has(key(t))) continue;
        const left = end - now();
        if (left < 1) throw new AllProvidersFailed(errors, `deadline of ${self.deadline.toFixed(0)}s reached`);
        if (i && i % plan.length === 0) await sleep(Math.min(1, left / 4));
        const spec = self._reg.providers.get(t.provider);
        await self._throttle(spec, left);
        self._state.enter(t.provider);
        let entered = true;
        const release = () => { if (entered) { entered = false; self._state.leave(t.provider); } };
        const t0 = now();
        const it = ADAPTERS[spec.kind].stream(spec, t.model, messages, opts, Math.min(opts.timeout || self.timeout, end - now()))[Symbol.asyncIterator]();
        let first;
        try {
          first = await it.next();
          if (first.done) throw new ProviderError(t.provider, t.model, "empty stream", { status: 200, code: "empty" });
        } catch (e) {
          await it.return?.();
          release();
          const err = e instanceof ProviderError ? e : new ProviderError(t.provider, t.model, `unexpected ${e?.name}: ${e?.message}`, { code: "internal" });
          self._state.fail(err);
          errors.push(err);
          attempts.push({ provider: t.provider, model: t.model, ok: false, latency: now() - t0, error: err.message });
          if (!err.retryable) dead.add(key(t));
          continue;
        }
        st.provider = t.provider;
        st.model = t.model;
        self._state.ok(t);
        yield first.value;
        try {
          for (;;) {
            const r = await it.next();
            if (r.done) break;
            yield r.value;
          }
        } catch (e) {
          if (e instanceof ProviderError) self._state.fail(e);
          throw e;
        } finally {
          await it.return?.();
          release();
        }
        const lat = now() - t0;
        attempts.push({ provider: t.provider, model: t.model, ok: true, latency: lat, error: null });
        st.reply = new Reply(st._parts.join("").trim(), { provider: t.provider, model: t.model, latency: lat, attempts });
        return;
      }
      throw new AllProvidersFailed(errors);
    }, _onDone);
  }

  session(system = null, defaults = {}) {
    return new Session(this, system, defaults);
  }
}

/** Multi-turn conversation that remembers history. */
export class Session {
  constructor(client, system = null, defaults = {}) {
    this._client = client;
    this.system = system;
    this.defaults = defaults;
    this.history = [];
  }

  reset() {
    this.history.length = 0;
  }

  _msgs(prompt) {
    return [...this.history, { role: "user", content: prompt }];
  }

  async chat(prompt, o = {}) {
    const reply = await this._client.chat(this._msgs(prompt), { system: this.system, ...this.defaults, ...o });
    this.history.push({ role: "user", content: prompt }, { role: "assistant", content: reply.text });
    return reply;
  }

  stream(prompt, o = {}) {
    return this._client.stream(this._msgs(prompt), { system: this.system, ...this.defaults, ...o }, (reply) =>
      this.history.push({ role: "user", content: prompt }, { role: "assistant", content: reply.text }));
  }
}
