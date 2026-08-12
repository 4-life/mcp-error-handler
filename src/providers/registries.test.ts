import { test } from "node:test";
import assert from "node:assert/strict";
import { getRepoProvider } from "./repo/index.js";
import { getTrackerProvider } from "./tracker/index.js";
import { getDocsProvider } from "./docs/index.js";
import { getMessengerProvider } from "./messenger/index.js";
import { getLLMProvider } from "./llm/index.js";

test("each registry resolves its default provider with the right shape", () => {
  assert.equal(typeof getRepoProvider("github").findExistingPullRequest, "function");
  assert.equal(typeof getTrackerProvider("jira").createTicket, "function");
  assert.equal(typeof getDocsProvider("confluence").fetchDocs, "function");
  assert.equal(typeof getMessengerProvider("slack").notify, "function");
  assert.equal(typeof getLLMProvider("claude").draftFix, "function");
  assert.equal(typeof getLLMProvider("codex").draftFix, "function");
});

test("each registry throws on an unknown provider name", () => {
  assert.throws(() => getRepoProvider("bogus"), /Unknown repo_provider/);
  assert.throws(() => getTrackerProvider("bogus"), /Unknown tracker_provider/);
  assert.throws(() => getDocsProvider("bogus"), /Unknown docs_provider/);
  assert.throws(() => getMessengerProvider("bogus"), /Unknown messenger_provider/);
  assert.throws(() => getLLMProvider("bogus"), /Unknown ai_provider/);
});
