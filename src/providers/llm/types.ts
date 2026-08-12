import type { AppConfig, DraftResult, ErrorReport } from "../../types.js";
import type { ExistingPullRequest } from "../repo/types.js";

/** The AI: Claude today, Codex later — the pipeline's single decision point (see DraftResult). */
export interface LLMProvider {
  draftFix(
    report: ErrorReport,
    config: AppConfig,
    worktreePath: string,
    existingPR: ExistingPullRequest | undefined,
  ): Promise<DraftResult>;
}
