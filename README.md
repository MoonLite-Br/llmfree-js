# llmf (llmfree) — JavaScript / Node.js

**Free, keyless LLMs behind one call: with fallback, a vetted catalogue and an OpenAI-compatible server.**

[![npm](https://img.shields.io/npm/v/llmf?color=2ea44f)](https://www.npmjs.com/package/llmf)
[![Node](https://img.shields.io/node/v/llmf)](https://www.npmjs.com/package/llmf)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English · [Python package](https://github.com/MoonLite-Br/llmfree) · [PyPI `llmf`](https://pypi.org/project/llmf/)

```bash
npm install llmf
# or
npx llmf-js "What is the capital of Vietnam?"
```

```js
import llmf from "llmf";
console.log(String(await llmf.chat("What is the capital of Vietnam?")));
```

No account, no API key, no provider setup. **Zero dependencies**, Node.js **≥ 18**, works on Linux, macOS, Windows and **Termux**.

> **Heads-up.** These are public, unofficial, free endpoints. They change, throttle or disappear without notice, and your prompts go to anonymous third parties. Do not send secrets. Run `llmf-js doctor` regularly. llmf is not affiliated with any provider.

This package is the **Node.js port** of the Python [`llmf`](https://pypi.org/project/llmf/) client. Version numbers track the same feature line as Python where applicable (see [CHANGELOG.md](CHANGELOG.md)).

## Contents

[Features](#features) · [Install](#install) · [Quick start](#quick-start) · [API](#api) · [CLI](#cli) · [Doctor](#llmf-js-doctor) · [Serve](#llmf-js-serve) · [Configuration](#configuration) · [Providers](#providers) · [Security](#security) · [Related](#related) · [License](#license)

## Features

| | |
|---|---|
| **One call** | `llmf.chat("...")` or OpenAI-shaped `llm.chat.completions.create(...)` |
| **Automatic fallback** | Cooldowns, retries, empty-answer detection, `AllProvidersFailed` with per-attempt errors |
| **Vetted catalogue** | Models listed only after real-network success thresholds; anything else still works as `provider/model` |
| **Doctor / survival** | `llmf-js doctor` records health under `~/.cache/llmf/` (compatible layout with the Python package) |
| **Routing** | `routing: "adaptive"` (latency EWMA), `race: N` (hedged parallel requests) |
| **Aliases** | `fast`, `best`, `code`, `vision`, `reasoning` |
| **Proxy + SOCKS** | `http` / `https` / `socks4` / `socks4a` / `socks5` / `socks5h` (your proxy only) |
| **Optional curl transport** | Browser-like TLS when a curl-backed transport is available; otherwise Node `fetch` / `http` |
| **`llmf-js serve`** | Local OpenAI-compatible HTTP server (`node:http` only — no Express) |

## Install

```bash
npm install llmf
```

Global CLI (optional):

```bash
npm install -g llmf
llmf-js doctor
```

The binary is named **`llmf-js`** so it can sit next to the Python `llmf` command without a clash. `npx llmf` still runs this package’s bin.

## Quick start

```js
import llmf, { LLMF } from "llmf";

// Module-level helper (shared client)
console.log(String(await llmf.chat("What is the capital of Vietnam?")));

// OpenAI-shaped client
const llm = new LLMF({ timeout: 30, routing: "adaptive" });
const r = await llm.chat.completions.create({
  model: "best",
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "What is the capital of Vietnam?" },
  ],
  temperature: 0.3,
});
console.log(r.choices[0].message.content);
console.log(r.model, r.usage, r.latency); // which provider/model answered
```

Streaming:

```js
for await (const piece of llmf.stream("Count from 1 to 5")) {
  process.stdout.write(String(piece));
}
```

Session (multi-turn):

```js
const s = llmf.session("Be brief.");
await s("My name is An");
console.log(String(await s("What is my name?")));
```

## API

```js
import llmf, {
  LLMF,
  chat, stream, session, models, providers, health, register, discover, configure,
  defaultClient, version, tools,
  LLMFError, ProviderError, AllProvidersFailed, ModelNotFound,
} from "llmf";

await llmf.chat("Hello");                          // → Reply (string-like + .provider .model .reasoning)
await llmf.chat.completions.create({ model: "best", messages: [...] });
await llmf.stream("...");                          // async iterable
llmf.session(system);                              // multi-turn
await llmf.models.check({ all: true });            // doctor
llmf.models.resolve("fast");
llmf.register("lab", "http://127.0.0.1:11434/v1", ["llama3"], { front: true });
```

Model selectors: `"best"` | `"fast"` | `"code"` | `"vision"` | `"reasoning"` | `"provider/model"` | fuzzy name | ordered array.

## CLI

```bash
llmf-js "Explain the event loop"
llmf-js ask "..." 
llmf-js chat                          # interactive (/reset, /exit)
llmf-js models | doctor | providers | health | version
llmf-js doctor --all
llmf-js -p ovh -m qwen --proxy socks5://127.0.0.1:1080 "hi"
llmf-js --stream --race 2 --routing adaptive "tell me a joke"
llmf-js serve [--host 127.0.0.1] [--port 8000] [--max-concurrent N] [--cors-origin URL]
```

## `llmf-js doctor`

Calls models for real and records results under `~/.cache/llmf/`:

```bash
llmf-js doctor
llmf-js doctor --all
llmf-js models
```

## `llmf-js serve`

OpenAI-compatible server on loopback by default (`node:http` only):

```bash
llmf-js serve
# POST /v1/chat/completions  GET /v1/models  GET /health
```

```js
import OpenAI from "openai";
const c = new OpenAI({ baseURL: "http://127.0.0.1:8000/v1", apiKey: "x" });
await c.chat.completions.create({
  model: "best",
  messages: [{ role: "user", content: "hi" }],
});
```

Local server checks include DNS-rebinding protection (foreign `Host` on loopback → 421) and cross-site `Origin` rejection unless allowed via `--cors` / `--cors-origin`.

## Configuration

```js
const llm = new LLMF({
  timeout: 30,
  deadline: 120,
  proxy: "socks5h://127.0.0.1:1080",
  routing: "adaptive",   // or "ranked"
  race: 2,
  transport: "auto",
  maxInflight: 6,
  visionTimeout: 90,
});
```

Environment: `LLMF_MODEL`, `LLMF_TIMEOUT`, `LLMF_PROXY`, `LLMF_ROUTING`, `LLMF_TRANSPORT`, `LLMF_IMPERSONATE`, `LLMF_CACHE_DIR`, `LLMF_NO_CACHE=1`.

## Providers

Built-in free/keyless endpoints with a vetted catalogue. Opt-in or tightly limited providers are documented in the changelog and source (`src/providers/`). Run `llmf-js models` / `doctor` on *your* network for what is alive today.

Add your own OpenAI-compatible base:

```js
llm.register("lab", "http://localhost:11434/v1", ["llama3"], { front: true });
```

## Security

- Default `serve` binds **loopback**; do not expose it to the internet without your own reverse proxy, TLS and auth.
- Upstream URLs are restricted to `http(s)`; response and stream sizes are capped.
- Proxies are **yours only** — llmf does not scrape or rotate public proxies.
- Prompts sent to free endpoints are visible to those third parties — never send secrets.

See also the Python project’s [Security wiki](https://github.com/MoonLite-Br/llmfree/wiki/Security) and [Malware / false positives](https://github.com/MoonLite-Br/llmfree/wiki/Malware-and-false-positives) notes (same product line).

## Related

| | |
|---|---|
| Python | [MoonLite-Br/llmfree](https://github.com/MoonLite-Br/llmfree) · [PyPI](https://pypi.org/project/llmf/) |
| This repo | [MoonLite-Br/llmfree-js](https://github.com/MoonLite-Br/llmfree-js) |
| npm | [llmf](https://www.npmjs.com/package/llmf) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |

## License

MIT © 2026 Html / MoonLite-Br
