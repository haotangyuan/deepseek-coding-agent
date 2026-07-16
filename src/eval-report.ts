export type EvalTaskKind = "protocol" | "repair";

export interface EvalSampleResult {
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
  results: ReadonlyArray<EvalSampleResult>,
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
