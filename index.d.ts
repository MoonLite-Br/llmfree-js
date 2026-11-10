/** llmf (llmfree) — free, keyless LLM client for Node.js. */
export const version: string;
export class LLMFError extends Error {}
export class ProviderError extends LLMFError {}
export class AllProvidersFailed extends LLMFError { errors: unknown[]; }
export class ModelNotFound extends LLMFError {}
export class Reply extends String {
  provider?: string;
  model?: string;
  reasoning?: string;
}
export interface ClientOptions {
  timeout?: number;
  deadline?: number;
  proxy?: string;
  routing?: string;
  race?: number;
  transport?: string;
  model?: string;
  maxInflight?: number;
  visionTimeout?: number;
  impersonate?: string;
  [key: string]: unknown;
}
export class Client {
  constructor(options?: ClientOptions);
  chat: {
    (prompt: string, options?: ClientOptions): Promise<Reply>;
    completions: { create(params: Record<string, unknown>): Promise<unknown> };
  };
  stream(prompt: string, options?: ClientOptions): AsyncIterable<unknown>;
  session(system?: string, defaults?: ClientOptions): (prompt: string) => Promise<Reply>;
  models: {
    (options?: object): unknown;
    list(options?: object): unknown;
    check(options?: object): Promise<unknown>;
    resolve(name: string): unknown;
  };
  providers: { (): unknown; list(): unknown };
  health: { check(options?: object): Promise<unknown> };
  register(name: string, baseUrl: string, models?: string[], options?: object): void;
}
export const LLMF: typeof Client;
export function defaultClient(): Client;
export function configure(options: ClientOptions): Client;
export function register(name: string, baseUrl: string, models?: string[], options?: object): void;
export const chat: {
  (prompt: string, options?: ClientOptions): Promise<Reply>;
  completions: { create(params: Record<string, unknown>): Promise<unknown> };
};
export function stream(prompt: string, options?: ClientOptions): AsyncIterable<unknown>;
export function session(system?: string, defaults?: ClientOptions): (prompt: string) => Promise<Reply>;
export const models: {
  (options?: object): unknown;
  list(options?: object): unknown;
  check(options?: object): Promise<unknown>;
  resolve(name: string): unknown;
};
export const providers: { (): unknown; list(): unknown };
export const health: { check(options?: object): Promise<unknown> };
export const tools: Record<string, unknown>;
export function discover(options?: object): Promise<unknown>;
declare const _default: {
  chat: typeof chat;
  stream: typeof stream;
  session: typeof session;
  models: typeof models;
  providers: typeof providers;
  health: typeof health;
  register: typeof register;
  configure: typeof configure;
  defaultClient: typeof defaultClient;
  version: string;
  tools: typeof tools;
  LLMF: typeof Client;
  LLMFError: typeof LLMFError;
  ProviderError: typeof ProviderError;
  AllProvidersFailed: typeof AllProvidersFailed;
  ModelNotFound: typeof ModelNotFound;
};
export default _default;
