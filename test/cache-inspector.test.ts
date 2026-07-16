import type { SessionStats } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import test from "node:test";
import { CacheInspector, formatCacheReport } from "../src/cache-inspector.ts";

function stats(input: number, cacheRead: number, cacheWrite = 0): SessionStats {
  return {
    sessionFile: undefined,
    sessionId: "test",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: {
      input,
      output: 0,
      cacheRead,
      cacheWrite,
      total: input + cacheRead + cacheWrite,
    },
    cost: 0,
  };
}

test("derives per-turn deltas and cumulative session cache usage from Pi stats", () => {
  const inspector = new CacheInspector();
  inspector.begin(stats(10, 30));
  const report = inspector.finish(stats(30, 110));

  assert.deepEqual(report.turn, { hitTokens: 80, missTokens: 20, promptTokens: 100, hitRate: 0.8 });
  assert.deepEqual(report.session, { hitTokens: 110, missTokens: 30, promptTokens: 140, hitRate: 110 / 140 });
  assert.match(formatCacheReport(report), /turn hit=80 miss=20 rate=80\.0% prompt=100/);
});

test("alerts only for a material decline across sufficiently large observed turns", () => {
  const inspector = new CacheInspector();
  inspector.begin(stats(0, 0));
  inspector.finish(stats(20, 80));
  inspector.begin(stats(20, 80));
  const declined = inspector.finish(stats(100, 100));

  assert.equal(declined.changePercentagePoints, -60);
  assert.match(declined.alert ?? "", /decreased 60\.0 percentage points/);

  const small = new CacheInspector();
  small.begin(stats(0, 0));
  small.finish(stats(2, 8));
  small.begin(stats(2, 8));
  assert.equal(small.finish(stats(10, 10)).alert, undefined);
});

test("reports unavailable instead of fabricating a rate for zero or decreasing counters", () => {
  const inspector = new CacheInspector();
  inspector.begin(stats(10, 10));
  const report = inspector.finish(stats(5, 5));
  assert.equal(report.turn, undefined);
  assert.match(formatCacheReport(report), /turn unavailable/);

  const empty = new CacheInspector().current(stats(0, 0));
  assert.equal(empty.session.hitRate, undefined);
  assert.match(formatCacheReport(empty), /rate=n\/a/);

  const withCacheWrite = new CacheInspector().current(stats(10, 30, 5));
  assert.deepEqual(withCacheWrite.session, { hitTokens: 30, missTokens: 15, promptTokens: 45, hitRate: 2 / 3 });
});

test("refreshes cumulative session usage without rewriting the last observed turn", () => {
  const inspector = new CacheInspector();
  inspector.begin(stats(0, 0));
  inspector.finish(stats(20, 80));
  const current = inspector.current(stats(30, 170));
  assert.equal(current.turn?.hitRate, 0.8);
  assert.equal(current.session.hitRate, 0.85);
});
