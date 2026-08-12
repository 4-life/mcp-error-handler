import { confluenceDocsProvider } from "./confluence.js";
import type { DocsProvider } from "./types.js";

const providers: Record<string, DocsProvider> = {
  confluence: confluenceDocsProvider,
};

export function getDocsProvider(name: string): DocsProvider {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown docs_provider "${name}" — available: ${Object.keys(providers).join(", ")}`);
  return provider;
}

export type { DocsProvider } from "./types.js";
