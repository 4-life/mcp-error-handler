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
  /** Create a git worktree for localBranchName off config.defaultBranch; returns the worktree path. */
  createWorktree(config: AppConfig, repoDir: string, localBranchName: string): Promise<string>;
  removeWorktree(repoDir: string, worktreePath: string): Promise<void>;
  /** Last-committer email per file — used for git-blame-based assignee resolution. */
  blameAuthors(repoDir: string, files: string[]): Promise<string[]>;
  /**
   * Is there already a PR for this error? Looked up by a fingerprint marker embedded in the PR
   * body (see openPullRequest) rather than by branch name — the branch name is the ticket key,
   * which doesn't exist yet at the point this check runs. Context for the AI's decision, not a
   * hard gate.
   */
  findExistingPullRequestByFingerprint(repoUrl: string, fingerprint: string): Promise<ExistingPullRequest | undefined>;
  /** Pushes the local worktree branch to the remote under a (likely different) public name — e.g. the local scratch branch to `fix/<jira-key>`. */
  pushBranch(config: AppConfig, worktreePath: string, localBranchName: string, remoteBranchName: string): Promise<void>;
  /** fingerprint gets embedded in the PR body so findExistingPullRequestByFingerprint can find this PR later. */
  openPullRequest(
    config: AppConfig,
    remoteBranchName: string,
    title: string,
    body: string,
    fingerprint: string,
  ): Promise<PullRequest>;
}
