export type EvalTaskKind = "protocol" | "repair";

export interface ComparableEvalResult {
  type: "eval_result";
  schemaVersion: 3;
  suite: string;
  agent: string;
  task: string;
  taskKind: EvalTaskKind;
  run: number;
  model: string;
  thinking: string;
  passed: boolean;
  durationMs?: number;
  costUsd?: number;
  toolCalls?: number;
  toolErrors?: number;
  providerErrors?: number;
  attemptCount?: number;
}

export interface EvalTaskPlan {
  task: string;
  taskKind: EvalTaskKind;
  plannedSamples: number;
}

export interface EvalTaskSummary {
  task: string;
  taskKind: EvalTaskKind;
  plannedSamples: number;
  completedSamples: number;
  passedSamples: number;
  failedSamples: number;
  passRate?: number;
  averageDurationMs?: number;
  medianDurationMs?: number;
  p95DurationMs?: number;
  costUsd?: number;
  averageCostUsd?: number;
  toolCalls?: number;
  toolErrors?: number;
  toolErrorRate?: number;
  providerErrors?: number;
  providerRequests?: number;
}

export interface EvalComparisonGroup {
  suite: string;
  agent: string;
  model: string;
  thinking: string;
  includedSamples: number;
  excludedSamples: number;
  passedSamples: number;
  passRate?: number;
  costUsd?: number;
  averageCostUsd?: number;
  averageDurationMs?: number;
  medianDurationMs?: number;
  p95DurationMs?: number;
  toolCalls?: number;
  toolErrors?: number;
  providerErrors?: number;
  providerRequests?: number;
  tasks: EvalTaskSummary[];
}

export interface EvalComparison {
  type: "eval_comparison";
  schemaVersion: 1;
  commonSamples: string[];
  groups: EvalComparisonGroup[];
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function round(value: number): number {
  return Number(value.toFixed(12));
}

function average(values: number[]): number | undefined {
  return values.length === 0 ? undefined : round(values.reduce((total, value) => total + value, 0) / values.length);
}

function percentile(values: number[], percentileValue: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  if (percentileValue === 0.5 && sorted.length % 2 === 0) {
    const upper = sorted.length / 2;
    return round((sorted[upper - 1]! + sorted[upper]!) / 2);
  }
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)];
}

export function summarizeEvalTasks(
  plans: ReadonlyArray<EvalTaskPlan>,
  results: ReadonlyArray<ComparableEvalResult>,
): EvalTaskSummary[] {
  return plans.map((plan) => {
    const taskResults = results.filter((result) => result.task === plan.task);
    const passedSamples = taskResults.filter((result) => result.passed).length;
    const durations = taskResults.map((result) => result.durationMs).filter(finiteNonNegative);
    const costs = taskResults.map((result) => result.costUsd).filter(finiteNonNegative);
    const hasCosts = taskResults.length > 0 && costs.length === taskResults.length;
    const hasToolCounts = taskResults.length > 0 && taskResults.every((result) => result.toolCalls !== undefined && result.toolErrors !== undefined);
    const hasProviderErrors = taskResults.length > 0 && taskResults.every((result) => result.providerErrors !== undefined);
    const hasProviderRequests = taskResults.length > 0 && taskResults.every((result) => result.attemptCount !== undefined);
    const costUsd = round(costs.reduce((total, value) => total + value, 0));
    const toolCalls = taskResults.reduce((total, result) => total + (result.toolCalls ?? 0), 0);
    const toolErrors = taskResults.reduce((total, result) => total + (result.toolErrors ?? 0), 0);
    return {
      task: plan.task,
      taskKind: plan.taskKind,
      plannedSamples: plan.plannedSamples,
      completedSamples: taskResults.length,
      passedSamples,
      failedSamples: taskResults.length - passedSamples,
      ...(taskResults.length === 0 ? {} : { passRate: passedSamples / taskResults.length }),
      ...(average(durations) === undefined ? {} : { averageDurationMs: average(durations) }),
      ...(percentile(durations, 0.5) === undefined ? {} : { medianDurationMs: percentile(durations, 0.5) }),
      ...(percentile(durations, 0.95) === undefined ? {} : { p95DurationMs: percentile(durations, 0.95) }),
      ...(hasCosts ? { costUsd, averageCostUsd: average(costs) } : {}),
      ...(hasToolCounts ? { toolCalls, toolErrors, ...(toolCalls === 0 ? {} : { toolErrorRate: toolErrors / toolCalls }) } : {}),
      ...(hasProviderErrors ? { providerErrors: taskResults.reduce((total, result) => total + result.providerErrors!, 0) } : {}),
      ...(hasProviderRequests ? { providerRequests: taskResults.reduce((total, result) => total + result.attemptCount!, 0) } : {}),
    };
  });
}

function requireString(record: Record<string, unknown>, key: string, source: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${source}: ${key} must be a non-empty string`);
  return value;
}

export function parseComparableEvalResults(input: string, source = "input"): ComparableEvalResult[] {
  const results: ComparableEvalResult[] = [];
  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${source}:${index + 1}: invalid JSON`);
    }
    if (!value || typeof value !== "object") throw new Error(`${source}:${index + 1}: expected an object`);
    const record = value as Record<string, unknown>;
    if (record.type !== "eval_result") continue;
    const location = `${source}:${index + 1}`;
    if (record.schemaVersion !== 3) throw new Error(`${location}: only eval_result schemaVersion 3 is supported`);
    if (record.taskKind !== "protocol" && record.taskKind !== "repair") throw new Error(`${location}: invalid taskKind`);
    if (!Number.isInteger(record.run) || (record.run as number) < 1) throw new Error(`${location}: run must be a positive integer`);
    if (typeof record.passed !== "boolean") throw new Error(`${location}: passed must be boolean`);
    for (const key of ["durationMs", "costUsd"] as const) {
      if (record[key] !== undefined && !finiteNonNegative(record[key])) throw new Error(`${location}: ${key} must be a non-negative finite number`);
    }
    for (const key of ["toolCalls", "toolErrors", "providerErrors"] as const) {
      if (record[key] !== undefined && (!Number.isInteger(record[key]) || (record[key] as number) < 0)) {
        throw new Error(`${location}: ${key} must be a non-negative integer`);
      }
    }
    if (record.attemptCount !== undefined && (!Number.isInteger(record.attemptCount) || (record.attemptCount as number) < 1)) {
      throw new Error(`${location}: attemptCount must be a positive integer`);
    }
    results.push({
      type: "eval_result",
      schemaVersion: 3,
      suite: requireString(record, "suite", location),
      agent: requireString(record, "agent", location),
      task: requireString(record, "task", location),
      taskKind: record.taskKind,
      run: record.run as number,
      model: requireString(record, "model", location),
      thinking: requireString(record, "thinking", location),
      passed: record.passed,
      ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs as number }),
      ...(record.costUsd === undefined ? {} : { costUsd: record.costUsd as number }),
      ...(record.toolCalls === undefined ? {} : { toolCalls: record.toolCalls as number }),
      ...(record.toolErrors === undefined ? {} : { toolErrors: record.toolErrors as number }),
      ...(record.providerErrors === undefined ? {} : { providerErrors: record.providerErrors as number }),
      ...(record.attemptCount === undefined ? {} : { attemptCount: record.attemptCount as number }),
    });
  }
  if (results.length === 0) throw new Error(`${source}: no eval_result schemaVersion 3 rows found`);
  return results;
}

function groupKey(result: ComparableEvalResult): string {
  return JSON.stringify([result.suite, result.agent, result.model, result.thinking]);
}

function sampleKey(result: ComparableEvalResult): string {
  return `${result.task}#${result.run}`;
}

export function compareEvalResults(results: ReadonlyArray<ComparableEvalResult>): EvalComparison {
  const suites = new Set(results.map((result) => result.suite));
  if (suites.size !== 1) throw new Error("Comparison requires one shared evaluation suite");
  const grouped = new Map<string, ComparableEvalResult[]>();
  for (const result of results) {
    const key = groupKey(result);
    const group = grouped.get(key) ?? [];
    if (group.some((candidate) => sampleKey(candidate) === sampleKey(result))) {
      throw new Error(`Duplicate sample for ${result.agent}/${result.model}/${result.thinking}: ${sampleKey(result)}`);
    }
    group.push(result);
    grouped.set(key, group);
  }
  const groups = [...grouped.values()];
  const common = groups.slice(1).reduce(
    (keys, group) => new Set([...keys].filter((key) => group.some((result) => sampleKey(result) === key))),
    new Set(groups[0]!.map(sampleKey)),
  );
  if (common.size === 0) throw new Error("Comparison groups have no common task/run samples");
  const commonSamples = [...common].sort();
  return {
    type: "eval_comparison",
    schemaVersion: 1,
    commonSamples,
    groups: groups.map((group) => {
      const included = group.filter((result) => common.has(sampleKey(result)));
      const first = included[0]!;
      const plans = [...new Map(included.map((result) => [result.task, result.taskKind])).entries()]
        .map(([task, taskKind]) => ({ task, taskKind, plannedSamples: included.filter((result) => result.task === task).length }));
      const tasks = summarizeEvalTasks(plans, included);
      const durations = included.map((result) => result.durationMs).filter(finiteNonNegative);
      const costs = included.map((result) => result.costUsd).filter(finiteNonNegative);
      const hasCosts = costs.length === included.length;
      const hasToolCounts = included.every((result) => result.toolCalls !== undefined && result.toolErrors !== undefined);
      const hasProviderErrors = included.every((result) => result.providerErrors !== undefined);
      const hasProviderRequests = included.every((result) => result.attemptCount !== undefined);
      const passedSamples = included.filter((result) => result.passed).length;
      return {
        suite: first.suite,
        agent: first.agent,
        model: first.model,
        thinking: first.thinking,
        includedSamples: included.length,
        excludedSamples: group.length - included.length,
        passedSamples,
        passRate: passedSamples / included.length,
        ...(hasCosts ? { costUsd: round(costs.reduce((total, value) => total + value, 0)), averageCostUsd: average(costs) } : {}),
        ...(average(durations) === undefined ? {} : { averageDurationMs: average(durations) }),
        ...(percentile(durations, 0.5) === undefined ? {} : { medianDurationMs: percentile(durations, 0.5) }),
        ...(percentile(durations, 0.95) === undefined ? {} : { p95DurationMs: percentile(durations, 0.95) }),
        ...(hasToolCounts ? {
          toolCalls: included.reduce((total, result) => total + result.toolCalls!, 0),
          toolErrors: included.reduce((total, result) => total + result.toolErrors!, 0),
        } : {}),
        ...(hasProviderErrors ? { providerErrors: included.reduce((total, result) => total + result.providerErrors!, 0) } : {}),
        ...(hasProviderRequests ? { providerRequests: included.reduce((total, result) => total + result.attemptCount!, 0) } : {}),
        tasks,
      };
    }),
  };
}
