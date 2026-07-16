#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { EvaluationMetrics } from "./evaluation.ts";
import { DEFAULT_MODEL_ID, sanitizeError, THINKING_LEVELS, type DeepSeekThinkingLevel } from "./cli.ts";
import { classifyDeepSeekError } from "./deepseek-errors.ts";
import { runCli } from "./main.ts";

interface EvalTask {
  id: string;
  kind: "protocol" | "repair";
  approval: "deny" | "auto-read" | "ask";
  prompt: string;
  expected: string;
  requiredToolResult?: "success" | "error";
  maxAttempts?: 2;
}

interface EvalOptions {
  help: boolean;
  live: boolean;
  model: string;
  thinking: DeepSeekThinkingLevel;
  task: string;
  runs: number;
  maxCostUsd: number;
}

export interface RepairFixture {
  files: Record<string, string>;
  expectedChangedFiles: string[];
  protectedFiles: string[];
}

interface EvalResult extends Record<string, unknown> {
  type: "eval_result";
  schemaVersion: 2;
  passed: boolean;
  metrics?: EvaluationMetrics;
  costUsd?: number;
  attemptCount?: number;
}

export interface EvalSummary {
  type: "eval_summary";
  schemaVersion: 2;
  passed: boolean;
  plannedSamples: number;
  completedSamples: number;
  passedSamples: number;
  failedSamples: number;
  costUsd: number;
  maxCostUsd: number;
  budgetExceeded: boolean;
  providerRequests: number;
  maxProviderRequests: number;
  stoppedReason?: "cost_limit";
}

export interface RepairVerification {
  testPassed: boolean;
  protectedFilesUnchanged: boolean;
  expectedFilesChanged: boolean;
  allFixtureFilesPresent: boolean;
  noUnexpectedFiles: boolean;
  changedFiles: string[];
  missingFiles: string[];
  unexpectedFiles: string[];
}

export interface FeedbackRecoveryVerification {
  firstAttemptFailed: boolean;
  recoveredAfterFeedback: boolean;
  toolErrorsWithinLimit: boolean;
  toolErrors: number;
}

interface RepairAttempt {
  attempt: number;
  kind: "initial" | "test_feedback";
  code: number;
  output: string;
  testPassed: boolean;
  metrics?: EvaluationMetrics;
  error?: string;
}

interface TestRun {
  passed: boolean;
  output: string;
}

const DEFAULT_MAX_COST_USD = 0.02;
const REPAIR_ATTEMPT_TIMEOUT_MS = 60_000;

const TASKS: EvalTask[] = [
  {
    id: "exact",
    kind: "protocol",
    approval: "deny",
    prompt: "Reply with exactly EVAL_OK and nothing else.",
    expected: "EVAL_OK",
  },
  {
    id: "read-package",
    kind: "protocol",
    approval: "auto-read",
    prompt: "Use the read tool on package.json, then reply with only the package name.",
    expected: "deepseek-coding-agent",
    requiredToolResult: "success",
  },
  {
    id: "missing-file-recovery",
    kind: "protocol",
    approval: "auto-read",
    prompt: "Use the read tool on __deepseek_eval_missing_file__.txt. After the expected tool error, reply with exactly RECOVERED.",
    expected: "RECOVERED",
    requiredToolResult: "error",
  },
  {
    id: "repair-js",
    kind: "repair",
    approval: "ask",
    prompt: "Read src/math.mjs and test/math.test.mjs. Fix only src/math.mjs so the tests pass. Do not run shell commands because the evaluator will run the tests. Reply with exactly FIXED after editing.",
    expected: "FIXED",
    requiredToolResult: "success",
  },
  {
    id: "repair-multi-file",
    kind: "repair",
    approval: "ask",
    prompt: "Read src/cart.mjs, src/discount.mjs, src/index.mjs, and test/checkout.test.mjs. There are two independent bugs: one in src/cart.mjs and one in src/discount.mjs. Fix only those two source files so the tests pass. Do not modify tests or run shell commands because the evaluator will run the tests. Reply with exactly FIXED after editing both files.",
    expected: "FIXED",
    requiredToolResult: "success",
  },
  {
    id: "repair-feedback",
    kind: "repair",
    approval: "ask",
    prompt: "A bug report says subtotal ignores item quantities. Read src/cart.mjs and fix only src/cart.mjs for that reported issue. Do not inspect or modify other files and do not run shell commands; the evaluator will run regression tests after your edit.",
    expected: "FIXED",
    requiredToolResult: "success",
    maxAttempts: 2,
  },
];

const REPAIR_SOURCE = `export function add(left, right) {\n  return left - right;\n}\n`;
const REPAIR_TEST = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.mjs";\n\ntest("adds positive and negative numbers", () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(-2, 1), -1);\n});\n`;
const CART_SOURCE = `export function subtotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n`;
const DISCOUNT_SOURCE = `export function applyDiscount(total, percent) {\n  return total * (1 - percent / 10);\n}\n`;
const CHECKOUT_SOURCE = `import { subtotal } from "./cart.mjs";\nimport { applyDiscount } from "./discount.mjs";\n\nexport function checkout(items, discountPercent) {\n  return applyDiscount(subtotal(items), discountPercent);\n}\n`;
const CHECKOUT_TEST = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { subtotal } from "../src/cart.mjs";\nimport { applyDiscount } from "../src/discount.mjs";\nimport { checkout } from "../src/index.mjs";\n\ntest("subtotal includes item quantities", () => {\n  assert.equal(subtotal([{ price: 12, quantity: 2 }, { price: 5, quantity: 3 }]), 39);\n});\n\ntest("discount percent is divided by one hundred", () => {\n  assert.equal(applyDiscount(200, 15), 170);\n});\n\ntest("checkout composes subtotal and discount", () => {\n  assert.equal(checkout([{ price: 50, quantity: 2 }], 20), 80);\n});\n`;
const REPAIR_FIXTURES: Record<string, RepairFixture> = {
  "repair-js": {
    files: {
      "src/math.mjs": REPAIR_SOURCE,
      "test/math.test.mjs": REPAIR_TEST,
    },
    expectedChangedFiles: ["src/math.mjs"],
    protectedFiles: ["test/math.test.mjs"],
  },
  "repair-multi-file": {
    files: {
      "src/cart.mjs": CART_SOURCE,
      "src/discount.mjs": DISCOUNT_SOURCE,
      "src/index.mjs": CHECKOUT_SOURCE,
      "test/checkout.test.mjs": CHECKOUT_TEST,
    },
    expectedChangedFiles: ["src/cart.mjs", "src/discount.mjs"],
    protectedFiles: ["src/index.mjs", "test/checkout.test.mjs"],
  },
  "repair-feedback": {
    files: {
      "src/cart.mjs": CART_SOURCE,
      "src/discount.mjs": DISCOUNT_SOURCE,
      "src/index.mjs": CHECKOUT_SOURCE,
    },
    expectedChangedFiles: ["src/cart.mjs", "src/discount.mjs"],
    protectedFiles: ["src/index.mjs"],
  },
};
const execFileAsync = promisify(execFile);

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseEvalArgs(args: string[]): EvalOptions {
  const options: EvalOptions = {
    help: false,
    live: false,
    model: DEFAULT_MODEL_ID,
    thinking: "high",
    task: "all",
    runs: 1,
    maxCostUsd: DEFAULT_MAX_COST_USD,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live") options.live = true;
    else if (arg === "--model") options.model = readValue(args, index++, arg);
    else if (arg.startsWith("--model=")) options.model = arg.slice("--model=".length);
    else if (arg === "--thinking") options.thinking = readValue(args, index++, arg) as DeepSeekThinkingLevel;
    else if (arg.startsWith("--thinking=")) options.thinking = arg.slice("--thinking=".length) as DeepSeekThinkingLevel;
    else if (arg === "--task") options.task = readValue(args, index++, arg);
    else if (arg.startsWith("--task=")) options.task = arg.slice("--task=".length);
    else if (arg === "--runs") options.runs = Number(readValue(args, index++, arg));
    else if (arg.startsWith("--runs=")) options.runs = Number(arg.slice("--runs=".length));
    else if (arg === "--max-cost-usd") options.maxCostUsd = Number(readValue(args, index++, arg));
    else if (arg.startsWith("--max-cost-usd=")) options.maxCostUsd = Number(arg.slice("--max-cost-usd=".length));
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.model || (options.model.includes("/") && !options.model.startsWith("deepseek/"))) {
    throw new Error("Evaluation only allows the deepseek provider");
  }
  options.model = options.model.replace(/^deepseek\//, "");
  if (!options.model) throw new Error("Model ID cannot be empty");
  if (!THINKING_LEVELS.includes(options.thinking)) throw new Error(`Invalid thinking level: ${options.thinking}`);
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 5) {
    throw new Error("--runs must be an integer from 1 to 5");
  }
  if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0 || options.maxCostUsd > 1) {
    throw new Error("--max-cost-usd must be greater than 0 and at most 1");
  }
  if (options.task !== "all" && !TASKS.some((task) => task.id === options.task)) {
    throw new Error(`Unknown task: ${options.task}`);
  }
  return options;
}

export function evalUsage(): string {
  return [
    "Usage: npm run eval -- [--task ID|all] [--model MODEL] [--thinking off|high|max] [--runs 1..5] [--max-cost-usd USD] [--live]",
    "",
    "Without --live, prints the planned paid requests and does not call DeepSeek.",
    `Tasks: ${TASKS.map((task) => task.id).join(", ")}`,
  ].join("\n");
}

function score(task: EvalTask, output: string, metrics: EvaluationMetrics | undefined): boolean {
  if (!metrics?.success || (task.kind === "protocol" && output.trim() !== task.expected)) return false;
  if (task.requiredToolResult === "success") return metrics.toolSuccesses > 0;
  if (task.requiredToolResult === "error") return metrics.toolErrors > 0;
  return true;
}

function parseMetrics(stderr: string): EvaluationMetrics | undefined {
  const match = stderr.match(/^\[metrics\] (.+)$/m);
  return match ? JSON.parse(match[1]!) as EvaluationMetrics : undefined;
}

function parseCliError(stderr: string): string | undefined {
  const matches = [...stderr.matchAll(/^\[error\] (.+)$/gm)];
  const message = matches.at(-1)?.[1];
  return message ? sanitizeError(message).slice(0, 500) : undefined;
}

function failedResult(options: EvalOptions, task: EvalTask, run: number, error: unknown): EvalResult {
  const detail = error as Error & { stderr?: string };
  const sanitized = sanitizeError(detail.stderr || detail.message).slice(0, 500);
  const diagnostic = classifyDeepSeekError(sanitized);
  return {
    type: "eval_result",
    schemaVersion: 2,
    task: task.id,
    run,
    model: options.model,
    thinking: options.thinking,
    passed: false,
    error: sanitized,
    errorCategory: diagnostic.category,
    retryable: diagnostic.retryable,
  };
}

async function executeProtocolTask(options: EvalOptions, task: EvalTask, run: number): Promise<EvalResult> {
  const main = fileURLToPath(new URL("./main.js", import.meta.url));
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      main,
      "--ephemeral",
      "--metrics",
      "--approval",
      task.approval,
      "--model",
      options.model,
      "--thinking",
      options.thinking,
      task.prompt,
    ], { maxBuffer: 4 * 1024 * 1024 });
    const metrics = parseMetrics(stderr);
    return {
      type: "eval_result",
      schemaVersion: 2,
      task: task.id,
      run,
      model: options.model,
      thinking: options.thinking,
      passed: score(task, stdout, metrics),
      output: sanitizeError(stdout.trim()).slice(0, 160),
      metrics,
      costUsd: metrics?.costUsd ?? 0,
      attemptCount: 1,
    };
  } catch (error) {
    return failedResult(options, task, run, error);
  }
}

export function buildRepairFeedback(testOutput: string): string {
  const sanitized = sanitizeError(testOutput).slice(0, 2000);
  return [
    "The evaluator ran the hidden regression tests after your previous edit, and they still fail.",
    "Use the failure details below to inspect the relevant source files and fix the remaining source bug.",
    "Do not run shell commands or create new files. Do not revert the previous correct edit.",
    "<test_summary>",
    sanitized || "Test failed without output.",
    "</test_summary>",
  ].join("\n");
}

export function verifyFeedbackRecovery(testResults: boolean[], toolErrors: number): FeedbackRecoveryVerification {
  return {
    firstAttemptFailed: testResults[0] === false,
    recoveredAfterFeedback: testResults.length === 2 && testResults[1] === true,
    toolErrorsWithinLimit: toolErrors <= 5,
    toolErrors,
  };
}

export function shouldRetryRepair(
  code: number,
  testPassed: boolean,
  attempt: number,
  maxAttempts: number,
  costUsd: number,
  availableCostUsd: number,
): boolean {
  return code === 0 && !testPassed && attempt < maxAttempts && costUsd < availableCostUsd;
}

async function runRepairTests(task: EvalTask, fixture: string): Promise<TestRun> {
  let evaluatorDir: string | undefined;
  try {
    let args = ["--test"];
    let cwd = fixture;
    if (task.id === "repair-feedback") {
      evaluatorDir = await mkdtemp(join(tmpdir(), "deepseek-code-eval-tests-"));
      const testPath = join(evaluatorDir, "regression.test.mjs");
      const cartUrl = pathToFileURL(join(fixture, "src/cart.mjs")).href;
      const discountUrl = pathToFileURL(join(fixture, "src/discount.mjs")).href;
      const indexUrl = pathToFileURL(join(fixture, "src/index.mjs")).href;
      await writeFile(testPath, `import { subtotal } from ${JSON.stringify(cartUrl)};\nimport { applyDiscount } from ${JSON.stringify(discountUrl)};\nimport { checkout } from ${JSON.stringify(indexUrl)};\n\nconst failures = [];\nfunction check(label, actual, expected) {\n  if (!Object.is(actual, expected)) failures.push(\`FAIL \${label}: expected \${expected}, received \${actual}\`);\n}\ncheck("src/cart.mjs subtotal includes quantities", subtotal([{ price: 12, quantity: 2 }, { price: 5, quantity: 3 }]), 39);\ncheck("src/discount.mjs applyDiscount uses a percentage", applyDiscount(200, 15), 170);\ncheck("src/index.mjs checkout combines both calculations", checkout([{ price: 50, quantity: 2 }], 20), 80);\nif (failures.length > 0) {\n  console.error(failures.join("\\n"));\n  process.exitCode = 1;\n}\n`);
      args = [testPath];
      cwd = evaluatorDir;
    }
    await execFileAsync(process.execPath, args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 });
    return { passed: true, output: "" };
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string };
    let output = `${detail.stdout ?? ""}\n${detail.stderr ?? detail.message}`.replaceAll(fixture, ".");
    if (evaluatorDir) output = output.replaceAll(evaluatorDir, "<evaluator>");
    output = output.trim();
    return { passed: false, output };
  } finally {
    if (evaluatorDir) await rm(evaluatorDir, { recursive: true, force: true });
  }
}

export function verifyRepairFiles(
  fixture: RepairFixture,
  currentFiles: Record<string, string>,
  testPassed: boolean,
): RepairVerification {
  const fixtureFiles = Object.keys(fixture.files);
  const changedFiles = fixtureFiles.filter((path) => path in currentFiles && currentFiles[path] !== fixture.files[path]);
  const missingFiles = fixtureFiles.filter((path) => !(path in currentFiles));
  const unexpectedFiles = Object.keys(currentFiles).filter((path) => !(path in fixture.files));
  return {
    testPassed,
    protectedFilesUnchanged: fixture.protectedFiles.every((path) => currentFiles[path] === fixture.files[path]),
    expectedFilesChanged: fixture.expectedChangedFiles.every((path) => changedFiles.includes(path)),
    allFixtureFilesPresent: missingFiles.length === 0,
    noUnexpectedFiles: unexpectedFiles.length === 0,
    changedFiles,
    missingFiles,
    unexpectedFiles,
  };
}

async function executeRepairTask(
  options: EvalOptions,
  task: EvalTask,
  run: number,
  availableCostUsd: number,
): Promise<EvalResult> {
  const fixture = await mkdtemp(join(tmpdir(), "deepseek-code-eval-"));
  const originalCwd = process.cwd();
  try {
    const definition = REPAIR_FIXTURES[task.id];
    if (!definition) throw new Error(`Missing repair fixture: ${task.id}`);
    for (const [path, content] of Object.entries(definition.files)) {
      await mkdir(dirname(join(fixture, path)), { recursive: true });
      await writeFile(join(fixture, path), content);
    }
    process.chdir(fixture);

    const attempts: RepairAttempt[] = [];
    let prompt = task.prompt;
    let promptKind: RepairAttempt["kind"] = "initial";
    let testRun: TestRun = { passed: false, output: "Evaluation did not run." };
    for (let attempt = 1; attempt <= (task.maxAttempts ?? 1); attempt += 1) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli([
        "--ephemeral",
        "--metrics",
        "--approval",
        task.approval,
        "--model",
        options.model,
        "--thinking",
        options.thinking,
        prompt,
      ], {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
        approve: async (request) => request.toolName === "write" || request.toolName === "edit" ? "allow-once" : "deny",
      }, undefined, { signal: AbortSignal.timeout(REPAIR_ATTEMPT_TIMEOUT_MS) });
      const output = stdout.join("").trim();
      const stderrText = stderr.join("");
      const metrics = parseMetrics(stderrText);
      const error = parseCliError(stderrText);
      testRun = code === 0 ? await runRepairTests(task, fixture) : { passed: false, output: "Agent execution failed." };
      attempts.push({
        attempt,
        kind: promptKind,
        code,
        output: sanitizeError(output).slice(0, 160),
        testPassed: testRun.passed,
        metrics,
        ...(error ? { error } : {}),
      });
      const costUsd = attempts.reduce((total, item) => total + (item.metrics?.costUsd ?? 0), 0);
      if (!shouldRetryRepair(code, testRun.passed, attempt, task.maxAttempts ?? 1, costUsd, availableCostUsd)) break;
      prompt = buildRepairFeedback(testRun.output);
      promptKind = "test_feedback";
    }
    const paths = (await readdir(fixture, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(fixture.length + 1));
    const currentFiles = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await readFile(join(fixture, path), "utf8")] as const)));
    const finalAttempt = attempts.at(-1)!;
    const checks = verifyRepairFiles(definition, currentFiles, testRun.passed);
    const costUsd = attempts.reduce((total, attempt) => total + (attempt.metrics?.costUsd ?? 0), 0);
    const feedbackChecks = task.maxAttempts
      ? verifyFeedbackRecovery(
        attempts.map((attempt) => attempt.testPassed),
        attempts.reduce((total, attempt) => total + (attempt.metrics?.toolErrors ?? 0), 0),
      )
      : undefined;
    const feedbackPassed = feedbackChecks === undefined || (
      feedbackChecks.firstAttemptFailed &&
      feedbackChecks.recoveredAfterFeedback &&
      feedbackChecks.toolErrorsWithinLimit
    );
    const diagnostic = finalAttempt.error ? classifyDeepSeekError(finalAttempt.error) : undefined;
    return {
      type: "eval_result",
      schemaVersion: 2,
      task: task.id,
      run,
      model: options.model,
      thinking: options.thinking,
      passed: finalAttempt.code === 0 && score(task, finalAttempt.output, finalAttempt.metrics) && checks.testPassed && checks.protectedFilesUnchanged && checks.expectedFilesChanged && checks.allFixtureFilesPresent && checks.noUnexpectedFiles && feedbackPassed,
      output: finalAttempt.output,
      checks,
      metrics: finalAttempt.metrics,
      costUsd,
      attemptCount: attempts.length,
      feedbackRounds: attempts.filter((attempt) => attempt.kind === "test_feedback").length,
      attempts,
      ...(feedbackChecks ? { feedbackChecks } : {}),
      ...(finalAttempt.error && diagnostic ? {
        error: finalAttempt.error,
        errorCategory: diagnostic.category,
        retryable: diagnostic.retryable,
      } : {}),
      ...(finalAttempt.code === 0 && attempts.length < (task.maxAttempts ?? 1) && !testRun.passed && costUsd >= availableCostUsd
        ? { feedbackSkipped: "cost_limit" }
        : {}),
    };
  } catch (error) {
    return failedResult(options, task, run, error);
  } finally {
    process.chdir(originalCwd);
    await rm(fixture, { recursive: true, force: true });
  }
}

async function executeTask(options: EvalOptions, task: EvalTask, run: number, availableCostUsd: number): Promise<EvalResult> {
  return task.kind === "repair"
    ? executeRepairTask(options, task, run, availableCostUsd)
    : executeProtocolTask(options, task, run);
}

export function summarizeEval(
  plannedSamples: number,
  results: ReadonlyArray<{ passed: boolean; metrics?: Pick<EvaluationMetrics, "costUsd">; costUsd?: number; attemptCount?: number }>,
  maxCostUsd: number,
  maxProviderRequests: number = plannedSamples,
): EvalSummary {
  const passedSamples = results.filter((result) => result.passed).length;
  const costUsd = results.reduce((total, result) => total + (result.costUsd ?? result.metrics?.costUsd ?? 0), 0);
  const providerRequests = results.reduce((total, result) => total + (result.attemptCount ?? 1), 0);
  const incomplete = results.length < plannedSamples;
  const budgetExceeded = costUsd > maxCostUsd;
  return {
    type: "eval_summary",
    schemaVersion: 2,
    passed: !incomplete && !budgetExceeded && passedSamples === plannedSamples,
    plannedSamples,
    completedSamples: results.length,
    passedSamples,
    failedSamples: results.length - passedSamples,
    costUsd,
    maxCostUsd,
    budgetExceeded,
    providerRequests,
    maxProviderRequests,
    ...(incomplete && costUsd >= maxCostUsd ? { stoppedReason: "cost_limit" as const } : {}),
  };
}

export async function runEval(args: string[]): Promise<number> {
  let options: EvalOptions;
  try {
    options = parseEvalArgs(args);
  } catch (error) {
    process.stderr.write(`Error: ${sanitizeError(error)}\n${evalUsage()}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(`${evalUsage()}\n`);
    return 0;
  }
  const tasks = options.task === "all" ? TASKS : TASKS.filter((task) => task.id === options.task);
  const sampleCount = tasks.length * options.runs;
  const maxProviderRequests = tasks.reduce((total, task) => total + (task.maxAttempts ?? 1), 0) * options.runs;
  if (!options.live) {
    process.stdout.write(`${JSON.stringify({ type: "eval_plan", schemaVersion: 2, live: false, model: options.model, thinking: options.thinking, runs: options.runs, tasks: tasks.map((task) => task.id), sampleCount, maxProviderRequests, maxCostUsd: options.maxCostUsd })}\n`);
    return 0;
  }
  const results: EvalResult[] = [];
  let stop = false;
  for (const task of tasks) {
    for (let run = 1; run <= options.runs; run += 1) {
      const currentCostUsd = results.reduce((total, item) => total + (item.costUsd ?? item.metrics?.costUsd ?? 0), 0);
      const result = await executeTask(options, task, run, options.maxCostUsd - currentCostUsd);
      results.push(result);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      const costUsd = results.reduce((total, item) => total + (item.costUsd ?? item.metrics?.costUsd ?? 0), 0);
      if (results.length < sampleCount && costUsd >= options.maxCostUsd) {
        stop = true;
        break;
      }
    }
    if (stop) break;
  }
  const summary = summarizeEval(sampleCount, results, options.maxCostUsd, maxProviderRequests);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary.passed ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) process.exitCode = await runEval(process.argv.slice(2));
