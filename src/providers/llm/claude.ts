import { existsSync } from "node:fs";
import { z } from "zod";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getDocsProvider } from "../docs/index.js";
import { run } from "../repo/git.js";
import type { AppConfig, DraftResult, ErrorReport } from "../../types.js";
import type { ExistingPullRequest } from "../repo/types.js";
import type { LLMProvider } from "./types.js";

const MAX_TURNS = 30;
/** Per-session cap — the SDK itself stops the query and returns `error_max_budget_usd` if a single draftFix run exceeds this. */
const MAX_USD_PER_DRAFT = Number(process.env.MAX_USD_PER_DRAFT ?? 2);
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
): string {
  const sections = [
    `You are triaging an automatically-reported error for the app "${config.appId}".`,
    `## Error report (source: ${report.source})\n${JSON.stringify(report.data, null, 2)}`,
    `## Existing pull request for this error\n${
      existingPR ? `#${existingPR.number} (${existingPR.state}): ${existingPR.url}` : "None found."
    }`,
  ];
  if (docsContext) sections.push(`## App documentation\n${docsContext}`);
  sections.push(
    [
      "## Your task",
      '1. Decide whether this is worth acting on: is it a production error (not dev/staging noise), and is it not already handled (see the existing PR above — open or closed both count as already handled)? If either check fails, respond with action "skip" and a one-sentence reason, without reading or editing any files.',
      "2. If it's worth acting on: investigate the code in your current working directory, find the root cause, and make the smallest correct fix.",
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
  const prompt = buildPrompt(report, config, existingPR, docsContext);

  const stream = query({
    prompt,
    options: {
      cwd: worktreePath,
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
    throw new Error(`draftFix: agent session failed (${final.subtype}): ${final.errors?.join("; ") ?? "no details"}`);
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
