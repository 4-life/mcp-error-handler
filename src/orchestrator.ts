import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile as execFileCb, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { getAppConfig } from "./config.js";
import type {
  AppConfig,
  ErrorReport,
  FixDraft,
  JiraTicket,
  PullRequest,
  ReportErrorResult,
  TestRunResult,
} from "./types.js";

const execFile = promisify(execFileCb);
const REPO_CACHE_DIR = process.env.REPO_CACHE_DIR ?? join(process.cwd(), "data", "repos");
const WORKTREE_DIR = process.env.WORKTREE_DIR ?? join(process.cwd(), "data", "worktrees");

/** Marks a pipeline step that needs a real external integration (AI provider, Jira, GitHub, Slack) wired in before it can run. */
export class NotImplementedError extends Error {
  constructor(step: string, detail: string) {
    super(`${step} is not implemented yet: ${detail}`);
    this.name = "NotImplementedError";
  }
}

/** In-memory job state so a later CI webhook can find its way back to the right worktree/branch/attempt count. Swap for real storage before running more than one replica. */
interface Job {
  jobId: string;
  appId: string;
  worktreePath: string;
  branchName: string;
  ciAttempts: number;
  ticket?: JiraTicket;
}
const jobs = new Map<string, Job>();

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile(cmd, args, { cwd });
  return stdout.trim();
}

async function ensureRepoCloned(config: AppConfig): Promise<string> {
  const repoDir = join(REPO_CACHE_DIR, config.appId);
  if (!existsSync(join(repoDir, ".git"))) {
    await mkdir(dirname(repoDir), { recursive: true });
    await execFile("git", ["clone", config.repoUrl, repoDir]);
  } else {
    await run("git", ["fetch", "origin", config.defaultBranch], repoDir);
  }
  return repoDir;
}

async function createFixWorktree(config: AppConfig, repoDir: string, jobId: string): Promise<{ worktreePath: string; branchName: string }> {
  const branchName = `fix/${jobId.slice(0, 8)}`;
  const worktreePath = join(WORKTREE_DIR, config.appId, branchName);
  await mkdir(dirname(worktreePath), { recursive: true });
  await run("git", ["worktree", "add", "-b", branchName, worktreePath, `origin/${config.defaultBranch}`], repoDir);
  return { worktreePath, branchName };
}

async function removeFixWorktree(repoDir: string, worktreePath: string): Promise<void> {
  await run("git", ["worktree", "remove", "--force", worktreePath], repoDir).catch(() => undefined);
  await rm(worktreePath, { recursive: true, force: true });
}

/** Runs the app's configured test_cmd inside the worktree and captures pass/fail plus combined output, regardless of exit code. */
async function runLocalTests(config: AppConfig, worktreePath: string): Promise<TestRunResult> {
  if (!config.testCmd) {
    return { passed: true, output: "(no test_cmd configured — local gate skipped)" };
  }
  const exec = promisify(execCb);
  try {
    const { stdout, stderr } = await exec(config.testCmd, { cwd: worktreePath });
    return { passed: true, output: `${stdout}\n${stderr}`.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { passed: false, output: `${e.stdout ?? ""}\n${e.stderr ?? e.message}`.trim() };
  }
}

/** Last committer's email per changed file — a stand-in for blaming the exact changed line ranges once draftFix reports them. */
async function findLikelyOwners(repoDir: string, files: string[]): Promise<string[]> {
  const emails = await Promise.all(
    files.map((file) =>
      run("git", ["log", "-1", "--format=%ae", "--", file], repoDir).catch(() => ""),
    ),
  );
  return [...new Set(emails.filter(Boolean))];
}

/**
 * TODO: wire to the configured ai_provider (claude | codex). Should read the error report,
 * the worktree's code, and — when config.confluenceSpace is set — the app's Confluence docs,
 * then write a fix to the worktree and return which files it touched.
 */
async function draftFix(report: ErrorReport, config: AppConfig, worktreePath: string): Promise<FixDraft> {
  throw new NotImplementedError(
    "draftFix",
    `no integration for ai_provider "${config.aiProvider}" — worktree is ready at ${worktreePath}`,
  );
}

/** TODO: wire to the Jira REST API (create issue, then assignee lookup by email). */
async function createJiraTicket(config: AppConfig, report: ErrorReport, analysis: string, assigneeEmail?: string): Promise<JiraTicket> {
  throw new NotImplementedError("createJiraTicket", `project ${config.jiraProjectKey}, assignee candidate ${assigneeEmail ?? config.defaultAssignee ?? "none"}`);
}

/** TODO: wire to the GitHub REST API to open the PR once the branch is pushed. */
async function pushBranchAndOpenPR(config: AppConfig, job: Job, ticket: JiraTicket): Promise<PullRequest> {
  await run("git", ["push", "-u", "origin", job.branchName], job.worktreePath);
  throw new NotImplementedError("openPullRequest", `branch ${job.branchName} is pushed — needs GitHub App/PAT auth to open the PR against ${config.repoUrl}`);
}

/** TODO: wire to Slack's chat.postMessage (or an incoming webhook) for config.slackChannel. */
async function notifySlack(config: AppConfig, ticket: JiraTicket, pr?: PullRequest): Promise<void> {
  throw new NotImplementedError("notifySlack", `channel ${config.slackChannel}`);
}

/**
 * The pipeline described in README.md: load config, update the repo, draft a fix, run tests
 * locally with a revise loop, create the Jira ticket, and — once local tests pass — push and
 * open a PR. The GitHub Actions CI follow-up loop lives in handleCIResult below, since CI
 * completion arrives later as its own webhook event, not inline in this call.
 */
export async function reportError(report: ErrorReport): Promise<ReportErrorResult> {
  const config = getAppConfig(report.appId);
  const jobId = randomUUID();
  const repoDir = await ensureRepoCloned(config);
  const { worktreePath, branchName } = await createFixWorktree(config, repoDir, jobId);
  const job: Job = { jobId, appId: config.appId, worktreePath, branchName, ciAttempts: 0 };
  jobs.set(jobId, job);

  let draft: FixDraft | undefined;
  let lastTestOutput = "";
  try {
    for (let attempt = 1; attempt <= config.localMaxAttempts; attempt++) {
      draft = await draftFix(report, config, worktreePath);
      const result = await runLocalTests(config, worktreePath);
      if (result.passed) break;
      lastTestOutput = result.output;
      draft = undefined;
    }
  } catch (err) {
    if (!(err instanceof NotImplementedError)) throw err;
    // No AI provider wired yet — fall through to a ticket-only report using the raw error text.
  }

  const owners = draft ? await findLikelyOwners(repoDir, draft.filesChanged) : [];
  const analysis = draft
    ? draft.summary
    : `Automated analysis unavailable (${lastTestOutput || "no AI provider configured"}). Raw report:\n${JSON.stringify(report.data, null, 2)}`;
  const ticket = await createJiraTicket(config, report, analysis, owners[0]);
  job.ticket = ticket;

  if (!draft) {
    await removeFixWorktree(repoDir, worktreePath);
    await notifySlack(config, ticket);
    return { jobId, appId: config.appId, ticket, status: "ticket_only" };
  }

  const pr = await pushBranchAndOpenPR(config, job, ticket);
  await notifySlack(config, ticket, pr);
  return { jobId, appId: config.appId, ticket, pullRequest: pr, status: "pr_pending_ci" };
}

/**
 * TODO: call this from a GitHub Actions webhook route (workflow_run / check_run completed).
 * On failure, fetch the job log via the Checks API, feed it back through draftFix for a
 * revision, and push again — up to config.ciMaxAttempts — before leaving the PR for a developer.
 */
export async function handleCIResult(jobId: string, passed: boolean): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Unknown job ${jobId}`);
  if (passed) return;
  const config = getAppConfig(job.appId);
  job.ciAttempts += 1;
  if (job.ciAttempts > config.ciMaxAttempts) {
    throw new NotImplementedError("flagDeveloperOnCIExhaustion", `job ${jobId} — should comment on the PR and stop`);
  }
  throw new NotImplementedError("fetchFailingCILogAndRevise", `job ${jobId}, attempt ${job.ciAttempts}/${config.ciMaxAttempts}`);
}