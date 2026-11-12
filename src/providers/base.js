import { DEFAULT_UA, HTTPFailure, openUrl, decodeBody } from "../http.js";
import { ProviderError } from "../errors.js";

export function model(id, { vision = false, verified = true, aliases = [], note = "", broken = false, streams = true } = {}) {
  return { id, vision, verified, aliases, note, broken, streams };
}

export function provider(spec) {
  const s = {
    chatPath: "/v1/chat/completions", modelsPath: null, kind: "openai", headers: {}, models: [],
    defaultModel: null, minInterval: 0, aliases: [], freeSuffix: "", checkable: true, auto: true, concurrency: 0, note: "", ...spec,
  };
  Object.defineProperties(s, {
    chatUrl: { get() { return this.baseUrl.replace(/\/+$/, "") + this.chatPath; } },
    default: { get() { return this.defaultModel || this.models[0]?.id || "default"; } },
  });
  return s;
}

export function options(o = {}) {
  return { maxTokens: null, temperature: null, topP: null, stop: null, json: false, tools: null, extra: {},
    userAgent: DEFAULT_UA, proxy: null, transport: "node", impersonate: "chrome", timeout: null, ...o };
}

export function netOf(o = {}) {
  return { proxy: o.proxy ?? null, transport: o.transport ?? "node", impersonate: o.impersonate ?? "chrome" };
}

export function errorFromBody(body) {
  let obj;
  try { obj = JSON.parse(body); } catch { return [null, String(body).trim().slice(0, 300)]; }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return [null, String(body).trim().slice(0, 300)];
  const err = obj.error;
  let code = obj.error_type || obj.code;
  let msg = obj.message;
  if (err && typeof err === "object") {
    code = err.code || err.type || code;
    const inner = err.error;
    msg = err.message || (typeof inner === "string" ? inner : null) || msg;
  } else if (typeof err === "string") {
    msg = msg || err;
  }
  if (String(msg || "").toLowerCase().includes("daily limit")) code = "daily_limit";
  if (obj.debug && msg) msg = `${msg} (${obj.debug})`;
  return [code ? String(code) : null, String(msg || String(body).trim()).slice(0, 300)];
}

export async function translate(spec, model, fn) {
  try {
    return await (typeof fn === "function" ? fn() : fn);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (e instanceof HTTPFailure) {
      if (e.status !== null) {
        const [code, msg] = errorFromBody(e.body);
        throw new ProviderError(spec.name, model, `HTTP ${e.status}: ${msg || "HTTP " + e.status}`, { status: e.status, code });
      }
      throw new ProviderError(spec.name, model, `${e.kind}: ${e.body || e.kind}`);
    }
    if (e instanceof SyntaxError || e instanceof TypeError || e instanceof RangeError) {
      throw new ProviderError(spec.name, model, `unparsable response: ${e.name}: ${e.message}`);
    }
    throw e;
  }
}

export async function* guarded(spec, model, it) {
  for (;;) {
    const r = await translate(spec, model, () => it.next());
    if (r.done) return;
    yield r.value;
  }
}

export class Adapter {
  async complete() { throw new Error("not implemented"); }
  async *stream() { throw new Error("not implemented"); }

  async listModels(spec, timeout, userAgent = DEFAULT_UA, net = {}, chatOnly = true) {
    if (!spec.modelsPath) return [];
    const url = spec.baseUrl.replace(/\/+$/, "") + spec.modelsPath;
    const headers = { "User-Agent": userAgent, Accept: "application/json", ...spec.headers };
    return translate(spec, "(models)", async () => {
      const payload = JSON.parse(await decodeBody(await openUrl(url, { headers, timeout, ...netOf(net) })));
      return parseModelList(payload, spec.freeSuffix, chatOnly);
    });
  }
}

const NON_CHAT_TYPES = new Set(["image", "images", "audio", "video", "embedding", "embeddings", "speech", "tts", "stt",
  "transcription", "moderation", "rerank", "reranker", "ocr", "image-generation", "image_generation", "music", "3d"]);
const NON_CHAT_ID = new RegExp(
  "(whisper|tts\\b|\\btts|embed|rerank|diffusion|stable-?diffusion|sdxl|flux|dall-?e|imagen|midjourney|" +
  "\\bocr|ocr\\b|voxtral|seedance|kling|sora|veo\\b|\\bwan\\d|moderation|guard|safety|transcrib|speech|" +
  "text-to-|image-gen|-image\\b|/image|music|\\bbge-|\\be5-|lance-|" +
  "realesrgan|rmbg|demucs|deoldify|step1x|^sam$|madlad|upscal|inpaint)", "i");
const CHAT_CATEGORIES = new Set(["chat", "coding", "code", "reasoning", "vision", "text", "llm", "agent"]);

export function isChatModel(mid, item = null) {
  if (NON_CHAT_ID.test(mid)) return false;
  if (item && typeof item === "object") {
    const kind = String(item.type || item.task || item.category || "").toLowerCase();
    if (NON_CHAT_TYPES.has(kind)) return false;
    const arch = item.architecture && typeof item.architecture === "object" ? item.architecture : {};
    const outs = item.output_modalities || arch.output_modalities;
    if (Array.isArray(outs) && outs.length && !outs.map((o) => String(o).toLowerCase()).includes("text")) return false;
    const cats = item.categories;
    if (Array.isArray(cats) && cats.length && !cats.some((c) => CHAT_CATEGORIES.has(String(c).toLowerCase()))) return false;
  }
  return true;
}

function isFree(item) {
  if (!item || typeof item !== "object") return true;
  if ((item.billing_mode ?? "free") !== "free") return false;
  if ("self_hosted" in item && item.self_hosted !== true) return false;
  if (item.premium === true || item.paid === true) return false;
  if (["premium", "paid", "pro"].includes(String(item.tier || "").toLowerCase())) return false;
  const p = item.pricing;
  if (p && typeof p === "object") {
    for (const k of ["prompt", "completion", "input", "output"]) if (Number(p[k] || 0) > 0) return false;
  }
  return true;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/;

export function parseModelList(payload, freeSuffix = "", chatOnly = true) {
  const items = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.data ?? payload.models ?? [] : payload;
  const ids = [];
  for (const it of Array.isArray(items) ? items : []) {
    const mid = typeof it === "string" ? it : it && typeof it === "object" ? it.id || it.name : null;
    if (!mid || !isFree(it)) continue;
    if (freeSuffix && !String(mid).endsWith(freeSuffix)) continue;
    if (chatOnly && !isChatModel(String(mid), it)) continue;
    if (!SAFE_ID.test(String(mid))) continue;
    ids.push(String(mid));
  }
  return ids;
}
