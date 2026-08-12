import { claudeLLMProvider } from "./claude.js";
import { notImplementedLLMProvider } from "./not-implemented.js";
import type { LLMProvider } from "./types.js";

const providers: Record<string, LLMProvider> = {
  claude: claudeLLMProvider,
  codex: notImplementedLLMProvider,
};

export function getLLMProvider(name: string): LLMProvider {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown ai_provider "${name}" — available: ${Object.keys(providers).join(", ")}`);
  return provider;
}

export type { LLMProvider } from "./types.js";
