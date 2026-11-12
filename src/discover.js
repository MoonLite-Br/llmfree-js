import { openUrl, decodeBody, DEFAULT_UA } from "./http.js";
import { model, provider } from "./providers/base.js";
import { isPublicHost } from "./util.js";

export const STILLWORKS_URL = "https://stillworks.supercapybara.com/api/llm/up";

function rows(payload) {
  if (Array.isArray(payload)) return payload.filter((r) => r && typeof r === "object");
  if (payload && typeof payload === "object") {
    for (const v of Object.values(payload)) if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
    if ("openai_base_url" in payload) return [payload];
  }
  return [];
}

const chatUrl = (url) => {
  url = url.replace(/\/+$/, "");
  return url.endsWith("/chat/completions") ? url : url + "/chat/completions";
};

export async function fetchSpecs({ timeout = 20, userAgent = DEFAULT_UA, url = STILLWORKS_URL, proxy = null, transport = "node", impersonate = "chrome" } = {}) {
  const payload = JSON.parse(await decodeBody(await openUrl(url, { headers: { "User-Agent": userAgent, Accept: "application/json" }, timeout, proxy, transport, impersonate })));
  const specs = [];
  const seen = new Set();
  for (const r of rows(payload)) {
    const base = r.openai_base_url, mid = r.model;
    if (!base || !mid || String(r.auth ?? "none").toLowerCase() !== "none") continue;
    const full = chatUrl(String(base));
    if (!/^https?:\/\//i.test(full)) continue;
    let parsed;
    try { parsed = new URL(full); } catch { continue; }

    if (parsed.username || parsed.password || !isPublicHost(parsed.hostname)) continue;
    if (!/^[\w.:/@+-]{1,100}$/.test(String(mid))) continue;
    const key = `${full}\n${mid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const caps = r.capabilities || {};
    let host = "endpoint";
    try { host = new URL(full).host || host; } catch { continue; }
    specs.push(provider({
      name: `sw-${host}-${specs.length}`, baseUrl: full, chatPath: "",
      models: [model(String(mid), { vision: !!(caps && typeof caps === "object" && caps.vision), verified: false })],
      note: "discovered via stillworks",
    }));
  }
  return specs;
}
