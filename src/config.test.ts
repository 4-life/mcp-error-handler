import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// APP_CONFIG_DIR is read once, at module load, so it has to be set before config.ts is imported.
const configDir = mkdtempSync(join(tmpdir(), "mcp-error-handler-config-"));
writeFileSync(
  join(configDir, "test-app.yaml"),
  [
    "app_id: test-app",
    "repo_url: git@github.com:org/test-app.git",
    "jira_project_key: TST",
    "slack_channel: '#test-alerts'",
    "",
  ].join("\n"),
);
process.env.APP_CONFIG_DIR = configDir;

const { getAppConfig, reloadAppConfigs } = await import("./config.js");
reloadAppConfigs();

test("getAppConfig maps required fields and fills in defaults", () => {
  const config = getAppConfig("test-app");
  assert.equal(config.appId, "test-app");
  assert.equal(config.repoUrl, "git@github.com:org/test-app.git");
  assert.equal(config.jiraProjectKey, "TST");
  assert.equal(config.slackChannel, "#test-alerts");
  assert.equal(config.defaultBranch, "main");
  assert.equal(config.repoProvider, "github");
  assert.equal(config.trackerProvider, "jira");
  assert.equal(config.docsProvider, "confluence");
  assert.equal(config.messengerProvider, "slack");
  assert.equal(config.aiProvider, "claude");
  assert.equal(config.localMaxAttempts, 3);
  assert.equal(config.ciMaxAttempts, 3);
  assert.equal(config.testCmd, undefined);
});

test("getAppConfig throws for an unknown app_id", () => {
  assert.throws(() => getAppConfig("does-not-exist"), /No config found for app_id/);
});