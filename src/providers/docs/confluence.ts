import { NotImplementedError } from "../../errors.js";
import type { AppConfig } from "../../types.js";
import type { DocsProvider } from "./types.js";

/** TODO: wire to the Confluence REST API — fetch config.confluenceSpace's pages as context for draftFix. Not called by anything yet. */
async function fetchDocs(config: AppConfig): Promise<string> {
  throw new NotImplementedError("fetchDocs", `set CONFLUENCE_BASE_URL and CONFLUENCE_API_TOKEN in .env for space "${config.confluenceSpace}"`);
}

export const confluenceDocsProvider: DocsProvider = { fetchDocs };
