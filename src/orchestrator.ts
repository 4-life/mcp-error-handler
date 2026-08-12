import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { getAppConfig } from "./config.js";
import { getRepoProvider } from "./providers/repo/index.js";
import { getTrackerProvider } from "./providers/tracker/index.js";
import { getMessengerProvider } from "./providers/messenger/index.js";
import { getLLMProvider } from "./providers/llm/index.js";
import { NotImplementedError } from "./errors.js";
import type { AppConfig, ErrorReport, FixDraft, PriorAttempt, ReportErrorResult, Ticket, TestRunResult } from "./types.js";

/** In-memory job state so a later CI webhook can find its way back to the right worktree/branch/attempt count. Swap for real storage before running more than one replica. */
interface Job {
  jobId: string;
  appId: string;
  worktreePath: string;
  /** The scratch branch inside the worktree — never pushed under this name. */
  localBranchName: string;
  /** The public GitHub branch name (`fix/<jira-key>`) — only known once the ticket exists. */
  remoteBranchName?: string;
  ciAttempts: number;
  ticket?: Ticket;
}
const jobs = new Map<string, Job>();

/**
 * Fingerprints currently being worked on. Guards the window the PR-based dedup check can't see:
 * a second identical error arriving while the first is still mid-pipeline (before anything's been
 * pushed) would otherwise race to create the same git worktree. In-memory only — see the Job map
 * comment above for the same caveat.
 */
const inFlightFingerprints = new Set<string>();

/** Caps how many draftFix calls (the slow, costly, rate-limited part) run at once, queuing the rest — unrelated to inFlightFingerprints, which caps duplicates of the *same* error rather than total load. */
class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.available = limit;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.available += 1;
    }
  }
}
const draftSemaphore = new Semaphore(Number(process.env.MAX_CONCURRENT_DRAFTS ?? 3));

/**
 * A stable id for "this error" — the dedup key (see RepoProvider.findExistingPullRequestByFingerprint)
 * and the in-flight lock key. Prefers a source-provided stable id (e.g. Sentry's grouped issue id)
 * so repeated firings of the same issue map to the same fingerprint; falls back to hashing the
 * whole payload for sources with no recognizable id, which won't dedupe as well but is at least
 * deterministic for identical payloads.
 */
function fingerprintReport(report: ErrorReport): string {
  const data = report.data as Record<string, unknown> | undefined;
  const nested = data?.data as Record<string, unknown> | undefined;
  const issue = nested?.issue as Record<string, unknown> | undefined;
  const stableId = issue?.id ?? data?.id;
  const basis = stableId !== undefined ? String(stableId) : JSON.stringify(report.data);
  return createHash("sha256").update(basis).digest("hex").slice(0, 12);
}

function detectInstallCmd(worktreePath: string): string | undefined {
  if (existsSync(join(worktreePath, "yarn.lock"))) return "yarn install --frozen-lockfile";
  if (existsSync(join(worktreePath, "package-lock.json"))) return "npm ci";
  if (existsSync(join(worktreePath, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile";
  if (existsSync(join(worktreePath, "package.json"))) return "npm install";
  return undefined; // not an npm project — nothing to install
}

/**
 * `git worktree add` only checks out tracked files — node_modules is gitignored, so a fresh
 * worktree has no dependencies installed at all. Without this, the AI (and runLocalTests right
 * after it) would hit a completely broken environment: no test runner, no linter, nothing
 * actually runnable, for every single attempt. Uses config.installCmd if set, otherwise
 * auto-detects from whichever lockfile is present. Failure here is fatal — there's no point
 * spending AI budget in an environment that can't run anything.
 */
async function installDependencies(config: AppConfig, worktreePath: string): Promise<void> {
  const cmd = config.installCmd ?? detectInstallCmd(worktreePath);
  if (!cmd) return;
  const exec = promisify(execCb);
  await exec(cmd, { cwd: worktreePath });
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
 * one call: the raw report, whether a PR already exists for this error, and full repo access. The
 * AI is the single decision point — production vs. not, already handled vs. not, and (if it
 * decides to proceed) the fix itself. Nothing is created — no ticket, no branch pushed — until it
 * says so. If the AI isn't configured at all, this fails outright (NotImplementedError propagates)
 * rather than falling back to a ticket — a ticket without the AI's judgment isn't the intended
 * behavior. The public branch name is the Jira ticket key (`fix/<jira-key>`), so it can't be
 * chosen until the ticket exists — the worktree uses a throwaway local name (`wip/<fingerprint>`)
 * until then, pushed under the real name at the very end. The GitHub Actions CI follow-up loop
 * lives in handleCIResult below, since CI completion arrives later as its own webhook event, not
 * inline in this call.
 */
export async function reportError(report: ErrorReport): Promise<ReportErrorResult> {
  const config = getAppConfig(report.appId);
  const repo = getRepoProvider(config.repoProvider);
  const tracker = getTrackerProvider(config.trackerProvider);
  const messenger = getMessengerProvider(config.messengerProvider);
  const llm = getLLMProvider(config.aiProvider);

  const jobId = randomUUID();
  const fingerprint = fingerprintReport(report);
  const localBranchName = `wip/${fingerprint}`;
  const log = (msg: string) => console.log(`reportError[${fingerprint}] ${config.appId}: ${msg}`);

  if (inFlightFingerprints.has(fingerprint)) {
    return { jobId, appId: config.appId, status: "skipped", reason: "an identical error is already being processed" };
  }
  inFlightFingerprints.add(fingerprint);
  log("accepted, starting pipeline");

  try {
    // Fetched deterministically (it's just a repo-host API call) — but what to do with it is the
    // AI's call, made together with the production/non-production judgment inside draftFix.
    log("checking for an existing PR");
    const existingPR = await repo.findExistingPullRequestByFingerprint(config.repoUrl, fingerprint);

    log("cloning/pulling repo");
    const repoDir = await repo.ensureCloned(config);
    log(`creating worktree at branch ${localBranchName}`);
    const worktreePath = await repo.createWorktree(config, repoDir, localBranchName);
    log(`worktree ready: ${worktreePath}`);
    const job: Job = { jobId, appId: config.appId, worktreePath, localBranchName, ciAttempts: 0 };
    jobs.set(jobId, job);

    let draft: FixDraft | undefined;
    let skipReason: string | undefined;
    let lastTestOutput = "";
    let priorAttempt: PriorAttempt | undefined;

    try {
      log("installing dependencies");
      await installDependencies(config, worktreePath);
      for (let attempt = 1; attempt <= config.localMaxAttempts; attempt++) {
        log(`draftFix attempt ${attempt}/${config.localMaxAttempts}`);
        await draftSemaphore.acquire();
        let result;
        try {
          result = await llm.draftFix(report, config, worktreePath, existingPR, priorAttempt);
        } finally {
          draftSemaphore.release();
        }
        if (result.action === "skip") {
          skipReason = result.reason;
          break;
        }
        if (result.action === "incomplete") {
          // Don't retry — a fresh attempt gets the same turn/budget cap and no new information,
          // so it would most likely just hit the same wall again at further cost.
          lastTestOutput = result.reason;
          break;
        }
        log("running local tests");
        const testResult = await runLocalTests(config, worktreePath);
        log(`local tests ${testResult.passed ? "passed" : "failed"}`);
        if (testResult.passed) {
          draft = result.draft;
          break;
        }
        lastTestOutput = testResult.output;
        // Fed into the next attempt's prompt so it isn't flying blind on retry — can tell a real
        // assertion failure from its own fix apart from the test command being broken outright.
        priorAttempt = { summary: result.draft.summary, testOutput: testResult.output };
      }
    } catch (err) {
      // Clean up so a retry of the same error isn't blocked by `git worktree add -b` refusing
      // to recreate a branch this failed attempt left behind.
      await repo.removeWorktree(repoDir, worktreePath).catch(() => undefined);
      throw err;
    }

    if (skipReason) {
      log(`skipped — ${skipReason}`);
      await repo.removeWorktree(repoDir, worktreePath);
      return { jobId, appId: config.appId, status: "skipped", reason: skipReason };
    }

    const owners = draft ? await repo.blameAuthors(repoDir, draft.filesChanged) : [];
    const analysis = draft
      ? draft.summary
      : `AI attempted a fix but didn't produce a working one after ${config.localMaxAttempts} attempt(s).\nDetails:\n${lastTestOutput}`;
    log("creating Jira ticket");
    const ticket = await tracker.createTicket(config, report, analysis, owners[0]);
    job.ticket = ticket;
    log(`ticket created: ${ticket.key}`);

    if (!draft) {
      await repo.removeWorktree(repoDir, worktreePath);
      await messenger.notify(config, ticket);
      return { jobId, appId: config.appId, ticket, status: "ticket_only" };
    }

    const remoteBranchName = `fix/${ticket.key}`;
    job.remoteBranchName = remoteBranchName;
    log(`pushing branch as ${remoteBranchName}`);
    await repo.pushBranch(config, worktreePath, localBranchName, remoteBranchName);
    log("opening PR");
    const pr = await repo.openPullRequest(config, remoteBranchName, draft.summary.slice(0, 72), ticket.url, fingerprint);
    await messenger.notify(config, ticket, pr);
    return { jobId, appId: config.appId, ticket, pullRequest: pr, status: "pr_pending_ci" };
  } finally {
    inFlightFingerprints.delete(fingerprint);
  }
}

/**
 * Fire-and-forget entry point for webhook routes, where the sender (Sentry's webhook delivery,
 * for instance) likely has its own timeout far shorter than a multi-minute AI-driven run.
 * Validates synchronously (bad app_id, already-in-flight) so those still surface immediately to
 * the caller — only the slow part (the actual pipeline) runs in the background. reportError()
 * itself is unchanged and still fully awaitable for callers that want the real result inline
 * (the MCP tool, manual testing).
 */
export function reportErrorAsync(report: ErrorReport): { fingerprint: string; accepted: boolean } {
  const config = getAppConfig(report.appId); // throws synchronously on an unknown app_id, surfacing immediately
  const fingerprint = fingerprintReport(report);
  if (inFlightFingerprints.has(fingerprint)) {
    return { fingerprint, accepted: false };
  }
  reportError(report).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`reportError failed for app "${report.appId}" (fingerprint ${fingerprint}):`, err);
    // Best-effort — if the failure is Slack itself (bad token, rate limit), this would just fail
    // again; log rather than let a second throw escape this .catch() as an unhandled rejection.
    getMessengerProvider(config.messengerProvider)
      .alertError(config, `Fingerprint \`${fingerprint}\`: ${message}`)
      .catch((alertErr) => console.error("Also failed to send the Slack alert for that failure:", alertErr));
  });
  return { fingerprint, accepted: true };
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
