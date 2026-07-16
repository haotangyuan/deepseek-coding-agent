import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import test from "node:test";
import {
  CompletionEvidenceCollector,
  summarizeCompletionEvidence,
} from "../src/completion-evidence.ts";

function toolStart(id: string, toolName: string, args: Record<string, unknown>): AgentSessionEvent {
  return { type: "tool_execution_start", toolCallId: id, toolName, args } as AgentSessionEvent;
}

function toolEnd(id: string, toolName: string, isError = false): AgentSessionEvent {
  return {
    type: "tool_execution_end",
    toolCallId: id,
    toolName,
    result: { content: [] },
    isError,
  } as AgentSessionEvent;
}

test("records changed files, diff review and successful validations from paired tool events", () => {
  const collector = new CompletionEvidenceCollector("/workspace");
  collector.observe(toolStart("edit", "edit", { path: "src/main.ts", edits: [] }));
  collector.observe(toolEnd("edit", "edit"));
  collector.observe(toolStart("diff", "bash", { command: "git diff -- src/main.ts" }));
  collector.observe(toolEnd("diff", "bash"));
  collector.observe(toolStart("checks", "bash", { command: "npm run check && npm test" }));
  collector.observe(toolEnd("checks", "bash"));

  const evidence = collector.snapshot();
  assert.deepEqual(evidence.changedFiles, ["src/main.ts"]);
  assert.equal(evidence.diffReviewed, true);
  assert.deepEqual(evidence.checks, [
    { name: "npm run check", status: "passed" },
    { name: "npm test", status: "passed" },
  ]);
  assert.equal(evidence.bashCommandsObserved, 2);
  assert.deepEqual(summarizeCompletionEvidence(evidence).attention, []);
});

test("does not mistake status-only diff commands or ambiguous combined failures for completed evidence", () => {
  const collector = new CompletionEvidenceCollector("/workspace");
  collector.observe(toolStart("write", "write", { path: "README.md", content: "updated" }));
  collector.observe(toolEnd("write", "write"));
  collector.observe(toolStart("diff-check", "bash", { command: "git diff --check" }));
  collector.observe(toolEnd("diff-check", "bash"));
  collector.observe(toolStart("checks", "bash", { command: "npm run build && npm test" }));
  collector.observe(toolEnd("checks", "bash", true));

  const evidence = collector.snapshot();
  assert.equal(evidence.diffReviewed, false);
  assert.deepEqual(evidence.checks, [
    { name: "git diff --check", status: "passed" },
    { name: "combined validation", status: "failed" },
  ]);
  assert.equal(evidence.toolErrorsObserved, 1);
  assert.deepEqual(summarizeCompletionEvidence(evidence).attention, [
    "recorded changes were not reviewed with git diff",
    "latest validation failed: combined validation",
  ]);
});

test("tracks unresolved provider errors without treating recovered retries as failures", () => {
  const collector = new CompletionEvidenceCollector("/workspace");
  collector.observe({ type: "auto_retry_end", success: false, attempt: 3, finalError: "503" });
  assert.equal(collector.snapshot().providerErrorUnresolved, true);
  collector.observe({ type: "auto_retry_end", success: true, attempt: 1 });
  assert.equal(collector.snapshot().providerErrorUnresolved, false);
  collector.reset();
  assert.deepEqual(collector.snapshot().changedFiles, []);
});
