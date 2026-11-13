<div align="center">

# llmf (llmfree) for Node.js

**Free, keyless LLMs behind one call: with fallback, a vetted catalogue and an OpenAI-compatible server.**

[![npm](https://img.shields.io/npm/v/llmf?color=2ea44f)](https://www.npmjs.com/package/llmf)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)

English · [Tiếng Việt](README.vi.md)

</div>

```bash
npm install -g llmf        # the command line: `llmf-js`
npm install llmf           # or as a library in your project
```

```js
import llmf from "llmf";
console.log(String(await llmf.chat("What is the capital of Vietnam?")));   // picks a live free endpoint, falls back on failure
```

No account, no API key, no provider setup. **Zero npm dependencies**, Node 18+, runs on Linux, macOS, Windows and **Termux/Android**
(`pkg install nodejs`). It is the Node port of the Python package [`llmf`](https://pypi.org/project/llmf/): same providers, same
catalogue, same flags, same `serve` options, same on-disk cache.

> **Heads-up.** These are public, unofficial, free endpoints. They change, throttle or disappear without notice, and your
> prompts go to anonymous third parties. Do not send secrets. Run `llmf-js doctor` regularly. llmf is not affiliated with any provider.

**Already have the Python `llmf`?** Install both. The npm package installs `llmf-js` only, so it never overwrites the Python `llmf`
command. They share the cache in `~/.cache/llmf/` and the `LLMF_*` environment variables. Give each `serve` its own `--port`.

## Contents

[Features](#features) · [Quick start](#quick-start) · [API](#api) · [Configuration](#configuration) · [CLI](#command-line) ·
[`doctor`](#llmf-js-doctor-trust-but-verify) · [`serve`](#llmf-js-serve-openai-compatible-server) · [Going public](#going-public) ·
[Security](#security-model) · [Providers](#providers) · [Error handling](#error-handling) · [Development](#development) · [License](#license)

## Features

| | |
|---|---|
| **One call** | `llmf.chat("...")`, or an OpenAI-shaped `llm.chat.completions.create({...})`: `choices`, `usage`, `stream: true`, `tools`, `response_format`. |
| **Automatic fallback** | Cooldowns per model / provider, retries, empty-answer and hidden-error detection, `AllProvidersFailed` with a per-attempt report. |
| **Vetted catalogue** | A model is listed only if it answered in 2+ independent real-network runs with 75 % success or better. Everything else still works as `provider/model`. |
| **Survival history** | Every `doctor` run is recorded; `llmf-js models` shows `alive 7/7`, `flaky 2/3`, `dead 0/3` and unreliable models sink automatically. |
| **Load-aware routing** | Per-provider concurrency caps; surplus calls spill to the next provider instead of queueing. `race: N` for the fastest of N. |
| **Aliases** | `fast`, `best`, `code`, `vision`, `reasoning`: ordered, re-ranked live from measured latency. |
| **Proxy + SOCKS** | `http`, `https`, `socks4/4a/5/5h`. Your own proxy only; llmf never scrapes or rotates public proxies. |
| **Optional browser-like TLS** | `transport: "auto"` uses a `curl-impersonate` binary when one is installed (no npm package involved). |
| **`llmf-js serve`** | OpenAI-compatible HTTP server for any app, extension or addon. It can be hardened and exposed to the internet (`--public`, `--cloudflare`). |
| **Web chat in one flag** | `--ui` built-in chat page, `--html page.html` to host your page, `--app "node main.js"` to run and proxy your own project. |
| **Cloudflare tunnel** | `--cloudflare` publishes the server through your own `cloudflared`, with the hardening profile switched on. |
| **Anti-bot** | Proof-of-work (default) or Cloudflare Turnstile before a browser visitor gets a short-lived, IP-bound session. |

## Quick start

```js
import { LLMF } from "llmf";

const llm = new LLMF();
const r = await llm.chat.completions.create({
  model: "best",
  messages: [{ role: "system", content: "Be brief." },
             { role: "user", content: "What is the capital of Vietnam?" }],
  temperature: 0.3,
});
console.log(r.choices[0].message.content);
console.log(r.model, r.usage.total_tokens, r.latency);   // r.model tells you which provider/model really answered
```

Migrating from the OpenAI SDK is a one-line change: construct `new LLMF()` instead of `new OpenAI()`.

## API

```js
import llmf from "llmf";

await llmf.chat("Hello");                                       // -> Reply: String(reply), .text .provider .model .reasoning .latency
for await (const piece of llmf.stream("Count from 1 to 5")) process.stdout.write(piece);
const s = llmf.session("Be brief"); await s.chat("My name is An"); await s.chat("What is my name?");   // keeps history
```

```js
llm.chat.completions.create({ model: "best", messages })                   // intent: fast | best | code | vision | reasoning
llm.chat.completions.create({ model: "ovh/Qwen3.5-397B-A17B", messages })  // exact: provider/model
llm.chat.completions.create({ model: "qwen", messages })                   // fuzzy name
llm.chat.completions.create({ model: ["best", "fast"], messages })         // ordered list
llm.chat("hi", { provider: "ovh" })                                        // provider default model
llm.models.resolve("fast")                                                 // what does this name expand to?
llm.chat.completions.create({ model: "vision", messages: [{ role: "user", content: [
  { type: "text", text: "What is in this picture?" },
  { type: "image_url", image_url: { url: "data:image/png;base64,..." } }] }] })
```

Add your own OpenAI-compatible endpoint: `llm.register("lab", "http://localhost:11434/v1", ["llama3"], { front: true })`.

## Configuration

```js
const llm = new LLMF({
  timeout: 30,                        // seconds per request
  deadline: 120,                      // total budget for one call, fallbacks included
  proxy: "socks5h://127.0.0.1:1080",  // your own proxy
  routing: "adaptive",                // "ranked" (fixed order) | "adaptive" (fastest first)
  race: 2,                            // ask 2 providers at once, first answer wins (uses quota N times faster)
  exclude: ["blockrun"],              // or only: ["ovh", "llm7"]
  transport: "auto",                  // "node" | "auto" | "curl"
  maxInflight: 6,                     // simultaneous requests per provider before spilling over
  visionTimeout: 90,
});
```

Every option can also be passed per call. Environment: `LLMF_MODEL`, `LLMF_TIMEOUT`, `LLMF_PROXY`, `LLMF_ROUTING`,
`LLMF_TRANSPORT`, `LLMF_CACHE_DIR`, `LLMF_NO_CACHE=1`.

<details><summary><b>Browser-like transport (optional)</b></summary>

Some endpoints inspect the TLS/HTTP2 fingerprint, which headers cannot change. If a `curl-impersonate` binary is on your `PATH`
(or `LLMF_CURL_BIN` points at it) use `transport: "curl"`, or `"auto"` to fall back to Node's own HTTP when it is missing.
`llmf-js -v version` shows the active engine.
</details>

## Speed

- Connections to a host are **kept alive and reused**, so repeated calls (chat sessions, `serve`, `doctor`) skip the TCP and TLS handshake; a connection the server dropped is retried once, invisibly. DNS answers are cached for 2 minutes and shared by concurrent calls, IPv4 first. `LLMF_NO_KEEPALIVE=1` turns reuse off.
- `llmf-js doctor` tests two models of a provider at a time (`--jobs N`, `--jobs 1` = one by one); providers with a minimum gap or a concurrency limit are still paced.
- Start-up does not load the network stack for commands that do not use it (`version`, `-h`, `models`, `providers`).
- Latency is dominated by the free endpoints themselves (a model that answers in 1 s on one run can take 7 s on the next), so compare two tools by alternating runs, not by running one after the other.

## Command line

```bash
llmf-js "Explain the event loop"                  # also: llmf-js ask "..."
cat code.js | llmf-js "Review this" -m code
llmf-js -p ovh -m qwen3.5-397b --proxy socks5://127.0.0.1:1080 "hi"
llmf-js chat                                      # interactive (/reset, /exit)
llmf-js --stream --race 2 --routing adaptive "tell me a joke"
llmf-js models | doctor | providers | health | serve | version
```

## `llmf-js doctor`: trust, but verify

The catalogue is a starting point; free endpoints change daily. `doctor` calls **every model once, for real** (providers in parallel):

```bash
llmf-js doctor                                    # the catalogue
llmf-js doctor --all                              # + every free chat model each provider lists
llmf-js doctor --all --include-non-chat           # + guard / whisper / tts / image / video ids (rarely useful)
llmf-js doctor -p ovh --timeout 20 --json
llmf-js models                                    # MODEL / TAGS / ALIVE / STATUS
```

```
OK    ovh/gpt-oss-120b                          1.70s  The capital of Vietnam is Hanoi.
FAIL  llm7/codestral-latest                     0.42s  HTTP 429: Rate limit exceeded. Retry after 1 seconds.
```

Results go to `~/.cache/llmf/` (24 h health, last-20 history), the same files the Python package uses. A model with 3+ samples and
under 50 % success is demoted automatically. Strictly quota-limited providers (`chatai`) are skipped unless `--include-limited`.

## `llmf-js serve`: OpenAI-compatible server

```bash
llmf-js serve                                     # http://127.0.0.1:8000/v1, local only, no auth
```

```js
import OpenAI from "openai";
const c = new OpenAI({ baseURL: "http://127.0.0.1:8000/v1", apiKey: "x" });
await c.chat.completions.create({ model: "best", messages: [{ role: "user", content: "hi" }] });
```

- `POST /v1/chat/completions` (streaming supported), `GET /v1/models`, `GET /health`.
- Unknown model names such as `gpt-4o` mean "automatic" (`--strict-models` returns 404); the response `model` field names the real provider/model.
- Load shedding: `--max-concurrent N` (default 48) answers `429 {"code":"busy"}` + `Retry-After: 1` rather than queueing; listen backlog 128.
- Free endpoints rate-limit themselves, so real throughput is theirs, not llmf's. Load-test with a moderate concurrency (5-10).

## Going public

```bash
llmf-js serve --cloudflare --ui                                   # web chat on a public https URL (needs `cloudflared`)
llmf-js serve --app "node main.js" --app-port 3000 --cloudflare   # your own Node project + AI
llmf-js serve --html /sdcard/download/index.html --ui --public    # host one HTML file (and only that file)
llmf-js serve --public --api-keys-file keys.txt \
              --tls-cert c.pem --tls-key k.pem --allow-ip 203.0.113.0/24   # your own server
```

| Flag | What it does |
|---|---|
| `--public` | Internet profile: binds `0.0.0.0`, API key **required** (one is generated and printed if you give none), rate limits, bans, body/token caps, anti-bot. |
| `--cloudflare` / `--tunnel-token T` | Quick tunnel (random `trycloudflare.com` URL) or your named tunnel, via your own `cloudflared` (Termux: `pkg install cloudflared`). Implies `--public` and `--trust-proxy`. |
| `--ui` | Built-in chat page (streaming, history in `localStorage`, safe text rendering). |
| `--web PATH` / `--html PATH` | Serve one file (nothing else from its folder) or a static directory (no `..`, dotfiles or symlink escape; SPA fallback). |
| `--app "CMD"` `--app-port N` `--app-dir D` | Start your project (receives `$PORT`, `$OPENAI_BASE_URL`, `$OPENAI_API_KEY`), wait until it listens, reverse-proxy it. |
| `--api-key K` (repeatable), `--api-keys-file F` | Bearer keys. |
| `--rate`, `--ip-rate`, `--session-rate` | Requests/min per key, per IP, per web visitor. |
| `--allow-ip`, `--deny-ip` | CIDR lists (repeatable). |
| `--trust-proxy` | Read the client IP from `CF-Connecting-IP` / `X-Forwarded-For`, **only from a loopback peer**. |
| `--cors`, `--cors-origin O` | All origins, or an allow-list. |
| `--max-body`, `--max-tokens-cap`, `--max-concurrent` | Size and concurrency caps. |
| `--tls-cert`, `--tls-key` | HTTPS (TLS 1.2+) with HSTS. |
| `--antibot pow\|turnstile\|off`, `--pow-bits N`, `--turnstile-secret/--turnstile-sitekey` | Visitor check for web pages. |
| `--log-file F` | JSON-lines access log (`-` = stderr). Prompts and keys are never logged. |
| `--csp POLICY` | `Content-Security-Policy` on every response. |

**Use it from your own page**

```html
<script src="/_llmf/client.js"></script>
<script>
  await llmf.stream([{role: "user", content: "Hello"}], {onDelta: (t, full) => out.textContent = full});
  // also: llmf.chat(messages) -> string, llmf.fetch(url, init) -> fetch() with the session attached
</script>
```

The script solves the proof of work in the background and holds a short-lived session token, so **no API key ever reaches the browser**.
Server-side callers use `Authorization: Bearer <key>`.

## Security model

What `--public` / `--cloudflare` switch on, and what they do **not** do.

- **Authentication**: constant-time key comparison; keys never logged (only a short hash id); repeated failures ban the IP for 15 min.
- **Abuse control**: token-bucket limits per key / IP / visitor, connection cap, request-size and `max_tokens` caps, header and request timeouts.
- **Anti-bot**: stateless HMAC-signed proof-of-work challenge (single use, expires in 2 min, difficulty rises for noisy IPs) → session token bound to the client IP, 30 min. Turnstile is verified server-side and **fails closed**. Web sessions cannot send images or tools and get tighter limits than API keys.
- **Web hygiene**: nosniff, no-referrer, frame protection, `Cache-Control: no-store` on API replies, strict CSP on the built-in UI, no HTML injection (text nodes only), no directory listing, generic error messages (no stack traces or upstream details).
- **Untrusted upstreams**: a redirect to another origin drops every credential header (only `Accept`, `Content-Type`, `User-Agent` survive), never goes from https to http, never leads from a public host into a local/private address (no SSRF through a provider), and never to a non-http(s) URL. A stream that sends only keep-alive comments is cut after the request timeout. Responses (also after gzip), lines and streams are size/time capped.
- **Terminal safety**: the `llmf-js` command strips control and escape characters from answers before printing them, so a malicious endpoint cannot change your terminal title, clear the screen or write to the clipboard (`--json` keeps the raw text, JSON-escaped).
- **Secrets**: the tunnel token is handed to `cloudflared` through the environment, not on the command line; the access log is created `0600`; proxy passwords are masked in every message. On a shared machine prefer `--api-keys-file` over `--api-key` (command-line arguments are visible in `ps`).
- **Local safety**: loopback servers refuse foreign `Host` headers (DNS rebinding) and cross-site `Origin`s; only `http(s)` URLs are fetched, also across redirects; responses, stream lines and stream duration are capped; remote text is stripped of terminal escapes; malformed requests get a small JSON error.
- **Proxy**: llmf credentials are stripped before forwarding to `--app`; client-supplied `X-Forwarded-*` is replaced; proxy headers are trusted only from loopback, so a LAN neighbour cannot spoof `CF-Connecting-IP`.
- **Not provided**: this is not a WAF or DDoS shield; put Cloudflare (or similar) in front for volumetric attacks. Quick-tunnel URLs change on every run. WebSocket upgrades are not proxied to `--app`. `--app` runs the command *you* give it. Proof of work raises the cost of scripted abuse; it does not make it impossible. Free upstreams still limit total throughput.

Found a vulnerability? Please open a private security advisory on GitHub rather than a public issue.

## Providers

Auto-selected fallback order: `ch-at → rewind-ai → ovh → kilo-openrouter → freeai → chatjimmy → kilo-gateway → pollinations → llm7 → blockrun → chatai`.
`nottrack`, `notrack-ai` and `apifreellm` are opt-in (`provider: "..."`).

| Provider | Typical models | Notes |
|---|---|---|
| `ch-at` | `gpt-4o` | No auth, single model, ~100 req/min documented. |
| `rewind-ai` | `qwen-2.5-7b-instruct`, `gpt-4o-mini` | Server-issued anonymous token. |
| `ovh` | `gpt-oss-120b`, `Qwen3.5-397B-A17B`, `Qwen2.5-VL-72B` (vision) | Fast and clean. |
| `kilo-openrouter`, `kilo-gateway` | Nemotron 3 Ultra 550B, north-mini-code, super-vl (vision), `kilo-auto/*` | ~200 req/h/IP; large models are slower. |
| `freeai` | `qwen7b` (Qwen 3.6 35B, vision), `qwen-coder`, `deepseek-r1` | Self-hosted free models; the site's OpenRouter list is paid. |
| `llm7` | `gpt-oss:20b`, `codestral-latest` | Quick; answers 429 under load. |
| `pollinations` | `openai` | 1 request / 15 s. |
| `chatjimmy` | `llama3.1-8B` | Extremely fast, non-streaming, a few requests/IP/day. |
| `blockrun` | Nemotron family, `llama-3.2-11b-vision` | ~12 s upstream timeout; flaky. |
| `chatai` | `claude-haiku-5.5`, `gemini-2.5-flash-lite`, … | Premium but ~3-5 requests/IP/day; last resort. |
| `nottrack` | `debate` | Opt-in (`nottrack.com`); several speakers, use `timeout >= 60`. |
| `notrack-ai` | `notrack-uncensored` | Opt-in (`notrack.ai`); anonymous, uncensored, quality varies; `persona: "concise\|normal\|detailed\|creative"`; fresh chat per call. |
| `apifreellm` | `apifree-community` | Opt-in; community tier, stateless single-turn, plain text, ~7 s; limited per IP (llmf spaces calls 21 s, even across commands). |

Run `llmf-js models` for what is alive on *your* network right now.

## Error handling

- Transient errors (network, 5xx, timeout) retry one round; 4xx/429 skip that target.
- `429` with "Retry after N" or "Please wait N seconds" → provider rests N+1 s; plain `429` → 60 s; capacity errors rest only that model for 10 min; "paid / premium / daily limit" → hours.
- Empty answers, errors hidden inside HTTP 200, `<think>` blocks (moved to `.reasoning`), stray blank lines and ChatJimmy stats are cleaned up.
- Out of options: `AllProvidersFailed` with `.errors`.

```js
import { AllProvidersFailed } from "llmf";
try { await llmf.chat("hi"); } catch (e) { if (e instanceof AllProvidersFailed) console.error(e.errors); else throw e; }
```

## Development

```bash
git clone https://github.com/MoonLite-Br/llmfree && cd llmfree
node bin/llmf-js.js --help
```

```
src/
  client.js        LLMF / Client, sessions, streams, fallback, routing, race, doctor
  registry.js      providers, vetted catalogue, aliases, name resolution
  providers/       builtin catalogue + adapters (OpenAI-compatible, ChatJimmy, ChatAI, NotTrack, NotTrack-AI, ApiFree)
  errors.js        error classification and cooldown policy
  http.js curl.js socks.js   transports (node, optional curl-impersonate, SOCKS)
  cache.js         health + survival history + cross-process pacing
  server.js        `llmf-js serve`: local and --public server, web chat, static/app hosting
  security.js      limits, bans, IP rules, PoW / Turnstile
  web.js tunnel.js static site + app proxy, Cloudflare tunnel
  web/             chat page + browser client
  cli.js           the `llmf-js` command
```

See [CHANGELOG.md](CHANGELOG.md). Contributions that add a provider should include a real-network `doctor` result.

## License

MIT © 2026 Html / MoonLite-Br
