import { NotImplementedError } from "../../errors.js";
import type { AppConfig, PullRequest, Ticket } from "../../types.js";
import type { MessengerProvider } from "./types.js";

async function postToChannel(config: AppConfig, text: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new NotImplementedError("postToChannel", "set SLACK_BOT_TOKEN in .env");
  }

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: config.slackChannel, text }),
  });
  // Slack's API returns HTTP 200 even on failure — the real status is in the body's `ok` field.
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`Slack post failed: ${data.error ?? res.status}`);
  }
}

async function notify(config: AppConfig, ticket: Ticket, pr?: PullRequest): Promise<void> {
  const lines = [
    `*${config.appId}* — new error report`,
    `Jira: <${ticket.url}|${ticket.key}>${ticket.assignee ? ` (assigned to ${ticket.assignee})` : ""}`,
  ];
  if (pr) lines.push(`PR: <${pr.url}|#${pr.number}>`);
  await postToChannel(config, lines.join("\n"));
}

async function alertError(config: AppConfig, message: string): Promise<void> {
  await postToChannel(config, `*${config.appId}* — mcp-error-handler pipeline failure\n${message}`);
}

export const slackMessengerProvider: MessengerProvider = { notify, alertError };
