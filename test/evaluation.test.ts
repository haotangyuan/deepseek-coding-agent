import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import { parseEvalArgs } from "../src/eval.ts";
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
  });
  assert.equal(parseEvalArgs(["--live", "--task", "exact", "--runs=2", "--thinking=max"]).live, true);
  assert.equal(parseEvalArgs(["--task", "repair-js"]).task, "repair-js");
  assert.throws(() => parseEvalArgs(["--model", "openai/gpt-5"]), /only allows the deepseek provider/i);
  assert.throws(() => parseEvalArgs(["--model", "deepseek/"]), /Model ID cannot be empty/);
  assert.throws(() => parseEvalArgs(["--thinking", "medium"]), /Invalid thinking level/);
  assert.throws(() => parseEvalArgs(["--runs", "6"]), /1 to 5/);
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
