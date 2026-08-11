import { readFile } from "node:fs/promises";
import { createSign } from "node:crypto";
import { NotImplementedError } from "./errors.js";

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
export async function getInstallationToken(): Promise<string> {
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

/** Rewrites a repo_url (ssh or https form) into an HTTPS URL authenticated with a fresh installation token. */
export async function authenticatedCloneUrl(repoUrl: string): Promise<string> {
  const match = repoUrl.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>.+?)(?:\.git)?$/);
  if (!match?.groups) throw new Error(`Not a recognizable GitHub repo_url: ${repoUrl}`);
  const token = await getInstallationToken();
  return `https://x-access-token:${token}@github.com/${match.groups.owner}/${match.groups.repo}.git`;
}