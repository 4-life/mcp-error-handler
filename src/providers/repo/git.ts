import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/**
 * Provider-agnostic git plumbing — plain `git` CLI commands, identical regardless of host.
 * Takes an already-authenticated clone URL rather than doing auth itself; that's what makes
 * these reusable by any future GitLab/Bitbucket provider, not just GitHub.
 */
export async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile(cmd, args, { cwd });
  return stdout.trim();
}

export async function cloneOrPull(authedUrl: string, repoDir: string, defaultBranch: string): Promise<void> {
  if (!existsSync(join(repoDir, ".git"))) {
    await mkdir(dirname(repoDir), { recursive: true });
    await execFile("git", ["clone", authedUrl, repoDir]);
  } else {
    // Installation tokens expire hourly, so refresh the stored remote URL before every fetch.
    await run("git", ["remote", "set-url", "origin", authedUrl], repoDir);
    await run("git", ["fetch", "origin", defaultBranch], repoDir);
  }
}

export async function createWorktree(
  repoDir: string,
  branchName: string,
  worktreePath: string,
  defaultBranch: string,
): Promise<void> {
  await mkdir(dirname(worktreePath), { recursive: true });
  await run("git", ["worktree", "add", "-b", branchName, worktreePath, `origin/${defaultBranch}`], repoDir);
}

export async function removeWorktree(repoDir: string, worktreePath: string): Promise<void> {
  await run("git", ["worktree", "remove", "--force", worktreePath], repoDir).catch(() => undefined);
  await rm(worktreePath, { recursive: true, force: true });
}

/** Last committer's email per file — a stand-in for blaming the exact changed line ranges once draftFix reports them. */
export async function blameAuthors(repoDir: string, files: string[]): Promise<string[]> {
  const emails = await Promise.all(
    files.map((file) => run("git", ["log", "-1", "--format=%ae", "--", file], repoDir).catch(() => "")),
  );
  return [...new Set(emails.filter(Boolean))];
}
