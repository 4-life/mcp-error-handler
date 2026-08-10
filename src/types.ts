export interface AppConfig {
  appId: string;
  repoUrl: string;
  defaultBranch: string;
  jiraProjectKey: string;
  slackChannel: string;
  confluenceSpace?: string;
  aiProvider: "claude" | "codex";
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
  branchName: string;
  worktreePath: string;
  summary: string;
  filesChanged: string[];
}

export interface TestRunResult {
  passed: boolean;
  output: string;
}

export interface JiraTicket {
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
  ticket?: JiraTicket;
  pullRequest?: PullRequest;
  status: "ticket_only" | "pr_opened" | "pr_pending_ci";
}