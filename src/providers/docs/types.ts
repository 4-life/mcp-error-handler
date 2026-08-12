import type { AppConfig } from "../../types.js";

/** App documentation, read-only context for the AI: Confluence today, GitHub Wiki later. */
export interface DocsProvider {
  fetchDocs(config: AppConfig): Promise<string>;
}
