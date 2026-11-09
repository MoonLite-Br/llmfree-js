// llmf (llmfree) - free, keyless LLMs behind one call, with automatic fallback.
//
//   import llmf, { LLMF } from "llmf";
//   console.log(String(await llmf.chat("Xin chào")));      // a Reply: text + provider/model/reasoning
//   const llm = new LLMF({ timeout: 30 });
import * as tools from "./tools.js";
import { ChatStream, Client, Session, Stream } from "./client.js";
import { AllProvidersFailed, LLMFError, ModelNotFound, ProviderError } from "./errors.js";
import { ChatCompletion, ChatCompletionChunk, HealthResult, ModelInfo, Reply } from "./types.js";
import { version } from "./version.js";

export const LLMF = Client;

let shared = null;

/** The shared client behind the module-level helpers. */
export function defaultClient() {
  if (!shared) {
    const env = process.env;
    const o = {};
    if (env.LLMF_TIMEOUT) o.timeout = Number(env.LLMF_TIMEOUT);
    if (env.LLMF_PROXY) o.proxy = env.LLMF_PROXY;
    if (env.LLMF_MODEL) o.model = env.LLMF_MODEL;
    if (env.LLMF_ROUTING) o.routing = env.LLMF_ROUTING;
    if (env.LLMF_TRANSPORT) o.transport = env.LLMF_TRANSPORT;
    if (env.LLMF_IMPERSONATE) o.impersonate = env.LLMF_IMPERSONATE;
    shared = new Client(o);
  }
  return shared;
}

export const chat = Object.assign((prompt, o) => defaultClient().chat(prompt, o), {
  completions: { create: (params) => defaultClient().chat.completions.create(params) },
});
export const stream = (prompt, o) => defaultClient().stream(prompt, o);
export const session = (system, defaults) => defaultClient().session(system, defaults);
export const models = Object.assign((o) => defaultClient().models(o), {
  list: (o) => defaultClient().models.list(o),
  check: (o) => defaultClient().models.check(o),
  resolve: (m) => defaultClient().models.resolve(m),
});
export const providers = Object.assign(() => defaultClient().providers(), { list: () => defaultClient().providers.list() });
export const health = Object.assign(() => defaultClient().health(), { check: () => defaultClient().health.check() });
export const register = (...a) => defaultClient().register(...a);
export const discover = (o) => defaultClient().discover(o);
export const configure = (s) => defaultClient().configure(s);

export { tools, Client, Session, Stream, ChatStream, ChatCompletion, ChatCompletionChunk, Reply, ModelInfo, HealthResult, LLMFError, ProviderError, AllProvidersFailed, ModelNotFound, version };

export default { LLMF, Client, chat, stream, session, models, providers, health, register, discover, configure,
  defaultClient, version, tools, LLMFError, ProviderError, AllProvidersFailed, ModelNotFound };
