// Provider registry and model-name resolution.
import { ModelNotFound } from "./errors.js";
import { BUILTIN, TAGS } from "./providers/builtin.js";
import { closeMatches, similarity } from "./util.js";

/** A ``provider/model`` pair, usable as a Map / Set key through ``String(t)``. */
export class Target {
  constructor(provider, model) {
    this.provider = provider;
    this.model = model;
  }

  toString() {
    return `${this.provider}/${this.model}`;
  }
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const tail = (id) => norm(id.split("/").pop().replace(":free", ""));

function dedupe(targets) {
  const seen = new Set();
  return targets.filter((t) => (seen.has(String(t)) ? false : (seen.add(String(t)), true)));
}

export class Registry {
  constructor(builtin = true) {
    this.providers = new Map();
    this._tags = new Map();
    this._extra = [];
    this._front = [];
    if (builtin) {
      for (const spec of BUILTIN) this.add(spec, { chain: false });
      for (const [k, v] of Object.entries(TAGS)) this._tags.set(k, v.map(([p, m]) => new Target(p, m)));
    }
  }

  add(spec, { front = false, chain = true } = {}) {
    this.providers.set(spec.name, spec);
    if (chain && spec.auto) (front ? this._front : this._extra).push(new Target(spec.name, spec.default));
  }

  /** Default fallback chain: custom-front, builtin defaults in rank order, custom. */
  chain() {
    const builtin = new Set(BUILTIN.map((s) => s.name));
    const core = [...this.providers].filter(([n, s]) => builtin.has(n) && s.auto).map(([n, s]) => new Target(n, s.default));
    return dedupe([...this._front, ...core, ...this._extra]);
  }

  tag(name) {
    return (this._tags.get(name) || []).filter((t) => {
      const m = this.modelSpec(t.provider, t.model);
      return this.providers.has(t.provider) && !(m && m.broken);
    });
  }

  tagAdd(name, target) {
    if (!this._tags.has(name)) this._tags.set(name, []);
    this._tags.get(name).push(target);
  }

  tagNames() {
    return [...this._tags.keys()];
  }

  catalog() {
    return [...this.providers].flatMap(([n, s]) => s.models.map((m) => new Target(n, m.id)));
  }

  modelSpec(provider, model) {
    return this.providers.get(provider)?.models.find((m) => m.id === model) ?? null;
  }

  tagsOf(target) {
    return [...this._tags].filter(([, v]) => v.some((t) => String(t) === String(target))).map(([k]) => k);
  }

  providerNames(head) {
    const h = head.trim().toLowerCase();
    if (this.providers.has(h)) return [h];
    return [...this.providers].filter(([, s]) => s.aliases.includes(h)).map(([n]) => n);
  }

  /** Map a user-facing ``model`` value to an ordered list of targets. */
  resolve(model) {
    if (model === null || model === undefined) return this.chain();
    if (typeof model !== "string") return dedupe([...model].flatMap((m) => this.resolve(m)));
    const q = model.trim();
    const low = q.toLowerCase();
    if (["", "auto", "default"].includes(low)) return this.chain();
    if (this._tags.has(low)) return this.tag(low);
    const slash = q.indexOf("/");
    const head = slash >= 0 ? q.slice(0, slash) : q;
    const names = this.providerNames(head);
    if (names.length) return this._inProviders(names, slash >= 0 ? q.slice(slash + 1).trim() : "");
    const hits = this._fuzzy(q);
    if (hits.length) return hits;
    throw new ModelNotFound(this._notFound(q));
  }

  _inProviders(names, rest) {
    const out = [];
    for (const n of names) {
      const spec = this.providers.get(n);
      if (!rest || ["auto", "default"].includes(rest.toLowerCase())) { out.push(new Target(n, spec.default)); continue; }
      const hits = this._fuzzy(rest, n);
      out.push(...(hits.length ? hits : [new Target(n, rest)])); // pass unknown ids through
    }
    return out;
  }

  _fuzzy(q, only = null) {
    const nq = norm(q);
    if (!nq) return [];
    const exact = [], partial = [];
    for (const [n, s] of this.providers) {
      if (only && n !== only) continue;
      for (const m of s.models) {
        if (m.broken) continue;
        const names = [m.id, ...m.aliases];
        const keys = new Set([...names.map(norm), ...names.map(tail)]);
        if (keys.has(nq)) exact.push(new Target(n, m.id));
        else if ([...keys].some((k) => k.includes(nq))) partial.push(new Target(n, m.id));
      }
    }
    return [...exact, ...partial]; // exact matches first, then looser ones as extra fallbacks
  }

  _notFound(q) {
    const ids = [...this.providers.values()].flatMap((s) => s.models.map((m) => m.id));
    const pool = [...this._tags.keys(), ...this.providers.keys(), ...ids];
    const low = q.toLowerCase();
    let close = closeMatches(low, pool, 3, 0.5);
    for (const i of ids) { // also compare against the vendor-less tail
      const t = i.split("/").pop().replace(":free", "");
      if (!close.includes(i) && similarity(low, t.toLowerCase().slice(0, q.length + 2)) > 0.75) close.push(i);
    }
    close = close.slice(0, 3);
    const hint = close.length ? ` Did you mean: ${close.map((c) => `'${c}'`).join(", ")}?` : "";
    return `unknown model '${q}'.${hint} Try llm.models() to list what is available.`;
  }
}
