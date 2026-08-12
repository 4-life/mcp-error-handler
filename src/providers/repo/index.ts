import { githubRepoProvider } from "./github.js";
import type { RepoProvider } from "./types.js";

const providers: Record<string, RepoProvider> = {
  github: githubRepoProvider,
};

export function getRepoProvider(name: string): RepoProvider {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown repo_provider "${name}" — available: ${Object.keys(providers).join(", ")}`);
  return provider;
}

export type { RepoProvider, ExistingPullRequest } from "./types.js";
