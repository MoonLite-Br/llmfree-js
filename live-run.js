#!/usr/bin/env node
// llmf live test: exercises the library against the REAL internet and writes a JSON report.
//
//   node live-run.js                       # full run (makes ~15-40 small requests)
//   node live-run.js --quick               # skip the model sweep
//   node live-run.js --proxy socks5://127.0.0.1:1080
//   node live-run.js --only api,stream,server
//   node live-run.js --all-models          # the sweep also tests models found live (/models)
//
// Result: a table in the terminal and ./llmf_live_report.json (send that file back to the author).
// Exit code 1 only if a CORE (library-logic) check fails; provider outages are reported but not fatal.
import { parseArgs } from "node:util";
import fs from "node:fs";
import os from "node:os";
import { LLMF, AllProvidersFailed, ModelNotFound, version } from "./src/index.js";
import { available } from "./src/curl.js";

const { values: args } = parseArgs({ options: {
  quick: { type: "boolean" }, proxy: { type: "string" }, only: { type: "string" }, "all-models": { type: "boolean" },
  timeout: { type: "string", default: "45" }, out: { type: "string", default: "llmf_live_report.json" },
} });
const only = args.only ? new Set(args.only.split(",")) : null;
const timeout = Number(args.timeout);
const COLORS = { PASS: "\x1b[32m", FAIL: "\x1b[31m", WARN: "\x1b[33m", SKIP: "\x1b[90m" };
const report = { version, node: process.version, platform: `${os.platform()} ${os.arch()}`, started: new Date().toISOString(), checks: [], doctor: [] };

class Skip extends Error {}
class Warn extends Error {}
const client = (o = {}) => new LLMF({ timeout, deadline: timeout * 3, useCache: false, ...(args.proxy ? { proxy: args.proxy } : {}), ...o });

async function check(group, name, kind, fn) {
  if (only && !only.has(group)) return;
  const t0 = Date.now();
  let status = "PASS", detail = "";
  try { detail = (await fn()) ?? ""; } catch (e) {
    if (e instanceof Skip) status = "SKIP"; else if (e instanceof Warn) status = "WARN"; else status = kind === "core" ? "FAIL" : "WARN";
    detail = `${e.name}: ${e.message}`.slice(0, 300);
  }
  const ms = Date.now() - t0;
  report.checks.push({ group, name, kind, status, ms, detail });
  console.log(`${COLORS[status]}${status.padEnd(5)}\x1b[0m ${group.padEnd(10)} ${name.padEnd(44)} ${String(ms).padStart(6)} ms  ${String(detail).slice(0, 90)}`);
}

await check("env", "node >= 18 with fetch-free http layer", "core", () => { if (Number(process.versions.node.split(".")[0]) < 18) throw new Error("node < 18"); return process.version; });
await check("env", "registry resolves every alias", "core", () => {
  const c = client();
  for (const a of ["fast", "best", "code", "vision", "reasoning", "auto"]) if (!c.models.resolve(a).length) throw new Error(`alias ${a} is empty`);
  try { c.models.resolve("definitely-not-a-model-xyz"); throw new Error("no ModelNotFound"); } catch (e) { if (!(e instanceof ModelNotFound)) throw e; }
});

await check("providers", "health ping of every provider", "provider", async () => {
  const rows = await client().health.check();
  report.health = rows;
  const ok = rows.filter((r) => r.ok).length;
  if (!ok) throw new Error("no provider answered");
  return `${ok}/${rows.length} answered`;
});

if (!args.quick && (!only || only.has("providers"))) {
  console.log("-- model sweep (doctor) --");
  report.doctor = (await client().models.check({ includeLive: !!args["all-models"], timeout, save: false })).map((r) => ({ name: r.name, ok: r.ok, latency: r.latency, error: r.error }));
  const ok = report.doctor.filter((r) => r.ok).length;
  console.log(`   ${ok}/${report.doctor.length} models answered`);
}

await check("api", "chat() returns a Reply with provider/model", "provider", async () => {
  const r = await client().chat("Reply with the single word: ok", { model: "fast" });
  if (!r.text || !r.provider) throw new Error("empty reply");
  return `${r.source} in ${r.latency.toFixed(1)}s`;
});
await check("api", "OpenAI-shaped chat.completions.create", "provider", async () => {
  const r = await client().chat.completions.create({ messages: [{ role: "user", content: "Say hi in one word" }], max_tokens: 64 });
  if (!r.choices[0].message.content) throw new Error("empty content");
  return r.model;
});
await check("stream", "stream() yields chunks and a final reply", "provider", async () => {
  const st = client().stream("Count from 1 to 5, separated by spaces.");
  let n = 0;
  for await (const _ of st) n++; // eslint-disable-line no-unused-vars
  if (!st.reply?.text) throw new Error("no final reply");
  return `${n} chunks via ${st.reply.source}`;
});
await check("resilience", "a dead first provider falls back", "provider", async () => {
  const c = client({ retries: 0 });
  c.register("dead", "http://127.0.0.1:9/v1", ["x"], { front: true });
  const r = await c.chat("Reply: ok", { fallback: true });
  if (r.provider === "dead") throw new Error("dead provider answered?");
  return `fell back to ${r.provider}`;
});
await check("resilience", "everything dead -> AllProvidersFailed", "core", async () => {
  const c = client({ builtin: false, retries: 0 });
  c.register("dead", "http://127.0.0.1:9/v1", ["x"]);
  try { await c.chat("hi"); throw new Error("no error"); } catch (e) { if (!(e instanceof AllProvidersFailed)) throw e; }
});
await check("server", "llmf serve answers an OpenAI request", "provider", async () => {
  const { serve } = await import("./src/server.js");
  const srv = await serve(client(), { port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "say ok" }], max_tokens: 64 }) });
    const j = await res.json();
    if (!j.choices?.[0]?.message?.content) throw new Error(JSON.stringify(j).slice(0, 120));
    return j.model;
  } finally { srv.closeAllConnections(); srv.close(); }
});
await check("transport", "request through curl-impersonate", "provider", async () => {
  if (!available()) throw new Skip("no curl-impersonate binary (set LLMF_CURL_BIN)");
  return (await client({ transport: "curl" }).chat("Reply: ok", { model: "fast" })).source;
});
if (args.proxy) await check("proxy", `request through ${args.proxy.replace(/\/\/.*@/, "//***@")}`, "provider", async () => (await client().chat("Reply: ok", { model: "fast" })).source);
else await check("proxy", "request through a proxy", "provider", () => { throw new Skip("pass --proxy URL"); });

report.finished = new Date().toISOString();
fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
const bad = report.checks.filter((c) => c.status === "FAIL").length;
console.log(`\n${report.checks.filter((c) => c.status === "PASS").length} pass, ${report.checks.filter((c) => c.status === "WARN").length} warn, ${bad} fail  ->  ${args.out}`);
process.exit(bad ? 1 : 0);
