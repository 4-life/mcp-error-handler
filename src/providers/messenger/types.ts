import type { AppConfig, PullRequest, Ticket } from "../../types.js";

/** Where the team hears about it: Slack today, Telegram/other chat apps later. */
export interface MessengerProvider {
  notify(config: AppConfig, ticket: Ticket, pr?: PullRequest): Promise<void>;
}
