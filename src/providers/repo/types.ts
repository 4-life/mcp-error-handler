import type { AppConfig, PullRequest } from "../../types.js";

export interface ExistingPullRequest {
  number: number;
  url: string;
  state: string;
}

/** A code-hosting platform: GitHub today, GitLab/Bitbucket implement the same shape later. */
export interface RepoProvider {
  /** Clone or fast-forward pull the app's repo into the local cache; returns the repo dir. */
  ensureCloned(config: AppConfig): Promise<string>;
  /** Create a git worktree for branchName off config.defaultBranch; returns the worktree path. */
  createWorktree(config: AppConfig, repoDir: string, branchName: string): Promise<string>;
  removeWorktree(repoDir: string, worktreePath: string): Promise<void>;
  /** Last-committer email per file — used for git-blame-based assignee resolution. */
  blameAuthors(repoDir: string, files: string[]): Promise<string[]>;
  /** Does branchName already have a PR (open or closed)? Context for the AI's decision, not a hard gate. */
  findExistingPullRequest(repoUrl: string, branchName: string): Promise<ExistingPullRequest | undefined>;
  pushBranch(config: AppConfig, worktreePath: string, branchName: string): Promise<void>;
  openPullRequest(config: AppConfig, branchName: string, title: string, body: string): Promise<PullRequest>;
}
