# llmf (llmfree) — JavaScript / Node.js

**Free, keyless LLMs behind one call: with fallback, a vetted catalogue and an OpenAI-compatible server.**

[![npm](https://img.shields.io/npm/v/llmf?color=2ea44f)](https://www.npmjs.com/package/llmf)
[![Node](https://img.shields.io/node/v/llmf)](https://www.npmjs.com/package/llmf)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English · [Python package](https://github.com/MoonLite-Br/llmfree) · [PyPI `llmf`](https://pypi.org/project/llmf/)

```bash
npm install llmf
npx llmf-js "What is the capital of Vietnam?"
```

```js
import llmf from "llmf";
console.log(String(await llmf.chat("What is the capital of Vietnam?")));
```

No account, no API key, no provider setup. **Zero dependencies**, Node.js **≥ 18**, works on Linux, macOS, Windows and **Termux**.

> **Heads-up.** These are public, unofficial, free endpoints. They change, throttle or disappear without notice, and your prompts go to anonymous third parties. Do not send secrets. Run `llmf-js doctor` regularly. llmf is not affiliated with any provider.

This package is the **Node.js port** of the Python [`llmf`](https://pypi.org/project/llmf/) client. See [CHANGELOG.md](CHANGELOG.md).

## Features

| | |
|---|---|
| **One call** | `llmf.chat("...")` or OpenAI-shaped `llm.chat.completions.create(...)` |
| **Automatic fallback** | Cooldowns, retries, empty-answer detection, `AllProvidersFailed` |
| **Vetted catalogue** | Real-network thresholds; anything else still works as `provider/model` |
| **Doctor / survival** | `llmf-js doctor` → `~/.cache/llmf/` (compatible with the Python package) |
| **Routing** | `routing: "adaptive"`, `race: N` |
| **Aliases** | `fast`, `best`, `code`, `vision`, `reasoning` |
| **Proxy + SOCKS** | `http` / `https` / `socks4` / `socks4a` / `socks5` / `socks5h` (your proxy only) |
| **`llmf-js serve`** | Local OpenAI-compatible server (`node:http` only) |
| **`--public` / `--cloudflare`** | Internet profile: API keys, rate limits, bans, PoW / Turnstile, `--ui`, `--web`, `--app` |

## Install

```bash
npm install llmf
# global CLI (optional)
npm install -g llmf
llmf-js doctor
```

The binary is **`llmf-js`** so it can sit next to the Python `llmf` command. `npx llmf` still runs this package’s bin.

## Quick start

```js
import llmf, { LLMF } from "llmf";

console.log(String(await llmf.chat("What is the capital of Vietnam?")));

const llm = new LLMF({ timeout: 30, routing: "adaptive" });
const r = await llm.chat.completions.create({
  model: "best",
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "What is the capital of Vietnam?" },
  ],
  temperature: 0.3,
});
console.log(r.choices[0].message.content, r.model);
```

```js
for await (const piece of llmf.stream("Count from 1 to 5")) {
  process.stdout.write(String(piece));
}
```

## CLI

```bash
llmf-js "Explain the event loop"
llmf-js chat
llmf-js models | doctor | providers | health | version
llmf-js doctor --all
llmf-js -p ovh -m qwen --proxy socks5://127.0.0.1:1080 "hi"
llmf-js --stream --race 2 --routing adaptive "tell me a joke"
llmf-js serve
llmf-js serve --public --ui
llmf-js serve --cloudflare --ui
```

`llmf-js -h` matches the Python CLI layout and colours (disabled when not a TTY / `NO_COLOR` / `TERM=dumb`).

## `llmf-js serve`

```bash
llmf-js serve                          # http://127.0.0.1:8000/v1 — local only
llmf-js serve --public --ui            # 0.0.0.0 + API key + anti-bot + built-in chat
llmf-js serve --cloudflare --ui        # public URL via your cloudflared
llmf-js serve --app "node main.js" --app-port 3000 --cloudflare
```

| Flag | Role |
|------|------|
| `--public` | Internet profile: bind all interfaces, require API key, rate limits, bans, caps, security headers |
| `--cloudflare` / `--tunnel-token` | Your `cloudflared` tunnel; implies public hardening |
| `--ui` | Built-in chat page |
| `--web` / `--html` | One HTML file or static directory (path-safe) |
| `--app` / `--app-port` / `--app-dir` | Run and reverse-proxy your project |
| `--api-key` / `--api-keys-file` | Bearer keys |
| `--rate` / `--ip-rate` / `--session-rate` | Token buckets |
| `--allow-ip` / `--deny-ip` | CIDR lists |
| `--trust-proxy` | Client IP from `CF-Connecting-IP` / `X-Forwarded-For` (loopback peer only) |
| `--tls-cert` / `--tls-key` | HTTPS |
| `--antibot pow\|turnstile\|off` | Browser gate for web pages |
| `--log-file` | JSON-lines access log (prompts/keys never logged) |

Local default refuses DNS-rebinding (`Host`) and cross-site `Origin` unless allowed by `--cors` / `--cors-origin`.

```js
import OpenAI from "openai";
const c = new OpenAI({ baseURL: "http://127.0.0.1:8000/v1", apiKey: "x" });
await c.chat.completions.create({
  model: "best",
  messages: [{ role: "user", content: "hi" }],
});
```

## Configuration

```js
const llm = new LLMF({
  timeout: 30,
  deadline: 120,
  proxy: "socks5h://127.0.0.1:1080",
  routing: "adaptive",
  race: 2,
  transport: "auto",
  maxInflight: 6,
  visionTimeout: 90,
});
```

Env: `LLMF_MODEL`, `LLMF_TIMEOUT`, `LLMF_PROXY`, `LLMF_ROUTING`, `LLMF_TRANSPORT`, `LLMF_IMPERSONATE`, `LLMF_CACHE_DIR`, `LLMF_NO_CACHE=1`.

## Security

- Default `serve` is **loopback**. Use `--public` / `--cloudflare` only with keys and limits understood.
- Upstream URLs are `http(s)` only; bodies and streams are capped.
- Proxies are **yours only** — no public proxy scraping.
- Prompts to free endpoints are visible to those third parties — never send secrets.

Wiki (Python line, same product family): [Security](https://github.com/MoonLite-Br/llmfree/wiki/Security) · [Malware / false positives](https://github.com/MoonLite-Br/llmfree/wiki/Malware-and-false-positives)

## Related

| | |
|---|---|
| Python | [MoonLite-Br/llmfree](https://github.com/MoonLite-Br/llmfree) · [PyPI](https://pypi.org/project/llmf/) |
| This repo | [MoonLite-Br/llmfree-js](https://github.com/MoonLite-Br/llmfree-js) |
| npm | [llmf](https://www.npmjs.com/package/llmf) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |

## License

MIT © 2026 Html / MoonLite-Br
