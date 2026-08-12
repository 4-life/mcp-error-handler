import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";
import type { AppConfig } from "./types.js";

const CONFIG_DIR = resolve(process.env.APP_CONFIG_DIR ?? join(process.cwd(), "config", "apps"));

interface RawAppConfig {
  app_id: string;
  repo_url: string;
  default_branch?: string;
  repo_provider?: string;
  tracker_provider?: string;
  docs_provider?: string;
  messenger_provider?: string;
  jira_project_key: string;
  slack_channel: string;
  confluence_space?: string;
  ai_provider?: string;
  test_cmd?: string;
  default_assignee?: string;
  local_max_attempts?: number;
  ci_max_attempts?: number;
}

function toAppConfig(raw: RawAppConfig): AppConfig {
  return {
    appId: raw.app_id,
    repoUrl: raw.repo_url,
    defaultBranch: raw.default_branch ?? "main",
    repoProvider: (raw.repo_provider as AppConfig["repoProvider"]) ?? "github",
    trackerProvider: (raw.tracker_provider as AppConfig["trackerProvider"]) ?? "jira",
    docsProvider: (raw.docs_provider as AppConfig["docsProvider"]) ?? "confluence",
    messengerProvider: (raw.messenger_provider as AppConfig["messengerProvider"]) ?? "slack",
    jiraProjectKey: raw.jira_project_key,
    slackChannel: raw.slack_channel,
    confluenceSpace: raw.confluence_space,
    aiProvider: (raw.ai_provider as AppConfig["aiProvider"]) ?? "claude",
    testCmd: raw.test_cmd,
    defaultAssignee: raw.default_assignee,
    localMaxAttempts: raw.local_max_attempts ?? 3,
    ciMaxAttempts: raw.ci_max_attempts ?? 3,
  };
}

let cache: Map<string, AppConfig> | undefined;

function loadAll(): Map<string, AppConfig> {
  const configs = new Map<string, AppConfig>();
  const files = readdirSync(CONFIG_DIR).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  for (const file of files) {
    const raw = parseYaml(readFileSync(join(CONFIG_DIR, file), "utf8")) as RawAppConfig;
    const config = toAppConfig(raw);
    configs.set(config.appId, config);
  }
  return configs;
}

/** Reloads every app config from CONFIG_DIR — call once at boot, or again to pick up edits without a restart. */
export function reloadAppConfigs(): void {
  cache = loadAll();
}

export function getAppConfig(appId: string): AppConfig {
  if (!cache) cache = loadAll();
  const config = cache.get(appId);
  if (!config) {
    throw new Error(`No config found for app_id "${appId}" in ${CONFIG_DIR}`);
  }
  return config;
}