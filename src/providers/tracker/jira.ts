import { NotImplementedError } from "../../errors.js";
import type { AppConfig, ErrorReport, Ticket } from "../../types.js";
import type { TrackerProvider } from "./types.js";

function toADF(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] })),
  };
}

async function findJiraAccountId(baseUrl: string, authHeader: string, email: string): Promise<string | undefined> {
  const res = await fetch(`${baseUrl}/rest/api/3/user/search?query=${encodeURIComponent(email)}`, {
    headers: { Authorization: authHeader, Accept: "application/json" },
  });
  if (!res.ok) return undefined;
  const users = (await res.json()) as Array<{ accountId: string }>;
  return users[0]?.accountId;
}

/** Creates the Jira issue, then best-effort assigns it by email — a failed assignee lookup doesn't fail ticket creation. */
async function createTicket(config: AppConfig, report: ErrorReport, analysis: string, assigneeEmail?: string): Promise<Ticket> {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !token) {
    throw new NotImplementedError("createTicket", "set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in .env");
  }
  const authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

  const summary =
    analysis.split("\n").find((line) => line.trim().length > 0)?.slice(0, 250) ??
    `New error report for ${config.appId}`;
  const description = `Source: ${report.source}\n\n${analysis}`;

  const res = await fetch(`${baseUrl}/rest/api/3/issue`, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      fields: {
        project: { key: config.jiraProjectKey },
        summary,
        description: toADF(description),
        issuetype: { name: "Bug" },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Jira issue creation failed: ${res.status} ${await res.text()}`);
  }
  const created = (await res.json()) as { key: string };
  const ticket: Ticket = { key: created.key, url: `${baseUrl}/browse/${created.key}` };

  const candidateEmail = assigneeEmail ?? config.defaultAssignee;
  if (candidateEmail) {
    const accountId = await findJiraAccountId(baseUrl, authHeader, candidateEmail).catch(() => undefined);
    if (accountId) {
      await fetch(`${baseUrl}/rest/api/3/issue/${created.key}/assignee`, {
        method: "PUT",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      }).catch(() => undefined);
      ticket.assignee = candidateEmail;
    }
  }

  return ticket;
}

export const jiraTrackerProvider: TrackerProvider = { createTicket };
