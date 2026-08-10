# mcp-error-handler

An MCP server that turns an application error into a reviewed pull request, with a human as the only gate before merge.

## The idea

Wherever an error comes from — a Sentry alert, another tracker's webhook, or a developer just describing a bug — it lands on one entry point: `report_error(app_id, data)`. The server doesn't know or care which tracker produced `data`; it can be a provider's raw JSON payload or a plain-text description, and the AI agent is responsible for reading whichever shape it gets.

The server assumes every onboarded app lives on GitHub, tracks work in Jira, and has a Slack channel — that's fixed, not pluggable. The only thing that stays source-agnostic is where the *error report* comes from.

From there, for the app identified by `app_id`, the server:

1. Loads that app's config (its repo, Jira project, Slack channel, Confluence space, test command).
2. Updates its own persistent checkout of the repo (`git pull`, then a `git worktree` for the fix branch) instead of cloning from scratch each time.
3. Has an AI agent read the error, the code, and the app's Confluence docs, and draft a fix.
4. Opens a Jira ticket with the root-cause analysis, and assigns it automatically by running `git blame` on the changed lines and resolving that author's email to a Jira account.
5. Runs the app's `test_cmd` locally, in the worktree. This is the fast, cheap check — no need to wait on a CI queue just to find out the fix doesn't even build. If it fails, the agent revises using the local failure output and reruns, up to a retry cap (default 3). If it's still failing after that, the fix is dropped: no push, the ticket stays as analysis only.
6. Once local tests pass (or the app has no `test_cmd` configured at all), the agent commits, pushes the branch, and opens a GitHub PR linked to the ticket.
7. GitHub Actions CI still has to pass — it's the authoritative check, since it can catch things a local run can't (environment differences, integration jobs, flaky infra). If CI fails despite the local pass, the server pulls the failing job's log via the GitHub Checks API, feeds it back to the agent for another revision, and pushes an update to the same branch — up to its own retry cap (default 3). If CI still isn't green after that, the PR is left open with a comment explaining what was tried, and it's now the developer's problem to finish.
8. Posts the ticket (and the PR link, once one exists) to the app's Slack channel so the team sees it land.

The developer's job stays the same either way: review and merge a PR that's already passing CI, pick up one that ran out of retries, or start from a ticket that never got an automated fix at all.

![Flow: any error source calls one report_error tool; the orchestrator reads the repo and Confluence, drafts a fix, runs tests locally first, and only pushes a GitHub PR once local tests pass, with GitHub Actions CI as a second, authoritative check that loops the agent back on failure.](flow.svg)

*Any error source funnels into one ingestion call. The orchestrator pulls its own repo checkout plus the app's Confluence docs and drafts a fix, then runs the app's tests locally — fast feedback, no CI queue to wait on. A local pass (or no test command configured) pushes a PR; GitHub Actions CI is still the authoritative check, and a CI failure feeds its log back for another local revision, up to its own cap, before the PR is left for a developer either way. Slack gets notified regardless, and the assignee is resolved from `git blame`, not from the error source.*

## Per-app config

The server holds one small config per onboarded app — nothing app-specific lives in the target repo itself:

```yaml
app_id: checkout-service
repo_url: git@github.com:org/checkout-service.git   # GitHub, always
default_branch: main
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

- **Source-agnostic ingestion, fixed tooling.** The error report can come from anywhere (Sentry JSON, another tracker's webhook, a developer's sentence) via a thin per-provider webhook route that forwards into `report_error` — no per-provider parsing lives in the server. But GitHub, Jira, and Slack are fixed assumptions, not pluginized; the server talks to their APIs directly. MCP itself only speaks JSON-RPC, so providers hit plain webhook routes on the same server, not the MCP endpoint.
- **Persistent worktrees, not fresh clones.** Each app's repo is checked out once at onboarding; every fix reuses it via `git pull` + `git worktree add`, which also keeps concurrent fixes for the same app from clobbering each other's working state.
- **Two gates, not one.** Local `test_cmd` runs first because waiting on a CI queue for feedback the repo can give you in seconds is wasteful — a fix that's obviously broken never leaves the worktree. GitHub Actions CI runs after, because it's the authoritative signal (integration jobs, environment differences a local run won't catch) and still gets its own revise loop when it disagrees with the local result. Each gate has its own retry cap so a genuinely broken app can't loop forever in either stage.
- **No `test_cmd` configured means no local gate**, not "block everything" — the fix goes straight to a PR and CI becomes the only check. This is what keeps the pipeline usable for apps that don't have reliable tests.
- **Assignee comes from the code, not the alert.** `git blame` on the touched lines is source-agnostic (works whether the error arrived as Sentry JSON or a developer's sentence) and more reliable than trying to infer ownership from the tracker. It depends on git commit email, Jira account email, and Slack identity all lining up — worth checking before relying on it.
- **Confluence is read-only context.** The agent consults the app's Confluence space (architecture notes, runbooks) when drafting a fix, the same way it reads the repo — it's an input to the analysis, not something the server writes back to.
- **The coding agent is swappable per app.** `ai_provider` picks which model/tool actually drafts the fix (Claude, Codex, …) — different apps can use different agents without changing any other part of the pipeline, since every downstream step (test gate, Jira, PR, Slack) only cares that a diff exists, not who wrote it.

## Stack

Node.js + TypeScript, an Express server, packaged as a Docker image.

```
src/
  index.ts        Express app: mounts /mcp and /webhooks, error handling
  mcp.ts           MCP server — registers the report_error tool (Streamable HTTP, stateless)
  webhooks.ts      Plain HTTP routes: /webhooks/{sentry,bugsnag,generic}/:appId
  orchestrator.ts  The pipeline itself — reportError() and handleCIResult()
  config.ts        Loads config/apps/*.yaml into AppConfig
  types.ts         Shared types
  config.test.ts   Unit tests (node:test, via tsx — no separate test framework)
config/apps/       One YAML file per onboarded app (see Per-app config above)
.github/workflows/ci.yml   typecheck + test + build, and a Docker build check, on every push/PR
```

**What's real vs. stubbed:** the git plumbing (clone/pull, worktree per fix, push) and the local `test_cmd` runner are fully implemented — you can run `reportError` today and it'll get as far as spinning up a worktree and running tests in it. Drafting the actual fix (`draftFix`), and the Jira/GitHub-PR/Slack calls, are stubs that throw `NotImplementedError` with what's missing — they need API credentials and an `ai_provider` integration this repo doesn't have yet. The webhook/MCP routes surface that as a `501` with a clear message rather than pretending to succeed.

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
