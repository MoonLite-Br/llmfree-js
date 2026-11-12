export type Role = "system" | "user" | "assistant" | "tool";

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface Message {
  role: Role;
  content: string | ContentPart[] | null;
  [extra: string]: unknown;
}

export type Prompt = string | Message[];

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface Attempt {
  provider: string;
  model: string;
  ok: boolean;
  error?: string | null;
  latency?: number;
  [extra: string]: unknown;
}

export interface CallOptions {
  /** Model, alias (fast/best/code/vision/reasoning), `provider/model`, fuzzy name or an ordered list. */
  model?: string | string[] | null;
  provider?: string;
  system?: string;
  images?: string[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  tools?: unknown[];
  json?: boolean;
  timeout?: number;
  deadline?: number;
  maxAttempts?: number;
  retries?: number;
  only?: string[];
  exclude?: string[];
  proxy?: string | null;
  routing?: "ranked" | "adaptive";
  race?: number;
  fallback?: boolean | null;
  /** notrack-ai only. */
  persona?: "concise" | "normal" | "detailed" | "creative";
  signal?: AbortSignal;
}

export interface ClientOptions extends CallOptions {
  builtin?: boolean;
  userAgent?: string;
  useCache?: boolean;
  cacheDir?: string | null;
  visionTimeout?: number;
  transport?: "node" | "curl" | "auto";
  impersonate?: string;
  maxInflight?: number;
}

export class Reply {
  text: string;
  provider: string;
  model: string;
  reasoning: string | null;
  usage: Usage | null;
  finishReason: string | null;
  toolCalls: unknown[] | null;
  latency: number;
  raw: unknown;
  attempts: Attempt[];
  /** `"provider/model"` that produced this reply. */
  readonly source: string;
  toString(): string;
  toJSON(): Record<string, unknown>;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: "assistant"; content: string; reasoning?: string | null; tool_calls?: unknown[] | null };
  finish_reason: string | null;
}

export class ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  /** `"provider/model"` that actually answered. */
  model: string;
  choices: ChatCompletionChoice[];
  usage: Usage | null;
  provider: string;
  latency: number;
  attempts: Attempt[];
  readonly output_text?: string;
}

export class ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: { index: number; delta: { role?: "assistant"; content?: string }; finish_reason: string | null }[];
}

export class ModelInfo {
  provider: string;
  id: string;
  tags: string[];
  vision: boolean;
  verified: boolean;
  alive: boolean | null;
  samples: number;
  streaming: boolean;
  readonly name: string;
}

export class HealthResult {
  provider: string;
  model: string;
  ok: boolean;
  latency: number;
  error: string | null;
  answer: string | null;
  verified: boolean;
  readonly name: string;
}

/** Async iterable of text pieces; `await stream.collect()` returns the whole answer. */
export class Stream implements AsyncIterable<string> {
  [Symbol.asyncIterator](): AsyncIterator<string>;
  readonly provider: string;
  readonly model: string;
  readonly text: string;
  collect(): Promise<string>;
}

export class ChatStream implements AsyncIterable<ChatCompletionChunk> {
  [Symbol.asyncIterator](): AsyncIterator<ChatCompletionChunk>;
  readonly text: string;
  readonly reply: Reply;
  collect(): Promise<ChatCompletion>;
}

export class Session {
  system: string | null;
  defaults: CallOptions;
  history: Message[];
  reset(): void;
  chat(prompt: Prompt, options?: CallOptions): Promise<Reply>;
  stream(prompt: Prompt, options?: CallOptions): Stream;
}

export interface CompletionParams extends CallOptions {
  messages: Message[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  top_p?: number;
  response_format?: { type: "text" | "json_object" | "json_schema"; [extra: string]: unknown };
}

export interface ChatApi {
  (prompt: Prompt, options?: CallOptions): Promise<Reply>;
  completions: {
    create(params: CompletionParams & { stream?: false }): Promise<ChatCompletion>;
    create(params: CompletionParams & { stream: true }): ChatStream;
    create(params: CompletionParams): Promise<ChatCompletion> | ChatStream;
  };
}

export interface ModelsApi {
  (options?: { live?: boolean; includeNonChat?: boolean }): Promise<ModelInfo[]>;
  list(options?: { live?: boolean; includeNonChat?: boolean }): Promise<ModelInfo[]>;
  check(options?: Record<string, unknown>): Promise<HealthResult[]>;
  /** What a name expands to, e.g. `["ovh/gpt-oss-120b", ...]`. */
  resolve(model: string): string[];
}

export interface RegisterOptions {
  headers?: Record<string, string>;
  chatPath?: string;
  kind?: string;
  vision?: boolean;
  minInterval?: number;
  front?: boolean;
  auto?: boolean;
  concurrency?: number;
  note?: string;
}

export class Client {
  constructor(options?: ClientOptions);
  chat: ChatApi;
  models: ModelsApi;
  providers: { (): unknown[]; list(): unknown[] };
  health: { (): Promise<HealthResult[]>; check(): Promise<HealthResult[]> };
  stream(prompt: Prompt, options?: CallOptions): Stream;
  session(system?: string | null, defaults?: CallOptions): Session;
  register(name: string, baseUrl: string, models: string | string[], options?: RegisterOptions): this;
  discover(options?: { limit?: number }): Promise<unknown>;
  configure(settings: Partial<ClientOptions>): this;
}

export const LLMF: typeof Client;

export class LLMFError extends Error {}
export class ProviderError extends LLMFError {
  provider: string;
  model: string;
  status: number | null;
  code: string | null;
}
export class AllProvidersFailed extends LLMFError {
  errors: ProviderError[];
}
export class ModelNotFound extends LLMFError {}

export const version: string;
export const tools: Record<string, unknown>;
export function defaultClient(): Client;

export const chat: ChatApi;
export function stream(prompt: Prompt, options?: CallOptions): Stream;
export function session(system?: string | null, defaults?: CallOptions): Session;
export const models: ModelsApi;
export const providers: Client["providers"];
export const health: Client["health"];
export function register(name: string, baseUrl: string, models: string | string[], options?: RegisterOptions): Client;
export function discover(options?: { limit?: number }): Promise<unknown>;
export function configure(settings: Partial<ClientOptions>): Client;

declare const llmf: {
  LLMF: typeof Client;
  Client: typeof Client;
  chat: typeof chat;
  stream: typeof stream;
  session: typeof session;
  models: typeof models;
  providers: typeof providers;
  health: typeof health;
  register: typeof register;
  discover: typeof discover;
  configure: typeof configure;
  defaultClient: typeof defaultClient;
  version: string;
  tools: typeof tools;
  LLMFError: typeof LLMFError;
  ProviderError: typeof ProviderError;
  AllProvidersFailed: typeof AllProvidersFailed;
  ModelNotFound: typeof ModelNotFound;
};
export default llmf;
