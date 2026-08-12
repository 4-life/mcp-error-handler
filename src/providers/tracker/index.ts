import { jiraTrackerProvider } from "./jira.js";
import type { TrackerProvider } from "./types.js";

const providers: Record<string, TrackerProvider> = {
  jira: jiraTrackerProvider,
};

export function getTrackerProvider(name: string): TrackerProvider {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown tracker_provider "${name}" — available: ${Object.keys(providers).join(", ")}`);
  return provider;
}

export type { TrackerProvider } from "./types.js";
