import { slackMessengerProvider } from "./slack.js";
import type { MessengerProvider } from "./types.js";

const providers: Record<string, MessengerProvider> = {
  slack: slackMessengerProvider,
};

export function getMessengerProvider(name: string): MessengerProvider {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown messenger_provider "${name}" — available: ${Object.keys(providers).join(", ")}`);
  return provider;
}

export type { MessengerProvider } from "./types.js";
