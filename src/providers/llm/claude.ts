import { existsSync } from "node:fs";
import { z } from "zod";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getDocsProvider } from "../docs/index.js";
import { run } from "../repo/git.js";
import type { AppConfig, DraftResult, ErrorReport, PriorAttempt } from "../../types.js";
import type { ExistingPullRequest } from "../repo/types.js";
import type { LLMProvider } from "./types.js";

const MAX_TURNS = 30;
/** Result subtypes meaning "the AI genuinely tried and spent real cost, but hit a budget limit" — not a bug in this pipeline, so these become an "incomplete" DraftResult (→ a ticket for a human) rather than a thrown error. Anything else (e.g. error_during_execution) still throws — that's a real, unexpected failure worth alerting on. */
const INCOMPLETE_SUBTYPES = new Set(["error_max_turns", "error_max_budget_usd"]);
/** Pinned rather than left to the SDK's default — Sonnet is the cost/capability balance for real bug-fixing work; drop to a Haiku model for more aggressive cost cutting if quality allows. */
const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5";
/** Per-session cap — the SDK itself stops the query and returns `error_max_budget_usd` if a single draftFix run exceeds this. Real observed sessions so far ran $0.16–$0.79, so $1 still leaves headroom without being as permissive as the old $2 default. */
const MAX_USD_PER_DRAFT = Number(process.env.MAX_USD_PER_DRAFT ?? 1);
/** Cumulative cap across every session this process has run — the safety net a per-session cap alone can't provide against an error storm spawning many distinct sessions. In-memory, resets on restart, same caveat as everything else that's process-local in this codebase. */
const MAX_TOTAL_USD = Number(process.env.MAX_TOTAL_USD ?? 50);
let cumulativeSpendUsd = 0;

const resultSchema = z.union([
  z.object({ action: z.literal("skip"), reason: z.string() }),
  z.object({ action: z.literal("fix"), summary: z.string(), filesChanged: z.array(z.string()) }),
]);

const outputJsonSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["skip", "fix"] },
    reason: { type: "string" },
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
  },
  required: ["action"],
  additionalProperties: false,
};

/** Best-effort — Confluence isn't implemented yet, so this quietly proceeds without docs rather than fail the whole draft. */
async function getDocsContext(config: AppConfig): Promise<string | undefined> {
  if (!config.confluenceSpace) return undefined;
  try {
    return await getDocsProvider(config.docsProvider).fetchDocs(config);
  } catch {
    return undefined;
  }
}

function buildPrompt(
  report: ErrorReport,
  config: AppConfig,
  existingPR: ExistingPullRequest | undefined,
  docsContext: string | undefined,
  priorAttempt: PriorAttempt | undefined,
): string {
  const sections = [
    `You are triaging an automatically-reported error for the app "${config.appId}".`,
    `## Error report (source: ${report.source})\n${JSON.stringify(report.data, null, 2)}`,
    `## Existing pull request for this error\n${
      existingPR ? `#${existingPR.number} (${existingPR.state}): ${existingPR.url}` : "None found."
    }`,
  ];
  if (docsContext) sections.push(`## App documentation\n${docsContext}`);
  if (priorAttempt) {
    sections.push(
      `## Previous attempt (this is a retry)\nYour last attempt: ${priorAttempt.summary}\n\nRunning the test command afterward produced:\n${priorAttempt.testOutput}`,
    );
  }
  sections.push(
    [
      "## Your task",
      '1. Decide whether this is worth acting on: is it a production error (not dev/staging noise), and is it not already handled (see the existing PR above — open or closed both count as already handled)? If either check fails, respond with action "skip" and a one-sentence reason, without reading or editing any files.',
      "2. If it's worth acting on: check the error report above for a stack trace or file reference first — if one's there, go straight to that file and line rather than exploring the codebase broadly. Find the root cause and make the smallest correct fix.",
      ...(priorAttempt
        ? [
            '2a. This is a retry — look at the previous attempt\'s test output above. If it looks like a real assertion failure caused by that attempt\'s change, fix it properly. If it looks like the test command itself is broken (missing tooling, config errors, infrastructure the fix has no bearing on) rather than a real failure related to the bug, say so — respond with action "incomplete" and explain what\'s actually broken, rather than repeating the same approach.',
          ]
        : []),
      '3. Commit your change: `git add -A && git commit -m "<short message>"`. Do not push or open a PR — that happens outside this session.',
      '4. Respond with action "fix", a one-paragraph summary (used as the ticket description and PR title), and the relative paths of the files you changed.',
      "Respond only via the structured output — nothing else is read from your reply.",
    ].join("\n"),
  );
  return sections.join("\n\n");
}

/** Auto-commits any edits the agent forgot to commit itself, so a forgetful agent can't produce an empty PR. */
async function ensureCommitted(worktreePath: string, summary: string): Promise<void> {
  const status = await run("git", ["status", "--porcelain"], worktreePath);
  if (!status) return;
  await run("git", ["add", "-A"], worktreePath);
  await run("git", ["commit", "-m", summary.slice(0, 72) || "Automated fix"], worktreePath);
}

async function draftFix(
  report: ErrorReport,
  config: AppConfig,
  worktreePath: string,
  existingPR: ExistingPullRequest | undefined,
  priorAttempt: PriorAttempt | undefined,
): Promise<DraftResult> {
  if (cumulativeSpendUsd >= MAX_TOTAL_USD) {
    throw new Error(
      `draftFix: cumulative AI spend ($${cumulativeSpendUsd.toFixed(2)}) has reached the MAX_TOTAL_USD cap ` +
        `($${MAX_TOTAL_USD}) — refusing to start another session. Restart the server or raise MAX_TOTAL_USD to resume.`,
    );
  }
  if (!existsSync(worktreePath)) {
    // The SDK spawns the Claude binary with cwd: worktreePath — if that directory doesn't exist,
    // the spawn fails with a confusing "binary failed to launch" ENOENT that looks like a broken
    // install, not a missing cwd. Fail loudly and specifically instead.
    throw new Error(`draftFix: worktree directory does not exist: ${worktreePath}`);
  }

  const docsContext = await getDocsContext(config);
  const prompt = buildPrompt(report, config, existingPR, docsContext, priorAttempt);

  const stream = query({
    prompt,
    options: {
      cwd: worktreePath,
      model: MODEL,
      allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: MAX_TURNS,
      maxBudgetUsd: MAX_USD_PER_DRAFT,
      outputFormat: { type: "json_schema", schema: outputJsonSchema },
    },
  });

  let final: { subtype: string; structured_output?: unknown; errors?: string[]; total_cost_usd: number } | undefined;
  for await (const message of stream) {
    if (message.type === "result") final = message;
  }

  if (!final) {
    throw new Error("draftFix: agent session ended without a result message");
  }

  // Count cost regardless of outcome — a failed/budget-capped session still burns real tokens.
  cumulativeSpendUsd += final.total_cost_usd;
  console.log(
    `draftFix: session cost $${final.total_cost_usd.toFixed(4)}, cumulative $${cumulativeSpendUsd.toFixed(2)} / $${MAX_TOTAL_USD} cap`,
  );

  if (final.subtype !== "success") {
    const detail = `${final.subtype}: ${final.errors?.join("; ") ?? "no details"}`;
    if (INCOMPLETE_SUBTYPES.has(final.subtype)) {
      return { action: "incomplete", reason: `AI ran out of budget before finishing (${detail})` };
    }
    throw new Error(`draftFix: agent session failed (${detail})`);
  }

  const parsed = resultSchema.safeParse(final.structured_output);
  if (!parsed.success) {
    throw new Error(`draftFix: agent's structured output didn't match the expected shape: ${parsed.error.message}`);
  }
  const output = parsed.data;

  if (output.action === "skip") {
    return { action: "skip", reason: output.reason };
  }

  await ensureCommitted(worktreePath, output.summary);

  return { action: "fix", draft: { summary: output.summary, filesChanged: output.filesChanged } };
}

export const claudeLLMProvider: LLMProvider = { draftFix };
