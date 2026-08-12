# mcp-error-handler

An MCP server that turns an application error into a reviewed pull request, with a human as the only gate before merge.

## The idea

Wherever an error comes from — a Sentry alert, another tracker's webhook, or a developer just describing a bug — it lands on one entry point: `report_error(app_id, data)`. The server doesn't know or care which tracker produced `data`; it can be a provider's raw JSON payload or a plain-text description, and the AI agent is responsible for reading whichever shape it gets.

The server talks to a repo host (GitHub by default), a work tracker (Jira), an app-docs source (Confluence), a messenger (Slack), and an AI provider (Claude/Codex) — each swappable per app via a small plugin interface (see Providers below). Defaults are GitHub + Jira + Confluence + Slack; the only thing that stays source-agnostic no matter what is where the *error report* itself comes from.

From there, for the app identified by `app_id`, the server:

1. Loads that app's config (its repo, Jira project, Slack channel, Confluence space, test command).
2. Updates its own persistent checkout of the repo (`git pull`, then a `git worktree` for a throwaway local branch, `wip/<fingerprint>`) instead of cloning from scratch each time. The fingerprint is deterministic — derived from the error itself, not random — so the same error always maps to the same fingerprint.
3. Checks GitHub for a PR already tagged with that fingerprint (a marker embedded in the PR body, not a branch-name match — the public branch name is the Jira ticket key, which doesn't exist yet at this point). This is fetched either way, but nothing is decided from it yet in code — it's handed to the AI as context, not used as a hard pre-filter.
4. Has an AI agent read the error, that existing-PR info, the code, and the app's Confluence docs — and make the call: is this even worth acting on? Production or not, already handled or not. **Nothing downstream happens until it says so** — no ticket, no branch pushed, nothing. If it decides to proceed, it drafts a fix. If the AI provider isn't configured at all, the request just fails here; there's no ticket-without-AI fallback, because a ticket without that judgment isn't the intended behavior.
5. Runs the app's `test_cmd` locally, in the worktree. This is the fast, cheap check — no need to wait on a CI queue just to find out the fix doesn't even build. If it fails, the agent revises using the local failure output and reruns, up to a retry cap (default 3).
6. Opens a Jira ticket with the root-cause analysis — whether or not a passing fix came out of step 5 (a tried-and-failed attempt still needs a human to know about it) — and assigns it automatically by running `git blame` on the changed lines and resolving that author's email to a Jira account.
7. If local tests passed, pushes the local branch to GitHub under the public name `fix/<jira-key>` (e.g. `fix/CHK-42`) and opens a PR linked to the ticket — same key in both places, so they're obviously the same thing at a glance.
8. GitHub Actions CI still has to pass — it's the authoritative check, since it can catch things a local run can't (environment differences, integration jobs, flaky infra). If CI fails despite the local pass, the server pulls the failing job's log via the GitHub Checks API, feeds it back to the agent for another revision, and pushes an update to the same branch — up to its own retry cap (default 3). If CI still isn't green after that, the PR is left open with a comment explaining what was tried, and it's now the developer's problem to finish.
9. Posts the ticket (and the PR link, once one exists) to the app's Slack channel so the team sees it land.

The developer's job stays the same either way: review and merge a PR that's already passing CI, pick up one that ran out of retries, or start from a ticket that never got a passing automated fix.

![Flow: any error source calls one report_error tool; the orchestrator reads the repo and Confluence, drafts a fix, runs tests locally first, and only pushes a GitHub PR once local tests pass, with GitHub Actions CI as a second, authoritative check that loops the agent back on failure.](flow.svg)

*Any error source funnels into one ingestion call. The orchestrator pulls its own repo checkout plus the app's Confluence docs and drafts a fix, then runs the app's tests locally — fast feedback, no CI queue to wait on. A local pass (or no test command configured) pushes a PR; GitHub Actions CI is still the authoritative check, and a CI failure feeds its log back for another local revision, up to its own cap, before the PR is left for a developer either way. Slack gets notified regardless, and the assignee is resolved from `git blame`, not from the error source.*

## Per-app config

The server holds one small config per onboarded app — nothing app-specific lives in the target repo itself:

```yaml
app_id: checkout-service
repo_url: git@github.com:org/checkout-service.git
default_branch: main
repo_provider: github
tracker_provider: jira
docs_provider: confluence
messenger_provider: slack
jira_project_key: CHK
slack_channel: "#checkout-alerts"
confluence_space: CHK                # app documentation the agent reads for context
ai_provider: claude                  # which coding agent drafts the fix — claude | codex | ...
test_cmd: npm test                   # optional — omitting it skips straight to push + PR
default_assignee: jane@org.com       # fallback when git blame can't resolve a Jira user
local_max_attempts: 3                # revise-and-rerun attempts against test_cmd before giving up
ci_max_attempts: 3                   # revise-and-repush attempts against CI before flagging a developer
```

## Design decisions worth remembering

- **Source-agnostic ingestion, pluggable tooling.** The error report can come from anywhere (Sentry JSON, another tracker's webhook, a developer's sentence) via a thin per-provider webhook route that forwards into `report_error` — no per-provider parsing lives in the server. GitHub/Jira/Confluence/Slack are just the *defaults*; see the Providers bullet below for how each is swapped. MCP itself only speaks JSON-RPC, so providers hit plain webhook routes on the same server, not the MCP endpoint.
- **`draftFix` decides via structured output, and commits its own work.** `providers/llm/claude.ts` runs the Claude Agent SDK rooted at the fix worktree with `outputFormat: json_schema`, so the skip/fix decision (and the fix summary + changed files) comes back as validated JSON, not parsed prose. The agent is instructed to `git commit` its own change; a safety-net auto-commit catches anything left uncommitted so a forgetful run can't produce an empty PR. Confluence context is fetched best-effort — since `confluence.ts` is still a stub, the prompt just proceeds without it today.
- **Persistent worktrees, not fresh clones.** Each app's repo is checked out once at onboarding; every fix reuses it via `git pull` + `git worktree add`, which also keeps concurrent fixes for the same app from clobbering each other's working state.
- **Two gates, not one.** Local `test_cmd` runs first because waiting on a CI queue for feedback the repo can give you in seconds is wasteful — a fix that's obviously broken never leaves the worktree. GitHub Actions CI runs after, because it's the authoritative signal (integration jobs, environment differences a local run won't catch) and still gets its own revise loop when it disagrees with the local result. Each gate has its own retry cap so a genuinely broken app can't loop forever in either stage.
- **No `test_cmd` configured means no local gate**, not "block everything" — the fix goes straight to a PR and CI becomes the only check. This is what keeps the pipeline usable for apps that don't have reliable tests.
- **Assignee comes from the code, not the alert.** `git blame` on the touched lines is source-agnostic (works whether the error arrived as Sentry JSON or a developer's sentence) and more reliable than trying to infer ownership from the tracker. It depends on git commit email, Jira account email, and Slack identity all lining up — worth checking before relying on it.
- **Confluence is read-only context.** The agent consults the app's Confluence space (architecture notes, runbooks) when drafting a fix, the same way it reads the repo — it's an input to the analysis, not something the server writes back to.
- **The coding agent is swappable per app.** `ai_provider` picks which model/tool actually drafts the fix (Claude, Codex, …) — different apps can use different agents without changing any other part of the pipeline, since every downstream step (test gate, Jira, PR, Slack) only cares that a diff exists, not who wrote it.
- **Every external integration is a plugin, not a hardcoded call.** `orchestrator.ts` never talks to GitHub/Jira/Slack/Confluence/an LLM directly — it resolves a `RepoProvider`/`TrackerProvider`/`DocsProvider`/`MessengerProvider`/`LLMProvider` from `src/providers/*/index.ts` based on the app's config, and calls through that interface. Adding Bitbucket support means writing `providers/repo/bitbucket.ts` against the existing `RepoProvider` interface, registering it, and setting `repo_provider: bitbucket` on the apps that use it — `orchestrator.ts` doesn't change. Plain `git` CLI plumbing (clone, worktree, blame) lives in `providers/repo/git.ts`, shared by every repo-host provider rather than duplicated per host.

## Stack

Node.js + TypeScript, an Express server, packaged as a Docker image.

```
src/
  index.ts        Express app: mounts /mcp and /webhooks, error handling, requireSharedSecret auth
  mcp.ts           MCP server — registers the report_error tool (Streamable HTTP, stateless)
  webhooks.ts      Plain HTTP routes: /webhooks/{sentry,bugsnag,generic}/:appId
  orchestrator.ts  The pipeline itself — reportError() and handleCIResult() — resolves providers, sequences the pipeline, no integration-specific code
  auth.ts          requireSharedSecret — bearer-token check on every inbound route
  config.ts        Loads config/apps/*.yaml into AppConfig
  types.ts         Shared cross-cutting types (ErrorReport, AppConfig, Ticket, PullRequest, …)
  providers/
    repo/          RepoProvider interface + git.ts (shared plumbing) + github.ts (default) + index.ts (registry)
    tracker/       TrackerProvider interface + jira.ts (default) + index.ts
    docs/          DocsProvider interface + confluence.ts (default, stub — not called by anything yet)
    messenger/     MessengerProvider interface + slack.ts (default) + index.ts
    llm/           LLMProvider interface + claude.ts (real — Claude Agent SDK) + not-implemented.ts (codex stub) + index.ts
    registries.test.ts   All five registries resolve/reject correctly (node:test)
  config.test.ts   Unit tests (node:test, via tsx — no separate test framework)
config/apps/       One YAML file per onboarded app (see Per-app config above)
.github/workflows/ci.yml   typecheck + test + build, and a Docker build check, on every push/PR
```

**What's real vs. stubbed:** git plumbing, the local `test_cmd` runner, the GitHub App auth + PR-dedup lookup, Jira ticket creation, Slack notification, and `draftFix` for `ai_provider: claude` (via the Claude Agent SDK — `providers/llm/claude.ts`) are all fully implemented — `reportError` runs the whole pipeline for real, right up to opening the PR. Opening the PR itself (`RepoProvider.openPullRequest`, in `providers/repo/github.ts`) and `ai_provider: codex` (`providers/llm/not-implemented.ts`) are the two remaining stubs, throwing `NotImplementedError` with what's missing. The webhook/MCP routes surface that as a `501` with a clear message rather than pretending to succeed.

## Quick start

On a fresh server:

```bash
ssh root@your_server_ip
curl -o ~/start.sh https://raw.githubusercontent.com/4-life/mcp-error-handler/main/start.sh
chmod +x ~/start.sh && ./start.sh
```

[`start.sh`](start.sh) installs Docker if it's missing, clones the repo into `~/mcp-error-handler` (or `$APP_DIR`), copies `.env.example` to `.env` if there isn't one yet, and runs `docker compose up -d --build`. It prints the server's `/healthz`, MCP, and webhook URLs when done — nothing is wired to real Jira/GitHub/Slack/AI credentials yet, so edit `.env` and `config/apps/` afterward and re-run `docker compose up -d --build` to pick up the changes. Override `APP_DIR` or `PORT` as env vars before running the script if you need non-defaults.

## Running it

```bash
cp .env.example .env      # fill in credentials as integrations get wired up
cp config/apps/example.yaml config/apps/<your-app>.yaml
npm install
npm run dev                # tsx watch, http://localhost:3000
npm test                   # node:test, via tsx
npm run typecheck
```

Or as a container:

```bash
docker compose up --build
```

The MCP endpoint is `POST /mcp` (Streamable HTTP). Webhook routes are `POST /webhooks/sentry/:appId`, `/webhooks/bugsnag/:appId`, `/webhooks/generic/:appId` — point your tracker's webhook config (or a curl from a developer) at one of these with the app's `app_id` in the URL.
