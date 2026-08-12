export interface AppConfig {
  appId: string;
  repoUrl: string;
  defaultBranch: string;
  repoProvider: "github";
  trackerProvider: "jira";
  docsProvider: "confluence";
  messengerProvider: "slack";
  jiraProjectKey: string;
  slackChannel: string;
  confluenceSpace?: string;
  aiProvider: "claude" | "codex";
  /** Optional — omitting it auto-detects from the lockfile present (yarn.lock/package-lock.json/pnpm-lock.yaml), or skips entirely for non-npm projects. */
  installCmd?: string;
  testCmd?: string;
  defaultAssignee?: string;
  localMaxAttempts: number;
  ciMaxAttempts: number;
}

export interface ErrorReport {
  appId: string;
  /** Raw payload as received — a provider's native JSON, or a developer's plain-text description. */
  data: unknown;
  /** Where this report came from, for logging only — the pipeline itself never branches on this. */
  source: "sentry" | "bugsnag" | "developer" | "other";
}

export interface FixDraft {
  summary: string;
  filesChanged: string[];
}

/** What the previous local-test-gate retry attempted and what happened — fed into the next draftFix call so it isn't flying blind on retry, and can recognize a broken test environment (same failure regardless of the fix) instead of endlessly re-guessing. */
export interface PriorAttempt {
  summary: string;
  testOutput: string;
}

/**
 * draftFix's result: the AI decides, from the full report + existing-PR context + repo access,
 * whether this is even worth acting on (production? already handled?) before ever producing a
 * diff. "skip" means nothing downstream happens — no ticket, no branch pushed, nothing. "incomplete"
 * means it genuinely tried (and spent real cost) but hit a budget limit (turns, $) before finishing
 * — treated like a failed local-test attempt: a ticket for a human, not a thrown error, since
 * running out of budget on a hard problem isn't a bug in the pipeline itself.
 */
export type DraftResult =
  | { action: "skip"; reason: string }
  | { action: "fix"; draft: FixDraft }
  | { action: "incomplete"; reason: string };

export interface TestRunResult {
  passed: boolean;
  output: string;
}

/** A tracker issue — generic name since Jira, GitHub Issues, and Redmine all produce this same shape. */
export interface Ticket {
  key: string;
  url: string;
  assignee?: string;
}

export interface PullRequest {
  number: number;
  url: string;
}

export interface ReportErrorResult {
  jobId: string;
  appId: string;
  ticket?: Ticket;
  pullRequest?: PullRequest;
  status: "skipped" | "ticket_only" | "pr_opened" | "pr_pending_ci";
  /** Why the AI skipped — only present when status is "skipped". */
  reason?: string;
}
