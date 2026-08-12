import { readFile } from "node:fs/promises";
import { createSign } from "node:crypto";
import { join } from "node:path";
import { NotImplementedError } from "../../errors.js";
import type { AppConfig, PullRequest } from "../../types.js";
import * as git from "./git.js";
import type { ExistingPullRequest, RepoProvider } from "./types.js";

const REPO_CACHE_DIR = process.env.REPO_CACHE_DIR ?? join(process.cwd(), "data", "repos");
const WORKTREE_DIR = process.env.WORKTREE_DIR ?? join(process.cwd(), "data", "worktrees");

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function signAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // Backdate iat and keep the lifetime short — GitHub rejects JWTs valid for more than 10 minutes.
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).end().sign(privateKeyPem, "base64url");
  return `${header}.${payload}.${signature}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}
let cached: CachedToken | undefined;

/**
 * Mints (and caches) a ~1hr GitHub App installation access token. Used to authenticate git
 * clone/fetch/push over HTTPS as well as the PR and Checks API calls — one credential for all
 * of it, rather than a separate SSH deploy key per repo.
 */
async function getInstallationToken(): Promise<string> {
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;

  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!appId || !installationId || !keyPath) {
    throw new NotImplementedError(
      "getInstallationToken",
      "set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY_PATH in .env",
    );
  }

  const privateKeyPem = await readFile(keyPath, "utf8");
  const jwt = signAppJwt(appId, privateKeyPem);
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub App token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  cached = { token: data.token, expiresAt: new Date(data.expires_at).getTime() };
  return cached.token;
}

export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } {
  const match = repoUrl.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>.+?)(?:\.git)?$/);
  if (!match?.groups) throw new Error(`Not a recognizable GitHub repo_url: ${repoUrl}`);
  return { owner: match.groups.owner, repo: match.groups.repo };
}

/** Rewrites a repo_url (ssh or https form) into an HTTPS URL authenticated with a fresh installation token. */
async function authenticatedCloneUrl(repoUrl: string): Promise<string> {
  const { owner, repo } = parseGitHubRepo(repoUrl);
  const token = await getInstallationToken();
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

async function githubApi(path: string, init?: RequestInit): Promise<Response> {
  const token = await getInstallationToken();
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init?.headers,
    },
  });
}

async function ensureCloned(config: AppConfig): Promise<string> {
  const repoDir = join(REPO_CACHE_DIR, config.appId);
  const authedUrl = await authenticatedCloneUrl(config.repoUrl);
  await git.cloneOrPull(authedUrl, repoDir, config.defaultBranch);
  return repoDir;
}

async function createWorktree(config: AppConfig, repoDir: string, localBranchName: string): Promise<string> {
  const worktreePath = join(WORKTREE_DIR, config.appId, localBranchName);
  await git.createWorktree(repoDir, localBranchName, worktreePath, config.defaultBranch);
  return worktreePath;
}

const fingerprintMarker = (fingerprint: string) => `<!-- mcp-error-handler-fingerprint: ${fingerprint} -->`;

/**
 * Searches PR bodies for the fingerprint marker openPullRequest embeds — not a branch-name
 * lookup, since the public branch name is the Jira ticket key, which doesn't exist yet at the
 * point this check runs (it's fetched before the ticket does). Doubles as the dedup check: no
 * separate database of "have we seen this error before" needed, GitHub's own search already is
 * one. Note: GitHub's search API has a much lower rate limit than the regular REST API.
 */
async function findExistingPullRequestByFingerprint(repoUrl: string, fingerprint: string): Promise<ExistingPullRequest | undefined> {
  const { owner, repo } = parseGitHubRepo(repoUrl);
  const query = encodeURIComponent(`repo:${owner}/${repo} is:pr "${fingerprint}" in:body`);
  const res = await githubApi(`/search/issues?q=${query}`);
  if (!res.ok) {
    throw new Error(`GitHub PR search failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { items: Array<{ number: number; html_url: string; state: string }> };
  const pr = data.items[0];
  return pr ? { number: pr.number, url: pr.html_url, state: pr.state } : undefined;
}

async function pushBranch(config: AppConfig, worktreePath: string, localBranchName: string, remoteBranchName: string): Promise<void> {
  const authedUrl = await authenticatedCloneUrl(config.repoUrl);
  await git.run("git", ["remote", "set-url", "origin", authedUrl], worktreePath);
  await git.run("git", ["push", "-u", "origin", `${localBranchName}:${remoteBranchName}`], worktreePath);
}

/** TODO: implement — POST /repos/{owner}/{repo}/pulls once there's a real fix to open a PR for. Must include fingerprintMarker(fingerprint) in the body so findExistingPullRequestByFingerprint can find this PR later. */
async function openPullRequest(
  config: AppConfig,
  remoteBranchName: string,
  title: string,
  body: string,
  fingerprint: string,
): Promise<PullRequest> {
  throw new NotImplementedError(
    "openPullRequest",
    `branch ${remoteBranchName} is pushed — needs the PR-creation call against ${config.repoUrl} ("${title}"), ` +
      `body must include ${fingerprintMarker(fingerprint)}`,
  );
}

export const githubRepoProvider: RepoProvider = {
  ensureCloned,
  createWorktree,
  removeWorktree: git.removeWorktree,
  blameAuthors: git.blameAuthors,
  findExistingPullRequestByFingerprint,
  pushBranch,
  openPullRequest,
};
