import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import { buildRepairFeedback, parseEvalArgs, shouldRetryRepair, summarizeEval, verifyFeedbackRecovery, verifyRepairFiles } from "../src/eval.ts";
import { EvaluationMetricsCollector } from "../src/evaluation.ts";

const partial = {
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: 0,
} as const;

test("evaluation parser defaults to dry-run and rejects unsafe matrices", () => {
  assert.deepEqual(parseEvalArgs([]), {
    help: false,
    live: false,
    model: "deepseek-v4-flash",
    thinking: "high",
    task: "all",
    runs: 1,
    maxCostUsd: 0.02,
  });
  assert.equal(parseEvalArgs(["--live", "--task", "exact", "--runs=2", "--thinking=max"]).live, true);
  assert.equal(parseEvalArgs(["--task", "repair-js"]).task, "repair-js");
  assert.equal(parseEvalArgs(["--task", "repair-multi-file", "--max-cost-usd=0.5"]).maxCostUsd, 0.5);
  assert.equal(parseEvalArgs(["--task", "repair-feedback"]).task, "repair-feedback");
  assert.throws(() => parseEvalArgs(["--model", "openai/gpt-5"]), /only allows the deepseek provider/i);
  assert.throws(() => parseEvalArgs(["--model", "deepseek/"]), /Model ID cannot be empty/);
  assert.throws(() => parseEvalArgs(["--thinking", "medium"]), /Invalid thinking level/);
  assert.throws(() => parseEvalArgs(["--runs", "6"]), /1 to 5/);
  assert.throws(() => parseEvalArgs(["--max-cost-usd", "0"]), /greater than 0/);
  assert.throws(() => parseEvalArgs(["--max-cost-usd", "2"]), /at most 1/);
});

test("repair feedback is bounded, redacted, and only retried after a test failure", () => {
  const feedback = buildRepairFeedback(`failure with authorization: bearer fake-secret-token ${"x".repeat(2500)}`);
  assert.match(feedback, /hidden regression tests/);
  assert.match(feedback, /\[REDACTED\]/);
  assert.doesNotMatch(feedback, /fake-secret-token/);
  assert.ok(feedback.length < 2400);
  assert.equal(shouldRetryRepair(0, false, 1, 2, 0.001, 0.005), true);
  assert.equal(shouldRetryRepair(1, false, 1, 2, 0.001, 0.005), false);
  assert.equal(shouldRetryRepair(0, true, 1, 2, 0.001, 0.005), false);
  assert.equal(shouldRetryRepair(0, false, 2, 2, 0.001, 0.005), false);
  assert.equal(shouldRetryRepair(0, false, 1, 2, 0.005, 0.005), false);
  assert.deepEqual(verifyFeedbackRecovery([false, true], 2), {
    firstAttemptFailed: true,
    recoveredAfterFeedback: true,
    toolErrorsWithinLimit: true,
    toolErrors: 2,
  });
  assert.equal(verifyFeedbackRecovery([false, true], 6).toolErrorsWithinLimit, false);
  assert.equal(verifyFeedbackRecovery([true], 0).recoveredAfterFeedback, false);
});

test("repair verification requires every expected edit and preserves protected files", () => {
  const fixture = {
    files: { "src/a.mjs": "bad-a", "src/b.mjs": "bad-b", "test/a.test.mjs": "tests" },
    expectedChangedFiles: ["src/a.mjs", "src/b.mjs"],
    protectedFiles: ["test/a.test.mjs"],
  };
  assert.deepEqual(verifyRepairFiles(fixture, {
    "src/a.mjs": "fixed-a",
    "src/b.mjs": "fixed-b",
    "test/a.test.mjs": "tests",
  }, true), {
    testPassed: true,
    protectedFilesUnchanged: true,
    expectedFilesChanged: true,
    allFixtureFilesPresent: true,
    noUnexpectedFiles: true,
    changedFiles: ["src/a.mjs", "src/b.mjs"],
    missingFiles: [],
    unexpectedFiles: [],
  });
  const invalid = verifyRepairFiles(fixture, {
    "src/a.mjs": "fixed-a",
    "src/b.mjs": "bad-b",
    "test/a.test.mjs": "changed tests",
    "notes.txt": "unexpected",
  }, false);
  assert.equal(invalid.testPassed, false);
  assert.equal(invalid.protectedFilesUnchanged, false);
  assert.equal(invalid.expectedFilesChanged, false);
  assert.equal(invalid.allFixtureFilesPresent, true);
  assert.equal(invalid.noUnexpectedFiles, false);
  const deleted = verifyRepairFiles(fixture, {
    "src/a.mjs": "fixed-a",
    "test/a.test.mjs": "tests",
  }, true);
  assert.equal(deleted.expectedFilesChanged, false);
  assert.equal(deleted.allFixtureFilesPresent, false);
  assert.deepEqual(deleted.missingFiles, ["src/b.mjs"]);
});

test("evaluation summary reports pass, cost, and budget stop", () => {
  const passed = { type: "eval_result", schemaVersion: 2, passed: true, metrics: { costUsd: 0.005 } };
  assert.deepEqual(summarizeEval(1, [passed], 0.02), {
    type: "eval_summary",
    schemaVersion: 2,
    passed: true,
    plannedSamples: 1,
    completedSamples: 1,
    passedSamples: 1,
    failedSamples: 0,
    costUsd: 0.005,
    maxCostUsd: 0.02,
    budgetExceeded: false,
    providerRequests: 1,
    maxProviderRequests: 1,
  });
  const repaired = summarizeEval(1, [{ passed: true, costUsd: 0.007, attemptCount: 2 }], 0.02, 2);
  assert.equal(repaired.costUsd, 0.007);
  assert.equal(repaired.providerRequests, 2);
  assert.equal(repaired.maxProviderRequests, 2);
  const stopped = summarizeEval(2, [{ ...passed, metrics: { costUsd: 0.015 } }], 0.01);
  assert.equal(stopped.passed, false);
  assert.equal(stopped.stoppedReason, "cost_limit");
  assert.equal(summarizeEval(1, [{ ...passed, metrics: { costUsd: 0.03 } }], 0.02).budgetExceeded, true);
});

test("metrics collector records latency, reasoning, tools, cache and ordered event categories", () => {
  let now = 100;
  const collector = new EvaluationMetricsCollector("deepseek-v4-flash", "high", () => now);
  now = 125;
  collector.observe({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "plan", partial },
  } as unknown as AgentSessionEvent);
  now = 140;
  collector.observe({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok", partial },
  } as unknown as AgentSessionEvent);
  now = 170;
  collector.observe({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} } as AgentSessionEvent);
  now = 180;
  collector.observe({ type: "tool_execution_end", toolCallId: "1", toolName: "read", result: { content: [] }, isError: false } as AgentSessionEvent);
  const stats: SessionStats = {
    sessionFile: undefined,
    sessionId: "test",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 3,
    tokens: { input: 10, output: 2, cacheRead: 30, cacheWrite: 0, total: 42 },
    cost: 0.001,
  };
  now = 200;
  const metrics = collector.finish(stats, true);
  assert.equal(metrics.durationMs, 100);
  assert.equal(metrics.firstResponseMs, 25);
  assert.equal(metrics.firstTextMs, 40);
  assert.equal(metrics.reasoningChars, 4);
  assert.equal(metrics.textChars, 2);
  assert.equal(metrics.toolCalls, 1);
  assert.equal(metrics.toolSuccesses, 1);
  assert.equal(metrics.cacheHitRate, 0.75);
  assert.deepEqual(metrics.providerErrorCategories, []);
  assert.deepEqual(metrics.eventSequence, ["thinking_delta", "text_delta", "tool_execution_start", "tool_execution_end"]);
});

test("metrics collector marks classified provider errors as unsuccessful", () => {
  const collector = new EvaluationMetricsCollector("deepseek-v4-flash", "high");
  collector.observe({
    type: "message_end",
    message: { ...partial, stopReason: "error", errorMessage: "429: rate limit reached" },
  } as unknown as AgentSessionEvent);
  const metrics = collector.finish({
    sessionFile: undefined,
    sessionId: "test",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  }, true);
  assert.equal(metrics.success, false);
  assert.deepEqual(metrics.providerErrorCategories, ["rate_limit"]);
});
