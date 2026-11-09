// Command line: ``llmf "your question"``.
import { parseArgs } from "node:util";
import readline from "node:readline";
import { defaultClient } from "./index.js";
import { LLMFError } from "./errors.js";
import { version } from "./version.js";
import { describe } from "./curl.js";

const COMMANDS = ["ask", "chat", "models", "doctor", "providers", "health", "serve", "version"];

const HELP = `usage: llmf-js [options] "question"            ask once (also reads stdin)
       llmf-js chat                            interactive chat (/reset, /exit)
       llmf-js models [list|check|resolve NAME]  what exists / does it really work / what does NAME expand to
       llmf-js doctor [--all]                  call every model once and report (alias of "models check")
       llmf-js providers | health              endpoints / quick ping
       llmf-js serve [--port N] [--host H] [--max-concurrent N] [--cors-origin URL]   OpenAI-compatible local server (busy -> 429)
`;

const OPTIONS = {
  model: { type: "string", short: "m" },
  provider: { type: "string", short: "p" },
  system: { type: "string", short: "s" },
  interactive: { type: "boolean", short: "i" },
  image: { type: "string", multiple: true },
  "max-tokens": { type: "string" },
  temperature: { type: "string", short: "t" },
  stream: { type: "boolean" },
  json: { type: "boolean" },
  live: { type: "boolean" },
  all: { type: "boolean" },
  "include-non-chat": { type: "boolean" },
  "include-limited": { type: "boolean" },
  "no-save": { type: "boolean" },
  routing: { type: "string" },
  race: { type: "string" },
  timeout: { type: "string" },
  proxy: { type: "string" },
  transport: { type: "string" },
  impersonate: { type: "string" },
  host: { type: "string", default: "127.0.0.1" },
  port: { type: "string", default: "8000" },
  "api-key": { type: "string", multiple: true },
  cors: { type: "boolean" },
  "cors-origin": { type: "string", multiple: true },
  "strict-models": { type: "boolean" },
  "no-fallback": { type: "boolean" },
  persona: { type: "string" },
  "max-concurrent": { type: "string" },
  "max-inflight": { type: "string" },
  verbose: { type: "boolean", short: "v" },
  version: { type: "boolean", short: "V" },
  help: { type: "boolean", short: "h" },
};

const num = (v) => (v === undefined ? undefined : Number(v));

function table(rows, header) {
  const all = [header, ...rows];
  const w = header.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  for (const r of all) console.log(r.map((c, i) => String(c).padEnd(w[i])).join("  ").trimEnd());
}

async function ask(a, prompt, history = []) {
  const c = defaultClient();
  const o = { model: a.model, provider: a.provider, system: a.system, maxTokens: num(a["max-tokens"]), temperature: num(a.temperature) };
  if (a.race) o.race = Number(a.race);
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
    timeout: Number(a.timeout) || 30, save: !a["no-save"], onResult: show });
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
    console.error(`error: ${e.message}`);
    return 2;
  }
  const a = parsed.values;
  const words = parsed.positionals;
  if (a.help) { console.log(HELP); return 0; }
  if (a.version) { console.log(`llmf-js ${version}`); return 0; }
  const c = defaultClient();
  try {
    if (a.timeout) c.configure({ timeout: Number(a.timeout) });
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
      if (a["max-inflight"] !== undefined) c.configure({ maxInflight: Number(a["max-inflight"]) });
      const mc = a["max-concurrent"];
      if (mc !== undefined && !/^\d+$/.test(mc)) { console.error("error: --max-concurrent must be an integer >= 0 (0 = unlimited)"); return 2; }
      const port = Number(a.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error("error: --port must be between 0 and 65535"); return 2; }
      let server;
      try {
        server = await serve(c, { host: a.host, port, apiKey: a["api-key"], cors: a.cors, corsOrigins: a["cors-origin"] || [], strictModels: a["strict-models"], fallback: !a["no-fallback"], ...(a["max-concurrent"] !== undefined && { maxConcurrent: Number(a["max-concurrent"]) }) });
      } catch (e) {
        const hint = e.code === "EADDRINUSE" ? "  (the port is already in use: pick another with --port)" : /^\d+$/.test(String(a.host)) ? `  (did you mean \`--port ${a.host}\`? --host expects an address such as 127.0.0.1)` : "";
        console.error(`error: cannot listen on ${a.host}:${a.port}: ${e.message}${hint}`);
        return 2;
      }
      const shown = ["0.0.0.0", "::"].includes(a.host) ? "127.0.0.1" : a.host;
      console.error(`llmf-js serving on http://${shown}:${server.address().port}  (Ctrl+C to stop)\n  API  http://${shown}:${server.address().port}/v1`);
      await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
      server.close();
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
