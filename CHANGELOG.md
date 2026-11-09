# Changelog

The npm package is a port of the Python package [`llmf`](https://pypi.org/project/llmf/) and follows its
changelog step by step: each version here adds the same feature as the Python release with the same number.
Where the JavaScript line differs, the entry says so.

## 0.6.3
Brings the Python 0.7.4 security audit that applies to the npm package (the public-server parts arrive with 0.7.0).
- **CLI name:** the npm package installs only `llmf-js` (no more `llmf` bin), so it lives next to the Python `llmf`
  command on the same machine without a clash. `npx llmf` still works (npx runs the package's only bin).
- **Local server vs. web pages**: `llmf-js serve` refuses DNS rebinding (a foreign `Host` on a loopback-bound
  server, 421) and cross-site browser requests (an `Origin` that is neither allowed by `--cors` /
  `--cors-origin URL` (repeatable) nor the server itself, 403). curl and the OpenAI SDKs send no `Origin` and are
  unaffected. Request / header timeouts on the socket.
- **Network hygiene**: only `http(s)` URLs are opened, also across redirects; bodies, lines and streams were already capped
  (32 MB also after gunzip, 1 MB per line, 15 min per stream).
- **Discovery** (`stillworks`) keeps only public http(s) hosts: loopback, LAN, link-local, CGNAT, `.local`, single-label
  names, credentials in the URL and odd model ids are dropped.

## 0.6.2
Brings the Python 0.7.2 and 0.7.3 features ahead of the 0.7.0 public-server work (still to come).
- Two **opt-in** providers (never in the automatic chain): `notrack-ai` (`notrack-uncensored`, cookie bootstrap, SSE,
  `persona: "concise|normal|detailed|creative"`, `--persona`) and `apifreellm` (`apifree-community`, plain text,
  stateless, one piece, 21 s gap). Use them with `provider: "notrack-ai"` / `provider: "apifreellm"`.
- "Please wait N seconds" makes the provider rest N+1 s instead of a flat 60 s.
- Pacing survives between processes: providers with a gap >= 5 s record their slot in `~/.cache/llmf/pace.json`
  (same file as the Python package; `LLMF_NO_CACHE=1` disables it; a tampered file cannot stall the client).

## 0.6.1
- Per-provider in-flight cap (`maxInflight`, default 6; a provider's own `concurrency` wins): a provider that is full
  moves to the back of the plan and extra calls spill to the next provider (live re-ranking while a call is running).
- `llmf serve --max-concurrent N` (default 48, `0` = unlimited): over the limit the server answers
  `429` / `busy` with `Retry-After: 1` instead of queueing without bound. `--max-inflight N` sets the client cap.

## 0.6.0
- **Vetted catalogue**: a model stays only if it answered in >= 2 independent real-network runs with >= 75 % success
  (see the 0.1.0 note: the removals of the Python line are already reflected in the npm catalogue). Ids that are not
  catalogued still work (`provider/model`) and show up with `llmf models --live`.
- **Survival history**: every `doctor` run is appended to `history.json` (last 20 results per model; same file format as
  the Python package). `llmf models` shows `alive 7/7` / `flaky 2/3` / `dead 0/3`; a model with >= 3 samples and < 50 %
  success sinks to the end of every plan. `ModelInfo.alive` / `.samples` expose the same.
- **Optional browser-like transport**: `new LLMF({ transport: "auto" | "curl", impersonate: "chrome" })`, `--transport`,
  `--impersonate`, `LLMF_TRANSPORT`, `LLMF_IMPERSONATE`. *Differs from Python:* there is no npm equivalent of
  `curl_cffi` that is light to install, so the npm package drives a `curl-impersonate` binary (`LLMF_CURL_BIN=...` or
  `curl_chrome*` / `curl_ff*` / `curl_safari*` on PATH) as a child process. Still **zero npm dependencies**; the built-in
  `node:http` transport stays the default and is what `auto` falls back to when no binary is found.
  `llmf -v version` prints the active transport.
- `vision` tag order: ovh Qwen2.5-VL -> kilo super-vl -> freeai qwen7b -> blockrun (last; often 429 capacity).
- `streams: false` / `ModelInfo.streaming`: `chatjimmy` is known to answer in one piece; `llmf models` shows `no-stream`
  and has a dedicated `ALIVE` column.
- "Retry after N seconds" now cools the provider down for N+1 s (was 3N+2).
- `live-run.js` has a `transport` group (skipped if no binary is found).

## 0.5.0
- New providers: `ch-at` (GPT-4o, no auth, no /models; first in the chain and in the `best` tag), `rewind-ai`
  (`qwen/qwen-2.5-7b-instruct`, `gpt-4o-mini`; trailing-slash path + `Origin` header) and `nottrack` (SSE "debate"
  endpoint, new `nottrack` adapter; **opt-in only**: never in the automatic chain).
- `auto: false` on a provider (also `register(..., { auto: false })`) keeps it out of the automatic chain; it is still
  usable with `provider: "..."`.
- BlockRun default model is `nemotron-3.5-lightning`; Pollinations `openai-fast` is an alias of `openai`.

## 0.4.1
- Capacity errors win over "paid model" wording ("no capacity, use a paid model" is a 10-minute pause for that model,
  not a paywall).
- A 429 that says `Retry after N seconds` is honoured: the provider rests for `3N + 2` s (capped at 5 min).
- Live-id filter also drops utility models (upscalers, background removal, stem separation, segmentation, translation).

## 0.4.0
- Error handling: a 429 is no longer one thing. Plain rate limit -> the provider sleeps 60 s; capacity /
  `ResourceExhausted` -> only that model sleeps 10 min; "use a paid model" -> only that model sleeps for hours.
- `models.list({ live: true })`, `doctor --all` and the `/models` parser keep **free chat** models only
  (no TTS / embedding / image / moderation entries); `includeNonChat` / `--include-non-chat` opts back in.
- `visionTimeout` (default 90 s): requests with images, and vision models in `doctor`, get a longer timeout.
- The `fast` alias is dynamic: models measured at <= 1 s join it, sorted by observed latency; failing ones sink.

## 0.3.0
- `freeai` models are `qwen7b` / `qwen-coder` / `deepseek-r1`; `/v1/models` is read from the `models` key and paid
  (non-self-hosted) models are ignored; `premium_requires_purchase` errors put the model to sleep for hours.
- Explicit `proxy` is never bypassed by `NO_PROXY`; proxy credentials in the URL are sent.
- Added `live-run.js`: end-to-end check of everything against the real internet, with a JSON report.
- **API**: OpenAI-shaped `llm.chat.completions.create({...})` returning `ChatCompletion` / `ChatStream`
  (`choices[0].message.content`, `usage`, `outputText`, async-iterable chunks); `llm.models.list/check/resolve`,
  `llm.providers.list`, `llm.health.check`. The shorthand (`llmf.chat("hi")`) still works, and so do the OpenAI
  snake_case parameters (`max_tokens`, `max_completion_tokens`, `top_p`, `response_format`).
- **SOCKS**: socks4 / socks4a / socks5 / socks5h proxies, pure Node (`node:net`), also through `ALL_PROXY`.
- **`llmf doctor`** / `models.check()`: really calls every model, optionally including live ids (`--all`);
  results are cached for 24 h in `~/.cache/llmf/health.json` (same file format as the Python package, so both can
  share it) and used to demote failing targets and rank by latency.
- **Routing**: `routing: "adaptive"` (latency EWMA) and `race: N` (parallel hedged requests).
- CLI: `ask`, `chat`, `models [list|check|resolve]`, `doctor`, table output, `--routing`, `--race`.

## 0.2.0
- New provider `chatai` (CSRF/session flow with a built-in cookie jar, SSE, respects the daily limit with a long cooldown).
- New `tools.askLangchainDocs()` (guest-token docs agent; not part of the chat chain).
- New `proxy` option on `Client` / `configure` / per call, `--proxy` CLI flag and `LLMF_PROXY` env (your own http/https proxy;
  plain HTTP uses an absolute-URI request, HTTPS uses CONNECT; the `HTTP(S)_PROXY` / `NO_PROXY` environment is honoured too).
- New `llmf serve`: local OpenAI-compatible server (chat completions + SSE streaming, models, health; localhost / no CORS
  by default, optional bearer key). `node:http` only, no Express.
- `-p/--provider` flag and `provider` option.
- Also installs the CLI as `llmf-js`, so it can live next to the Python `llmf` command without a clash.

## 0.1.0
- First release: unified `chat` / `stream` / `session` API (everything is `async`; streams are `for await`),
  8 built-in keyless providers (`ovh`, `kilo-openrouter`, `freeai`, `chatjimmy`, `kilo-gateway`, `pollinations`,
  `llm7`, `blockrun`), automatic fallback with cooldown and rate-limit awareness, CLI (`llmf`, alias `llmf-js`),
  optional stillworks discovery.
- Zero dependencies, ESM, Node >= 18. Own HTTP layer on `node:http` / `node:https`.
- The model catalogue is the vetted one from the Python 0.7 line from the start; models the Python line added and
  later removed never existed in this package.
