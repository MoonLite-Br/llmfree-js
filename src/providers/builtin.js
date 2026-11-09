// The built-in catalogue of free, keyless endpoints.
//
// Policy: a model is listed only if it answered in at least 2 independent real-network runs with a
// success rate >= 75%. Unknown ids still work (``provider/model`` passes through) and
// ``llmf doctor --all`` shows what else is live.
//
// Order of BUILTIN is the global fallback chain: fastest/cleanest first.
// Endpoints can disappear at any time - that is exactly why llmf falls back.
import { model as M, provider } from "./base.js";

const KILO_HEADERS = { Authorization: "Bearer anonymous", "X-KILOCODE-EDITORNAME": "kilo" };

export const BUILTIN = [
  provider({
    name: "ch-at",
    baseUrl: "https://ch.at",
    chatPath: "/v1/chat/completions",
    aliases: ["ch.at"],
    defaultModel: "gpt-4o",
    minInterval: 0.6, // documented 100 req/min, burst 10
    concurrency: 8,
    models: [M("gpt-4o", { aliases: ["gpt4o", "4o"] })],
    note: "GPT-4o, no auth, no /models endpoint (only gpt-4o). Documented 100 req/min.",
  }),
  provider({
    name: "rewind-ai",
    baseUrl: "https://api.rewind.ai",
    chatPath: "/v1/chat/completions/", // the trailing slash is required
    headers: { Origin: "https://rewind.ai" },
    aliases: ["rewind"],
    defaultModel: "qwen/qwen-2.5-7b-instruct",
    models: [M("qwen/qwen-2.5-7b-instruct", { aliases: ["qwen-2.5-7b"] }), M("gpt-4o-mini", { aliases: ["4o-mini"] })],
    note: "Anonymous JWT is issued by the server (30 days); 50/50 requests in 15 s passed.",
  }),
  provider({
    name: "ovh",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net",
    modelsPath: "/v1/models",
    aliases: ["ovhcloud"],
    defaultModel: "gpt-oss-120b",
    models: [M("gpt-oss-120b"), M("Qwen3.5-397B-A17B"), M("Qwen2.5-VL-72B-Instruct", { vision: true })],
    note: "Fast and clean. Anonymous tier of OVHcloud AI Endpoints.",
  }),
  provider({
    name: "kilo-openrouter",
    baseUrl: "https://api.kilo.ai",
    chatPath: "/api/openrouter/chat/completions",
    modelsPath: "/api/gateway/models",
    headers: KILO_HEADERS,
    aliases: ["kilo"],
    freeSuffix: ":free",
    defaultModel: "nvidia/nemotron-3-ultra-550b-a55b:free",
    models: [
      M("nvidia/nemotron-3-ultra-550b-a55b:free"),
      M("nvidia/nemotron-3.5-lightning:free"),
      M("cohere/north-mini-code:free"),
      M("nvidia/nemotron-3.5-super-vl:free", { vision: true }),
      M("dots-studio/dots-3-note-preview:free"),
    ],
    note: "Strongest free model. ~200 requests/hour/IP.",
  }),
  provider({
    name: "freeai",
    baseUrl: "https://api.free.ai",
    modelsPath: "/v1/models",
    aliases: ["free.ai"],
    defaultModel: "qwen7b",
    models: [
      M("qwen7b", { vision: true, aliases: ["qwen3.6", "qwen3.6-35b"], note: "actually Qwen 3.6 35B; handles vision (image input not yet verified)" }),
      M("qwen-coder", { note: "same base as qwen7b, code tuned (chat not yet verified)" }),
      M("deepseek-r1", { aliases: ["r1"], note: "reasoning; needs maxTokens >= 200" }),
    ],
    note: "Self-hosted free models (vLLM). The 500+ OpenRouter models on this site are paid.",
  }),
  provider({
    name: "chatjimmy",
    baseUrl: "https://chatjimmy.ai",
    chatPath: "/api/chat",
    modelsPath: "/api/models",
    kind: "chatjimmy",
    aliases: ["jimmy"],
    defaultModel: "llama3.1-8B",
    models: [M("llama3.1-8B", { aliases: ["llama3.1", "llama-3.1-8b"], streams: false, note: "extremely fast; replies in one piece" })],
    note: "Extremely fast Llama 3.1 8B; custom response format.",
  }),
  provider({
    name: "kilo-gateway",
    baseUrl: "https://api.kilo.ai",
    chatPath: "/api/gateway/chat/completions",
    modelsPath: "/api/gateway/models",
    aliases: ["kilo"],
    freeSuffix: ":free",
    defaultModel: "kilo-auto/free",
    models: [M("kilo-auto/free"), M("kilo-auto/small"), M("openrouter/free"), M("dots-studio/dots-3-note-preview:free")],
    note: "Auto-routing gateway; no headers needed.",
  }),
  provider({
    name: "pollinations",
    baseUrl: "https://text.pollinations.ai",
    chatPath: "/openai",
    modelsPath: "/models",
    aliases: ["poll"],
    minInterval: 15,
    concurrency: 1,
    defaultModel: "openai",
    models: [M("openai", { aliases: ["openai-fast", "gpt-oss", "gpt-oss-20b"] })],
    note: "Anonymous tier: 1 request / 15 s.",
  }),
  provider({
    name: "llm7",
    baseUrl: "https://api.llm7.io",
    modelsPath: "/v1/models",
    aliases: ["llm7.io"],
    defaultModel: "gpt-oss:20b",
    minInterval: 1.1, // 429 "Retry after 1 seconds" on back-to-back calls
    concurrency: 3,
    models: [M("gpt-oss:20b", { aliases: ["gpt-oss"] }), M("codestral-latest", { note: "code model, fast" })],
    note: "Stable and quick. Some larger/other models answer 429 (capacity).",
  }),
  provider({
    name: "blockrun",
    baseUrl: "https://blockrun.ai",
    chatPath: "/api/v1/chat/completions",
    modelsPath: "/api/v1/models",
    defaultModel: "nvidia/nemotron-3.5-lightning",
    models: [
      M("nvidia/nemotron-3.5-lightning"),
      M("nvidia/nemotron-3-ultra-550b", { note: "best quality but often 429 capacity / 10-50 s" }),
      M("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"),
      M("nvidia/llama-3.2-11b-vision", { vision: true }),
    ],
    note: "Upstream times out after ~12 s, so it can be flaky.",
  }),
  provider({
    name: "nottrack",
    baseUrl: "https://nottrack.com",
    chatPath: "/api/dispatch",
    kind: "nottrack",
    headers: { Origin: "https://nottrack.com" },
    aliases: ["nottrack-com", "nottrack.com"],
    defaultModel: "debate",
    models: [M("debate", { note: "multi-speaker, uncensored role-play; long replies" })],
    auto: false,
    checkable: false,
    note: 'Opt-in only (provider: "nottrack"): several speakers answer in a debate; use timeout >= 60 s.',
  }),
  provider({
    name: "notrack-ai",
    baseUrl: "https://notrack.ai",
    chatPath: "/api/dispatch",
    kind: "notrackai",
    aliases: ["notrack.ai"],
    defaultModel: "notrack-uncensored",
    models: [M("notrack-uncensored", { verified: false, note: "server's own name; uncensored, quality varies; persona: concise|normal|detailed|creative" })],
    concurrency: 1,
    auto: false,
    note: 'Opt-in (provider: "notrack-ai"): anonymous SSE chat, cookie bootstrap; each call is a fresh chat; has ads and unknown limits.',
  }),
  provider({
    name: "apifreellm",
    baseUrl: "https://apifreellm.com",
    chatPath: "/api/chatAPI",
    kind: "apifree",
    aliases: ["apifree", "apifreellm.com"],
    defaultModel: "apifree-community",
    models: [M("apifree-community", { streams: false, verified: false, note: "server's own name; stateless single-turn (history is flattened); ignores every option" })],
    minInterval: 21,
    concurrency: 1,
    auto: false,
    note: 'Opt-in (provider: "apifreellm"): community tier, 5 requests / 20 s / IP, 4-9 s per answer, plain text.',
  }),
  provider({
    name: "chatai",
    baseUrl: "https://chatai.org",
    chatPath: "/api/chat",
    kind: "chatai",
    defaultModel: "openai/gpt-5.6-luna",
    models: [M("openai/gpt-5.6-luna"), M("anthropic/claude-haiku-5.5"), M("google/gemini-2.5-flash-lite")],
    checkable: false,
    note: "Premium models but only ~3-5 requests/IP/day; last-resort in the chain.",
  }),
];

// Intent aliases -> ordered [provider, model] targets.
export const TAGS = {
  fast: [
    ["llm7", "codestral-latest"],
    ["chatjimmy", "llama3.1-8B"],
    ["llm7", "gpt-oss:20b"],
    ["pollinations", "openai"],
    ["kilo-gateway", "kilo-auto/small"],
  ],
  best: [
    ["ch-at", "gpt-4o"],
    ["kilo-openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free"],
    ["blockrun", "nvidia/nemotron-3-ultra-550b"],
    ["ovh", "gpt-oss-120b"],
    ["ovh", "Qwen3.5-397B-A17B"],
  ],
  code: [
    ["kilo-openrouter", "cohere/north-mini-code:free"],
    ["llm7", "codestral-latest"],
    ["ch-at", "gpt-4o"],
    ["freeai", "qwen-coder"],
    ["ovh", "Qwen3.5-397B-A17B"],
    ["kilo-openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free"],
  ],
  vision: [
    ["ovh", "Qwen2.5-VL-72B-Instruct"],
    ["kilo-openrouter", "nvidia/nemotron-3.5-super-vl:free"],
    ["freeai", "qwen7b"],
    ["blockrun", "nvidia/llama-3.2-11b-vision"], // last: often 429 capacity
  ],
  reasoning: [
    ["ovh", "gpt-oss-120b"],
    ["freeai", "deepseek-r1"],
    ["llm7", "gpt-oss:20b"],
    ["blockrun", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"],
  ],
};
