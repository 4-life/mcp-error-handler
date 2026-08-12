import { NotImplementedError } from "../../errors.js";
import type { AppConfig, DraftResult, ErrorReport, PriorAttempt } from "../../types.js";
import type { ExistingPullRequest } from "../repo/types.js";
import type { LLMProvider } from "./types.js";

/**
 * TODO: replace with a real Codex integration, following the same pattern as claude.ts (the
 * pipeline's single decision point — production vs. not, already handled vs. not, before ever
 * writing a diff — not just the fix-writer). Currently backs only the "codex" registry entry;
 * "claude" has a real implementation in claude.ts.
 */
async function draftFix(
  report: ErrorReport,
  config: AppConfig,
  worktreePath: string,
  existingPR: ExistingPullRequest | undefined,
  priorAttempt: PriorAttempt | undefined,
): Promise<DraftResult> {
  throw new NotImplementedError(
    "draftFix",
    `no integration for ai_provider "${config.aiProvider}" — worktree ready at ${worktreePath}, ` +
      `existing PR: ${existingPR ? `#${existingPR.number} (${existingPR.state})` : "none"}`,
  );
}

export const notImplementedLLMProvider: LLMProvider = { draftFix };
