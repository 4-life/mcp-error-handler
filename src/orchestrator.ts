import { randomUUID, createHash } from "node:crypto";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { getAppConfig } from "./config.js";
import { getRepoProvider } from "./providers/repo/index.js";
import { getTrackerProvider } from "./providers/tracker/index.js";
import { getMessengerProvider } from "./providers/messenger/index.js";
import { getLLMProvider } from "./providers/llm/index.js";
import { NotImplementedError } from "./errors.js";
import type { AppConfig, ErrorReport, FixDraft, ReportErrorResult, Ticket, TestRunResult } from "./types.js";

/** In-memory job state so a later CI webhook can find its way back to the right worktree/branch/attempt count. Swap for real storage before running more than one replica. */
interface Job {
  jobId: string;
  appId: string;
  worktreePath: string;
  branchName: string;
  ciAttempts: number;
  ticket?: Ticket;
}
const jobs = new Map<string, Job>();

/**
 * Branch names currently being worked on. Guards the window the PR-based dedup check can't see:
 * a second identical error arriving while the first is still mid-pipeline (before anything's been
 * pushed) would otherwise race to create the same git worktree. In-memory only — see the Job map
 * comment above for the same caveat.
 */
const inFlightBranches = new Set<string>();

/**
 * A stable id for "this error" — used as the branch name, which is what makes the repo host's
 * own PR list double as the dedup store (see RepoProvider.findExistingPullRequest). Prefers a
 * source-provided stable id (e.g. Sentry's grouped issue id) so repeated firings of the same
 * issue map to the same branch; falls back to hashing the whole payload for sources with no
 * recognizable id, which won't dedupe as well but is at least deterministic for identical
 * payloads.
 */
function fingerprintReport(report: ErrorReport): string {
  const data = report.data as Record<string, unknown> | undefined;
  const nested = data?.data as Record<string, unknown> | undefined;
  const issue = nested?.issue as Record<string, unknown> | undefined;
  const stableId = issue?.id ?? data?.id;
  const basis = stableId !== undefined ? String(stableId) : JSON.stringify(report.data);
  return createHash("sha256").update(basis).digest("hex").slice(0, 12);
}

/** Runs the app's configured test_cmd inside the worktree and captures pass/fail plus combined output, regardless of exit code. Pure local process execution — nothing to do with any repo host, so it stays here rather than in a provider. */
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

/**
 * Load config, resolve this app's providers, update the repo, then hand everything to the AI in
 * one call: the raw report, whether a PR already exists for this error's branch, and full repo
 * access. The AI is the single decision point — production vs. not, already handled vs. not, and
 * (if it decides to proceed) the fix itself. Nothing is created — no ticket, no branch pushed —
 * until it says so. If the AI isn't configured at all, this fails outright (NotImplementedError
 * propagates) rather than falling back to a ticket — a ticket without the AI's judgment isn't the
 * intended behavior. The GitHub Actions CI follow-up loop lives in handleCIResult below, since CI
 * completion arrives later as its own webhook event, not inline in this call.
 */
export async function reportError(report: ErrorReport): Promise<ReportErrorResult> {
  const config = getAppConfig(report.appId);
  const repo = getRepoProvider(config.repoProvider);
  const tracker = getTrackerProvider(config.trackerProvider);
  const messenger = getMessengerProvider(config.messengerProvider);
  const llm = getLLMProvider(config.aiProvider);

  const jobId = randomUUID();
  const branchName = `fix/${fingerprintReport(report)}`;

  if (inFlightBranches.has(branchName)) {
    return { jobId, appId: config.appId, status: "skipped", reason: "an identical error is already being processed" };
  }
  inFlightBranches.add(branchName);

  try {
    // Fetched deterministically (it's just a repo-host API call) — but what to do with it is the
    // AI's call, made together with the production/non-production judgment inside draftFix.
    const existingPR = await repo.findExistingPullRequest(config.repoUrl, branchName);

    const repoDir = await repo.ensureCloned(config);
    const worktreePath = await repo.createWorktree(config, repoDir, branchName);
    const job: Job = { jobId, appId: config.appId, worktreePath, branchName, ciAttempts: 0 };
    jobs.set(jobId, job);

    let draft: FixDraft | undefined;
    let skipReason: string | undefined;
    let lastTestOutput = "";

    for (let attempt = 1; attempt <= config.localMaxAttempts; attempt++) {
      const result = await llm.draftFix(report, config, worktreePath, existingPR);
      if (result.action === "skip") {
        skipReason = result.reason;
        break;
      }
      const testResult = await runLocalTests(config, worktreePath);
      if (testResult.passed) {
        draft = result.draft;
        break;
      }
      lastTestOutput = testResult.output;
    }

    if (skipReason) {
      await repo.removeWorktree(repoDir, worktreePath);
      return { jobId, appId: config.appId, status: "skipped", reason: skipReason };
    }

    const owners = draft ? await repo.blameAuthors(repoDir, draft.filesChanged) : [];
    const analysis = draft
      ? draft.summary
      : `AI drafted a fix but it never passed local tests after ${config.localMaxAttempts} attempts.\nLast failure:\n${lastTestOutput}`;
    const ticket = await tracker.createTicket(config, report, analysis, owners[0]);
    job.ticket = ticket;

    if (!draft) {
      await repo.removeWorktree(repoDir, worktreePath);
      await messenger.notify(config, ticket);
      return { jobId, appId: config.appId, ticket, status: "ticket_only" };
    }

    await repo.pushBranch(config, worktreePath, branchName);
    const pr = await repo.openPullRequest(config, branchName, draft.summary.slice(0, 72), ticket.url);
    await messenger.notify(config, ticket, pr);
    return { jobId, appId: config.appId, ticket, pullRequest: pr, status: "pr_pending_ci" };
  } finally {
    inFlightBranches.delete(branchName);
  }
}

/**
 * TODO: call this from a GitHub Actions webhook route (workflow_run / check_run completed).
 * On failure, fetch the job log via the repo provider's Checks API, feed it back through
 * draftFix for a revision, and push again — up to config.ciMaxAttempts — before leaving the PR
 * for a developer.
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
