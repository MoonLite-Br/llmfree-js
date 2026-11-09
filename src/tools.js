// Optional single-purpose tools (not general chat providers).
//
// ``askLangchainDocs`` talks to the public "Chat LangChain" docs agent. It only answers LangChain /
// LangGraph / LangSmith / Deep Agents questions and refuses everything else, so it is deliberately
// *not* part of the ``chat`` chain.
import { DEFAULT_UA, HTTPFailure, checkProxy, decodeBody, openUrl } from "./http.js";
import { ProviderError } from "./errors.js";
import { Reply } from "./types.js";
import { now } from "./util.js";

export const LANGCHAIN_BACKEND = "https://chat-langchain-external-707c6e45e5075e168a6835a7d23a9934.us.langgraph.app";
const TOKEN_TTL = 23 * 3600 * 1000;
const NAME = "langchain-docs";
const tokens = new Map(); // "backend|proxy" -> { token, born }

/** A :class:`Reply` that also says whether the agent refused as off-topic. */
export class DocsReply extends Reply {
  offTopic = false;
}

async function call(url, token, payload, timeout, net, ua) {
  const headers = { "User-Agent": ua, Accept: "application/json", "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    return JSON.parse(await decodeBody(await openUrl(url, { headers, data: Buffer.from(JSON.stringify(payload ?? {})), timeout, ...net })));
  } catch (e) {
    if (e instanceof HTTPFailure) throw new ProviderError(NAME, "docs-agent", `HTTP ${e.status ?? e.kind}: ${String(e.body).slice(0, 200)}`, { status: e.status });
    if (e instanceof SyntaxError) throw new ProviderError(NAME, "docs-agent", `unparsable response: ${e.message}`);
    throw e;
  }
}

async function guestToken(backend, timeout, net, ua, force = false) {
  const key = `${backend}|${net.proxy || ""}`;
  const hit = tokens.get(key);
  if (hit && !force && Date.now() - hit.born < TOKEN_TTL) return hit.token;
  const obj = await call(`${backend}/identity/guest`, null, null, timeout, net, ua);
  const token = obj && typeof obj === "object" ? obj.token : null;
  if (!token) throw new ProviderError(NAME, "docs-agent", "no guest token (backend may have moved)");
  tokens.set(key, { token, born: Date.now() });
  return token;
}

function finalText(obj) {
  const ai = (obj.messages || []).filter((m) => m && typeof m === "object" && m.type === "ai");
  if (!ai.length) return "";
  const content = ai[ai.length - 1].content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.filter((p) => p && p.type === "text").map((p) => p.text ?? "").join("").trim();
  return "";
}

/**
 * Ask the LangChain docs agent. Resolves to a :class:`DocsReply` (``.offTopic`` flag).
 * Limits: ~10 requests/minute/IP and 5-15 s latency. The backend URL can change when LangChain
 * redeploys - pass ``backend`` if so.
 */
export async function askLangchainDocs(question, { backend = LANGCHAIN_BACKEND, timeout = 60, proxy = null, transport = "node", impersonate = "chrome", userAgent = DEFAULT_UA } = {}) {
  const net = { proxy, transport, impersonate };
  backend = backend.replace(/\/+$/, "");
  checkProxy(proxy);
  const t0 = now();
  let obj;
  for (const attempt of [0, 1]) {
    const token = await guestToken(backend, timeout, net, userAgent, !!attempt);
    try {
      const thread = await call(`${backend}/threads`, token, {}, timeout, net, userAgent);
      const tid = thread && typeof thread === "object" ? thread.thread_id : null;
      if (!tid || typeof tid !== "string") throw new ProviderError(NAME, "docs-agent", "no thread_id in response");
      obj = await call(`${backend}/threads/${encodeURIComponent(tid)}/runs/wait`, token,
        { assistant_id: "docs-agent", input: { messages: [{ role: "user", content: question }] } }, timeout, net, userAgent);
      break;
    } catch (e) {
      if (attempt === 0 && e instanceof ProviderError && [401, 403].includes(e.status)) continue; // expired guest token -> refresh once
      throw e;
    }
  }
  const text = obj && typeof obj === "object" ? finalText(obj) : "";
  if (!text) throw new ProviderError(NAME, "docs-agent", "empty answer", { status: 200, code: "empty" });
  let usage = null;
  for (const m of [...(obj.messages || [])].reverse()) if (m && typeof m === "object" && m.usage_metadata) { usage = m.usage_metadata; break; }
  const reply = new DocsReply(text, { provider: NAME, model: "docs-agent", usage, latency: now() - t0, raw: obj });
  reply.offTopic = !!obj.off_topic_query;
  return reply;
}
