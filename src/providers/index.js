// Provider specs and adapters.
import { OpenAIAdapter } from "./openai.js";
import { ChatJimmyAdapter } from "./chatjimmy.js";
import { ChatAIAdapter } from "./chatai.js";
import { NotTrackAdapter } from "./nottrack.js";
import { NotTrackAIAdapter } from "./notrackai.js";
import { ApiFreeAdapter } from "./apifree.js";

export const ADAPTERS = {
  openai: new OpenAIAdapter(),
  chatjimmy: new ChatJimmyAdapter(),
  chatai: new ChatAIAdapter(),
  nottrack: new NotTrackAdapter(),
  notrackai: new NotTrackAIAdapter(),
  apifree: new ApiFreeAdapter(),
};

export { Adapter, model, provider, options } from "./base.js";
