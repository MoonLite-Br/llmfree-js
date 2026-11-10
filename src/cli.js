// Command line: ``llmf "your question"``.
import { parseArgs } from "node:util";
import fs from "node:fs";
import readline from "node:readline";
import { defaultClient } from "./index.js";
import { LLMFError } from "./errors.js";
import { version } from "./version.js";
import { describe } from "./curl.js";

const COMMANDS = ["ask", "chat", "models", "doctor", "providers", "health", "serve", "version"];

const HELP = `usage: llmf-js [options] "question"            ask once (also reads stdin)
       llmf-js chat                            interactive chat (/reset, /exit)
       llmf-js models [list|check|resolve NAME]  what exists / does it really work / what does NAME expand to
       llmf-js doctor [--all]                  call every model once and report (alias of \`models check\`)
       llmf-js providers | health              endpoints / quick ping
       llmf-js serve [--port N] [--public|--cloudflare] [--ui] [--html F] [--app CMD]
                                            OpenAI-compatible server
`;

// One table drives parsing, validation and --help (same flags and wording as the Python CLI).
const SPECS = [
  { name: "model", short: "m", help: "model, alias (fast/best/code/vision/reasoning) or provider/model" },
  { name: "provider", short: "p", help: "provider name (see `llmf-js providers`); combine with -m" },
  { name: "system", short: "s", help: "system prompt" },
  { name: "interactive", short: "i", bool: true, help: "interactive chat (REPL)" },
  { name: "image", multiple: true, help: "image path/URL (repeatable)" },
  { name: "max-tokens", type: "int" },
  { name: "temperature", short: "t", type: "float" },
  { name: "persona", choices: ["concise", "normal", "detailed", "creative"], help: "notrack-ai only: answer style" },
  { name: "stream", bool: true, help: "print the answer as it arrives" },
  { name: "json", bool: true, help: "machine-readable output" },
  { name: "live", bool: true, help: "models: also query providers live" },
  { name: "all", bool: true, help: "doctor: also test models found live (/models)" },
  { name: "include-limited", bool: true, help: "doctor: also test strictly quota-limited providers (e.g. chatai)" },
  { name: "include-non-chat", bool: true, help: "models/doctor --live/--all: keep TTS, embedding, guard, image... ids too" },
  { name: "no-save", bool: true, help: "doctor: do not write the health cache" },
  { name: "routing", choices: ["ranked", "adaptive"], help: "fallback order strategy" },
  { name: "race", type: "int", help: "send each request to N providers at once" },
  { name: "timeout", type: "float" },
  { name: "proxy", help: "proxy URL: http://, https://, socks5://, socks5h://, socks4://" },
  { name: "transport", choices: ["node", "auto", "curl"], help: "HTTP engine: node (default), auto (curl-impersonate if installed) or curl (browser TLS fingerprint)" },
  { name: "impersonate", help: "curl-impersonate browser profile (default: chrome)" },
  { name: "host", default: "127.0.0.1", help: "serve: bind address (default 127.0.0.1)" },
  { name: "port", type: "int", default: 8000, help: "serve: port (default 8000)" },
  { name: "max-concurrent", type: "int", help: "serve: chats in flight before answering 429 'busy' (0 = unlimited; default 48, public 32)" },
  { name: "max-inflight", type: "int", help: "per-provider simultaneous requests before spilling to the next provider (default 6)" },
  { name: "api-key", multiple: true, help: "serve: require this bearer key (repeatable)" },
  { name: "api-keys-file", help: "serve: file with one API key per line" },
  { name: "public", bool: true, help: "serve: internet-facing profile (bind 0.0.0.0, mandatory key, rate limits, bans, antibot)" },
  { name: "cloudflare", bool: true, help: "serve: expose through a Cloudflare quick tunnel (needs `cloudflared`; implies --public)" },
  { name: "tunnel-token", help: "serve: run a named Cloudflare tunnel with this token (implies --public)" },
  { name: "ui", bool: true, help: "serve: built-in AI chat web page" },
  { name: "web", alias: "html", metavar: "PATH", help: "serve: serve this HTML file (only that file) or static directory" },
  { name: "app", metavar: "CMD", help: 'serve: run your web app and proxy to it, e.g. --app "node main.js"' },
  { name: "app-port", type: "int", help: "serve: port the app listens on (default 3000; passed as $PORT)" },
  { name: "app-dir", help: "serve: working directory for --app" },
  { name: "rate", type: "float", help: "serve: requests/min per API key (public default 120)" },
  { name: "ip-rate", type: "float", help: "serve: requests/min per client IP (public default 240)" },
  { name: "session-rate", type: "float", help: "serve: chats/min per web visitor (default 12)" },
  { name: "allow-ip", multiple: true, help: "serve: only accept these IPs/CIDRs (repeatable)" },
  { name: "deny-ip", multiple: true, help: "serve: reject these IPs/CIDRs (repeatable)" },
  { name: "trust-proxy", bool: true, help: "serve: trust CF-Connecting-IP/X-Forwarded-For from a local proxy" },
  { name: "cors-origin", multiple: true, help: "serve: allow this browser origin (repeatable)" },
  { name: "max-body", type: "int", help: "serve: max request body in bytes (public default 1 MiB)" },
  { name: "max-tokens-cap", type: "int", help: "serve: clamp max_tokens (public default 4096)" },
  { name: "tls-cert", help: "serve: PEM certificate (HTTPS)" },
  { name: "tls-key", help: "serve: PEM private key" },
  { name: "log-file", help: "serve: JSON-lines access log ('-' = stderr); prompts are never logged" },
  { name: "csp", help: "serve: Content-Security-Policy header for every response" },
  { name: "antibot", choices: ["pow", "turnstile", "off"], help: "serve: web visitor check (public default pow)" },
  { name: "pow-bits", type: "int", help: "serve: proof-of-work difficulty (default 16 bits)" },
  { name: "turnstile-secret", help: "serve: Cloudflare Turnstile secret key" },
  { name: "turnstile-sitekey", help: "serve: Cloudflare Turnstile site key" },
  { name: "cors", bool: true, help: "serve: allow browser (CORS) access" },
  { name: "strict-models", bool: true, help: "serve: 404 on unknown model names" },
  { name: "no-fallback", bool: true, help: "serve: never switch model on failure" },
  { name: "verbose", short: "v", bool: true, help: "show provider/model used" },
  { name: "version", short: "V", bool: true, help: "show program's version number and exit" },
  { name: "help", short: "h", bool: true, help: "show this help message and exit" },
];

const OPTIONS = {};
for (const sp of SPECS) {
  OPTIONS[sp.name] = { type: sp.bool ? "boolean" : "string", ...(sp.short && { short: sp.short }), ...(sp.multiple && { multiple: true }) };
  if (sp.alias) OPTIONS[sp.alias] = { type: "string" };
}

const metavar = (sp) => sp.metavar || (sp.choices ? `{${sp.choices.join(",")}}` : sp.name.toUpperCase().replace(/-/g, "_"));

// Same rules as Python 3.14's argparse: colour only on a terminal, never with NO_COLOR / TERM=dumb, FORCE_COLOR forces it.
function useColor(stream = process.stdout) {
  const e = process.env;
  if (e.NO_COLOR) return false;
  if (e.FORCE_COLOR) return true;
  if (e.TERM === "dumb") return false;
  return !!stream.isTTY;
}
const ANSI = { reset: "\x1b[0m", heading: "\x1b[1;34m", usage: "\x1b[35m", short: "\x1b[1;32m", long: "\x1b[1;36m", label: "\x1b[1;33m", action: "\x1b[1;32m", prog: "\x1b[1;35m", error: "\x1b[1;31m" };
const paint = (on, kind, text) => (on ? `${ANSI[kind]}${text}${ANSI.reset}` : text);

/** argparse prints ``usage: `` + the custom usage text, which itself starts with ``usage:`` (same as the Python CLI). */
function usageBlock(color) {
  return `${paint(color, "heading", "usage:")} ${paint(color, "usage", HELP.trimEnd().replace(/\n/g, "\n"))}`;
}

function fullHelp(color = useColor()) {
  const cols = process.stdout.columns || Number(process.env.COLUMNS) || 80;
  const width = Math.max(cols - 2, 24 + 11);
  const wrap = (text, w) => { const out = []; let line = ""; for (const word of text.split(/\s+/)) { if (line && line.length + 1 + word.length > w) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word; } if (line) out.push(line); return out; };
  const lines = [usageBlock(color), "", "", "Free, keyless LLMs behind one command.", "", paint(color, "heading", "positional arguments:")];
  const row = (plain, colored, help) => {
    const h = wrap(help || "", width - 24);
    if (plain.length <= 20) lines.push(`  ${colored}${" ".repeat(22 - plain.length)}${h[0] || ""}`.trimEnd());
    else { lines.push(`  ${colored}`); if (h.length) lines.push(" ".repeat(24) + h[0]); }
    for (const extra of h.slice(1)) lines.push(" ".repeat(24) + extra);
  };
  row("words", paint(color, "action", "words"), `question, or one of: ${COMMANDS.join(", ")}`);
  lines.push("", paint(color, "heading", "options:"));
  const help = SPECS.find((sp) => sp.name === "help");
  for (const sp of [help, ...SPECS.filter((x) => x !== help)]) {
    const names = [...(sp.short ? [`-${sp.short}`] : []), `--${sp.name}`, ...(sp.alias ? [`--${sp.alias}`] : [])];
    const mv = sp.bool ? "" : ` ${metavar(sp)}`;
    const plain = names.join(", ") + mv;
    const colored = names.map((n) => paint(color, n.startsWith("--") ? "long" : "short", n)).join(", ") + (mv ? ` ${paint(color, "label", metavar(sp))}` : "");
    row(plain, colored, sp.help);
  }
  return lines.join("\n");
}

/** argparse-style failure: usage + ``llmf-js: error: ...`` on stderr, exit status 2. */
function argError(msg) {
  const color = useColor(process.stderr);
  console.error(usageBlock(color));
  console.error(`${paint(color, "prog", "llmf-js:")} ${paint(color, "error", "error:")} ${msg}`);
  return 2;
}

/** Turn parseArgs output into typed values (ints, floats, choices) like argparse would. Returns ``[values, error]``. */
function typed(values) {
  const out = {};
  for (const sp of SPECS) {
    let v = values[sp.name];
    if (sp.alias && v === undefined) v = values[sp.alias];
    if (v === undefined) { if (sp.default !== undefined) v = sp.default; else continue; }
    const flag = `--${sp.name}`;
    if (sp.choices && !sp.choices.includes(v)) return [null, `argument ${flag}: invalid choice: '${v}' (choose from ${sp.choices.map((c) => `'${c}'`).join(", ")})`];
    if (sp.type === "int" && !/^[+-]?\d+$/.test(String(v))) return [null, `argument ${flag}: invalid int value: '${v}'`];
    if (sp.type === "float" && !(String(v).trim() !== "" && Number.isFinite(Number(v)))) return [null, `argument ${flag}: invalid float value: '${v}'`];
    out[sp.name] = sp.type ? Number(v) : v;
  }
  return [out, null];
}

function table(rows, header) {
  const all = [header, ...rows];
  const w = header.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  for (const r of all) console.log(r.map((c, i) => String(c).padEnd(w[i])).join("  ").trimEnd());
}

async function ask(a, prompt, history = []) {
  const c = defaultClient();
  const o = { model: a.model, provider: a.provider, system: a.system, maxTokens: a["max-tokens"], temperature: a.temperature };
  if (a.race) o.race = a.race;
  if (a.persona) o.persona = a.persona;
  if (a.image?.length) o.images = a.image;
  const msgs = [...history, { role: "user", content: prompt }];
  let text, src;
  if (a.stream && !a.json) {
    const st = c.stream(msgs, o);
    for await (const piece of st) process.stdout.write(piece);
    process.stdout.write("\n");
    text = st.reply ? st.reply.text : st.text;
    src = st.reply ? st.reply.source : "";
  } else {
    const r = await c.chat(msgs, o);
    text = r.text;
    src = r.source;
    if (a.json) console.log(JSON.stringify({ text, provider: r.provider, model: r.model, reasoning: r.reasoning, usage: r.usage, latency: Math.round(r.latency * 1000) / 1000 }));
    else console.log(text);
  }
  if (a.verbose && src) console.error(`[${src}]`);
  return text;
}

async function doctor(a, c) {
  let ok = 0, bad = 0;
  const show = (r) => {
    if (r.ok) ok++; else bad++;
    if (!a.json) console.log(`${r.ok ? "OK" : "FAIL"}`.padEnd(5), r.name.padEnd(58), `${r.latency.toFixed(2)}s`.padStart(7), " ", (r.ok ? r.answer : r.error) || "");
  };
  if (!a.json) console.error("Testing every model once (providers in parallel)...");
  const results = await c.models.check({ providers: a.provider ? [a.provider] : null, includeLive: a.all, includeNonChat: a["include-non-chat"], includeLimited: a["include-limited"],
    timeout: a.timeout || 30, save: !a["no-save"], onResult: show });
  if (a.json) console.log(JSON.stringify(results.map((r) => ({ name: r.name, ok: r.ok, latency: Math.round(r.latency * 1000) / 1000, answer: r.answer, error: r.error })), null, 2));
  else console.error(`\n${ok} ok, ${bad} failed${!a["no-save"] && c.useCache && c._cachePath() ? `  (saved: ${c._cachePath()})` : ""}`);
  return ok ? 0 : 1;
}

async function repl(a) {
  const history = [];
  console.error(`llmf-js ${version} - /reset clears history, /exit quits`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === "/exit" || line === "/quit") break;
    if (line === "/reset") history.length = 0;
    else if (line) {
      try {
        const text = await ask(a, line, history);
        history.push({ role: "user", content: line }, { role: "assistant", content: text });
      } catch (e) {
        if (!(e instanceof LLMFError)) throw e;
        console.error(`error: ${e.message}`);
      }
    }
    rl.prompt();
  }
  rl.close();
  return 0;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s.trim();
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    if (e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") return argError(`unrecognized arguments: ${/'([^']+)'/.exec(e.message)?.[1] ?? e.message}`);
    if (e.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") return argError(`${/'([^']+)'/.exec(e.message)?.[1] ?? "option"}: expected one argument`);
    return argError(e.message);
  }
  const [a, bad] = typed(parsed.values);
  if (bad) return argError(bad);
  const words = parsed.positionals;
  if (a.help) { console.log(fullHelp()); return 0; }
  if (a.version) { console.log(`llmf-js ${version}`); return 0; }
  const c = defaultClient();
  try {
    if (a.timeout) c.configure({ timeout: a.timeout });
    if (a.proxy) c.configure({ proxy: a.proxy });
    if (a.routing) c.configure({ routing: a.routing });
    if (a.transport) c.configure({ transport: a.transport });
    if (a.impersonate) c.configure({ impersonate: a.impersonate });
  } catch (e) { console.error(`error: ${e.message}`); return 2; }
  const cmd = words.length && COMMANDS.includes(words[0]) && (["ask", "chat", "models"].includes(words[0]) || words.length === 1) ? words[0] : null;
  try {
    if (cmd === "version") {
      console.log(version);
      if (a.verbose) console.log(`node ${process.version}, transport: ${describe(c.transport, c.impersonate)}`);
    }
    else if (cmd === "doctor") return await doctor(a, c);
    else if (cmd === "serve") {
      const { serve } = await import("./server.js");
      if (a.model) c.configure({ model: a.provider ? `${a.provider}/${a.model}` : a.model });
      else if (a.provider) c.configure({ model: a.provider });
      if (a["max-inflight"] !== undefined) c.configure({ maxInflight: a["max-inflight"] });
      const keys = [...(a["api-key"] || [])];
      if (a["api-keys-file"]) {
        try { keys.push(...fs.readFileSync(a["api-keys-file"], "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))); } catch (e) {
          console.error(`error: cannot read ${a["api-keys-file"]}: ${e.code === "ENOENT" ? "No such file or directory" : e.message}`);
          return 2;
        }
      }
      const tunnelled = a.cloudflare || !!a["tunnel-token"];
      const isPublic = a.public || tunnelled;
      if (tunnelled && !(a.web || a.app || a.ui)) a.ui = true;
      const explicitHost = parsed.values.host !== undefined;
      const opts = {
        corsOrigins: a["cors-origin"], cloudflare: a.cloudflare, tunnelToken: a["tunnel-token"], ui: a.ui, web: a.web, app: a.app, appPort: a["app-port"],
        appDir: a["app-dir"], rate: a.rate, ipRate: a["ip-rate"], sessionRate: a["session-rate"], allowIp: a["allow-ip"], denyIp: a["deny-ip"],
        trustProxy: a["trust-proxy"], maxBody: a["max-body"], maxTokensCap: a["max-tokens-cap"], tlsCert: a["tls-cert"], tlsKey: a["tls-key"],
        logFile: a["log-file"], csp: a.csp, antibot: a.antibot, powBits: a["pow-bits"], turnstileSecret: a["turnstile-secret"],
        turnstileSitekey: a["turnstile-sitekey"], public: isPublic || undefined, maxConcurrent: a["max-concurrent"],
      };
      for (const k of Object.keys(opts)) if (opts[k] === undefined || opts[k] === false) delete opts[k];
      let server;
      try {
        server = await serve(c, { host: explicitHost ? a.host : undefined, port: a.port, apiKey: keys.length ? keys : null, cors: a.cors, strictModels: a["strict-models"], fallback: !a["no-fallback"], ...opts });
      } catch (e) {
        if (e instanceof TypeError || e.code === "ELLMF") { console.error(`error: ${e.message}`); return 2; }
        const hint = e.code === "EADDRINUSE" ? "  (the port is already in use: pick another with --port)" : /^\d+$/.test(String(a.host)) ? `  (did you mean \`--port ${a.host}\`? --host expects an address such as 127.0.0.1 or 0.0.0.0)` : "";
        console.error(`error: cannot listen on ${a.host}:${a.port}: ${e.syscall ? `${e.code}: ${e.message}` : e.message}${hint}`);
        return 2;
      }
      const cfg = server.llmf;
      const bound = server.address();
      const host = explicitHost ? a.host : isPublic && !tunnelled ? "0.0.0.0" : "127.0.0.1";
      const scheme = cfg.tls ? "https" : "http";
      const shown = ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host;
      const say = (m = "") => console.error(m);
      say(`llmf-js serving on ${scheme}://${shown}:${bound.port}  (Ctrl+C to stop)`);
      say(`  API        ${scheme}://${shown}:${bound.port}/v1`);
      if (cfg.ui) say(`  chat UI    ${scheme}://${shown}:${bound.port}/${cfg.static || cfg.appPort !== null ? "chat" : ""}`);
      if (cfg.static) say(`  web        ${cfg.static.describe()}`);
      if (a.app) say(`  app        ${a.app}  (port ${cfg.appPort})`);
      if (cfg.publicUrl) say(`  public     ${cfg.publicUrl}`);
      else if (a["tunnel-token"]) say("  public     (named tunnel running: use the hostname you configured in Cloudflare)");
      if (!["127.0.0.1", "localhost", "::1"].includes(host) || tunnelled || cfg.public) {
        if (cfg.generatedKey) say(`  api key    ${cfg.generatedKey}   (generated for this run; pass --api-key to choose your own)`);
        const rate = (rl) => (rl.rate * 60 ? Math.round(rl.rate * 6000) / 100 : "off");
        say(`  security   auth ${cfg.requireAuth ? "required" : "off"} | rate ${rate(cfg.keyLimiter)}/min per key, ${rate(cfg.ipLimiter)}/min per IP | ban after ${cfg.bans.after || "off"} auth failures | antibot ${cfg.antibot ? cfg.antibot.mode : "-"}`);
        if (host === "0.0.0.0" && !cfg.tls && !tunnelled) say("  note       plain HTTP on all interfaces: put it behind HTTPS (--cloudflare, a reverse proxy, or --tls-cert/--tls-key) before sharing it");
      }
      await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
      return 0;
    } else if (cmd === "providers") {
      const rows = c.providers.list();
      if (a.json) console.log(JSON.stringify(rows, null, 2));
      else table(rows.map((r) => [r.name, r.defaultModel, r.minInterval ? `${r.minInterval}s` : "", r.note]), ["PROVIDER", "DEFAULT MODEL", "MIN GAP", "NOTE"]);
    } else if (cmd === "models") {
      const sub = words[1] || "list";
      if (sub === "list") {
        const rows = await c.models.list({ live: a.live, includeNonChat: a["include-non-chat"] });
        const alive = (m) => {
          if (!m.samples) return "-";
          const ok = Math.round(m.alive * m.samples);
          return `${m.alive >= 0.75 ? "alive" : m.alive >= 0.5 ? "flaky" : "dead"} ${ok}/${m.samples}`;
        };
        if (a.json) console.log(JSON.stringify(rows.map((m) => ({ name: m.name, tags: m.tags, vision: m.vision, verified: m.verified, alive: m.alive, samples: m.samples, streaming: m.streaming })), null, 2));
        else table(rows.map((m) => [m.name, [...m.tags, ...(m.vision && !m.tags.includes("vision") ? ["vision"] : [])].join(","), alive(m),
          [m.verified ? "" : "unverified", m.streaming ? "" : "no-stream"].filter(Boolean).join(" ")]), ["MODEL", "TAGS", "ALIVE", "STATUS"]);
      } else if (sub === "check") {
        return await doctor(a, c);
      } else if (sub === "resolve" && words.length > 2) {
        const names = words.slice(2);
        for (const t of c.models.resolve(names.length > 1 ? names : names[0])) console.log(t);
      } else {
        console.error("usage: llmf-js models [list | check | resolve NAME]");
        return 2;
      }
    } else if (cmd === "health") {
      let bad = 0;
      const rows = await c.health.check();
      for (const h of rows) {
        if (!h.ok) bad++;
        console.log(`${h.ok ? "OK" : "FAIL"}`.padEnd(5), h.provider.padEnd(16), h.model.padEnd(42), `${h.latency.toFixed(2)}s`.padStart(7), " ", h.error || "");
      }
      return bad === rows.length ? 1 : 0;
    } else {
      const rest = cmd === "ask" || cmd === "chat" ? words.slice(1) : words;
      let prompt = rest.join(" ").trim();
      if (a.interactive || (cmd === "chat" && !prompt && process.stdin.isTTY)) return await repl(a);
      const piped = await readStdin();
      if (piped) prompt = `${prompt}\n\n${piped}`.trim();
      if (!prompt) { console.error(HELP); return 2; }
      await ask(a, prompt);
    }
  } catch (e) {
    if (e instanceof LLMFError) { console.error(`error: ${e.message}`); return 1; }
    if (e?.code === "ENOENT" || /image not found/.test(e?.message || "")) { console.error(`error: ${e.message}`); return 2; }
    if (e?.code === "EPIPE") return 0;
    throw e;
  }
  return 0;
}
