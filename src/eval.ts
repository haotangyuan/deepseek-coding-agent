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
import { summarizeEvalTasks, type EvalSampleResult, type EvalTaskKind, type EvalTaskPlan, type EvalTaskSummary } from "./eval-report.ts";
import { runCli } from "./main.ts";
import { DEFAULT_PROMPT_PROFILE, PROMPT_PROFILES, type PromptProfile } from "./prompt-profile.ts";
import { collectTypeScriptDiagnostics } from "./diagnostics.ts";

interface EvalTask {
  id: string;
  kind: EvalTaskKind;
  approval: "deny" | "auto-read" | "ask";
  prompt: string;
  expected: string;
  requiredToolResult?: "success" | "error";
  requiredToolName?: string;
  maxAttempts?: 2;
  feedbackRequired?: boolean;
}

interface EvalOptions {
  help: boolean;
  live: boolean;
  model: string;
  thinking: DeepSeekThinkingLevel;
  promptProfile: PromptProfile;
  task: string;
  runs: number;
  maxCostUsd: number;
}

export interface RepairFixture {
  files: Record<string, string>;
  expectedChangedFiles: string[];
  protectedFiles: string[];
}

interface EvalResult extends EvalSampleResult, Record<string, unknown> {
  metrics?: EvaluationMetrics;
}

export interface EvalSummary {
  type: "eval_summary";
  schemaVersion: 3;
  suite: "deepseek-code-v1";
  agent: "deepseek-code";
  promptProfile: PromptProfile;
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
  tasks: EvalTaskSummary[];
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
  firstAttemptPassed: boolean;
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
const EVAL_SUITE = "deepseek-code-v1";

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
    feedbackRequired: true,
  },
  {
    id: "repair-config",
    kind: "repair",
    approval: "ask",
    prompt: "Read src/config.mjs and test/config.test.mjs. Fix only src/config.mjs so it ignores blank and comment lines, trims keys and values, and preserves equals signs inside values. Do not run shell commands because the evaluator will run the tests. Reply with exactly FIXED after editing.",
    expected: "FIXED",
    requiredToolResult: "success",
  },
  {
    id: "repair-cross-module",
    kind: "repair",
    approval: "ask",
    prompt: "A bulk checkout reports the wrong total and leaves too much inventory. Explore the repository, locate the cooperating source modules, and fix the quantity handling while preserving the public checkout API. Do not modify tests or run shell commands because the evaluator will run the tests. Reply with exactly FIXED after editing.",
    expected: "FIXED",
    requiredToolResult: "success",
  },
  {
    id: "repair-long-log",
    kind: "repair",
    approval: "ask",
    prompt: "CI failed and saved its output in logs/ci.log. Inspect the log, locate the relevant source bug, and fix only the source file. Do not modify logs or tests and do not run shell commands because the evaluator will run the tests. Reply with exactly FIXED after editing.",
    expected: "FIXED",
    requiredToolResult: "success",
  },
  {
    id: "repair-validation",
    kind: "repair",
    approval: "ask",
    prompt: "A CSV import bug report says the final column is omitted. Read the source and fix that behavior without creating files or running shell commands. The evaluator will check compatibility and may return a bounded validation summary. Reply with exactly FIXED after editing.",
    expected: "FIXED",
    requiredToolResult: "success",
    maxAttempts: 2,
  },
  {
    id: "repair-typescript-diagnostics",
    kind: "repair",
    approval: "ask",
    prompt: "This TypeScript workspace no longer compiles. Use the diagnostics tool first, inspect the reported source location, and fix only the faulty source file. Do not modify tsconfig.json or run shell commands. Reply with exactly FIXED after editing.",
    expected: "FIXED",
    requiredToolResult: "success",
    requiredToolName: "diagnostics",
  },
];

const REPAIR_SOURCE = `export function add(left, right) {\n  return left - right;\n}\n`;
const REPAIR_TEST = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.mjs";\n\ntest("adds positive and negative numbers", () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(-2, 1), -1);\n});\n`;
const CART_SOURCE = `export function subtotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n`;
const DISCOUNT_SOURCE = `export function applyDiscount(total, percent) {\n  return total * (1 - percent / 10);\n}\n`;
const CHECKOUT_SOURCE = `import { subtotal } from "./cart.mjs";\nimport { applyDiscount } from "./discount.mjs";\n\nexport function checkout(items, discountPercent) {\n  return applyDiscount(subtotal(items), discountPercent);\n}\n`;
const CHECKOUT_TEST = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { subtotal } from "../src/cart.mjs";\nimport { applyDiscount } from "../src/discount.mjs";\nimport { checkout } from "../src/index.mjs";\n\ntest("subtotal includes item quantities", () => {\n  assert.equal(subtotal([{ price: 12, quantity: 2 }, { price: 5, quantity: 3 }]), 39);\n});\n\ntest("discount percent is divided by one hundred", () => {\n  assert.equal(applyDiscount(200, 15), 170);\n});\n\ntest("checkout composes subtotal and discount", () => {\n  assert.equal(checkout([{ price: 50, quantity: 2 }], 20), 80);\n});\n`;
const CONFIG_SOURCE = `export function parseConfig(text) {\n  return Object.fromEntries(text.split("\\n").map((line) => line.split("=")));\n}\n`;
const CONFIG_TEST = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { parseConfig } from "../src/config.mjs";\n\ntest("parses repository-style configuration", () => {\n  assert.deepEqual(parseConfig(" # local config\\n API_URL = https://example.test?a=b \\n\\nTIMEOUT=30\\n"), {\n    API_URL: "https://example.test?a=b",\n    TIMEOUT: "30",\n  });\n});\n`;
const INVENTORY_SOURCE = `export function reserve(stock, lines) {\n  const remaining = { ...stock };\n  for (const line of lines) {\n    if ((remaining[line.sku] ?? 0) < line.quantity) return { ok: false, sku: line.sku };\n    remaining[line.sku] -= 1;\n  }\n  return { ok: true, remaining };\n}\n`;
const ORDER_TOTAL_SOURCE = `export function orderTotal(prices, lines) {\n  return lines.reduce((total, line) => total + prices[line.sku], 0);\n}\n`;
const BULK_CHECKOUT_SOURCE = `import { reserve } from "./inventory.mjs";\nimport { orderTotal } from "./order-total.mjs";\n\nexport function checkout(stock, prices, lines) {\n  const reservation = reserve(stock, lines);\n  if (!reservation.ok) return reservation;\n  return { ok: true, total: orderTotal(prices, lines), remaining: reservation.remaining };\n}\n`;
const BULK_CHECKOUT_TEST = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { checkout } from "../src/checkout.mjs";\n\ntest("bulk checkout applies quantity across module boundaries", () => {\n  assert.deepEqual(checkout({ pen: 8, book: 3 }, { pen: 2, book: 10 }, [\n    { sku: "pen", quantity: 3 },\n    { sku: "book", quantity: 2 },\n  ]), { ok: true, total: 26, remaining: { pen: 5, book: 1 } });\n});\n`;
const DURATION_SOURCE = `export function parseDuration(value) {\n  const match = /^(\\d+)(ms|s|m)$/.exec(value);\n  if (!match) throw new Error("invalid duration");\n  const amount = Number(match[1]);\n  if (match[2] === "ms") return amount;\n  if (match[2] === "s") return amount * 1000;\n  return amount * 1000;\n}\n`;
const DURATION_TEST = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { parseDuration } from "../src/time/parse-duration.mjs";\n\ntest("parses scheduler timeout units", () => {\n  assert.equal(parseDuration("250ms"), 250);\n  assert.equal(parseDuration("3s"), 3000);\n  assert.equal(parseDuration("2m"), 120000);\n});\n`;
const CI_LOG = [
  ...Array.from({ length: 240 }, (_, index) => `2026-07-16T10:00:${String(index % 60).padStart(2, "0")}Z INFO shard=${index % 8} suite=passing-${index}`),
  "2026-07-16T10:05:00Z ERROR suite=test/job-timeout.test.mjs assertion failed",
  "AssertionError: parseDuration(\"2m\") expected 120000 but received 2000",
  "    at src/time/parse-duration.mjs:7:10",
  ...Array.from({ length: 240 }, (_, index) => `2026-07-16T10:06:${String(index % 60).padStart(2, "0")}Z INFO cleanup worker=${index % 6}`),
].join("\n");
const CSV_SOURCE = `export function parseCsv(text) {\n  return text.trimEnd().split(/\\r?\\n/).map((row) => row.split(",").slice(0, -1));\n}\n`;
const TYPESCRIPT_DIAGNOSTIC_SOURCE = `export interface Plugin {\n  name: string;\n  enabled: boolean;\n}\n\nexport function enabledPluginNames(plugins: Plugin[]): string[] {\n  return plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin);\n}\n`;
const TYPESCRIPT_CONSUMER_SOURCE = `import { enabledPluginNames, type Plugin } from "./registry.js";\n\nexport function summarizePlugins(plugins: Plugin[]): string {\n  return enabledPluginNames(plugins).join(", ");\n}\n`;
const TYPESCRIPT_CONFIG = `${JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
  },
  include: ["src/**/*.ts"],
}, null, 2)}\n`;
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
  "repair-config": {
    files: {
      "src/config.mjs": CONFIG_SOURCE,
      "test/config.test.mjs": CONFIG_TEST,
    },
    expectedChangedFiles: ["src/config.mjs"],
    protectedFiles: ["test/config.test.mjs"],
  },
  "repair-cross-module": {
    files: {
      "src/inventory.mjs": INVENTORY_SOURCE,
      "src/order-total.mjs": ORDER_TOTAL_SOURCE,
      "src/checkout.mjs": BULK_CHECKOUT_SOURCE,
      "test/checkout.test.mjs": BULK_CHECKOUT_TEST,
    },
    expectedChangedFiles: ["src/inventory.mjs", "src/order-total.mjs"],
    protectedFiles: ["src/checkout.mjs", "test/checkout.test.mjs"],
  },
  "repair-long-log": {
    files: {
      "src/time/parse-duration.mjs": DURATION_SOURCE,
      "test/job-timeout.test.mjs": DURATION_TEST,
      "logs/ci.log": CI_LOG,
    },
    expectedChangedFiles: ["src/time/parse-duration.mjs"],
    protectedFiles: ["test/job-timeout.test.mjs", "logs/ci.log"],
  },
  "repair-validation": {
    files: {
      "src/csv.mjs": CSV_SOURCE,
    },
    expectedChangedFiles: ["src/csv.mjs"],
    protectedFiles: [],
  },
  "repair-typescript-diagnostics": {
    files: {
      "tsconfig.json": TYPESCRIPT_CONFIG,
      "src/registry.ts": TYPESCRIPT_DIAGNOSTIC_SOURCE,
      "src/consumer.ts": TYPESCRIPT_CONSUMER_SOURCE,
    },
    expectedChangedFiles: ["src/registry.ts"],
    protectedFiles: ["tsconfig.json", "src/consumer.ts"],
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
    promptProfile: DEFAULT_PROMPT_PROFILE,
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
    else if (arg === "--prompt-profile") options.promptProfile = readValue(args, index++, arg) as PromptProfile;
    else if (arg.startsWith("--prompt-profile=")) options.promptProfile = arg.slice("--prompt-profile=".length) as PromptProfile;
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
  if (!PROMPT_PROFILES.includes(options.promptProfile)) throw new Error(`Invalid prompt profile: ${options.promptProfile}`);
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
    "Usage: npm run eval -- [--task ID|all] [--model MODEL] [--thinking off|high|max] [--prompt-profile pi|deepseek] [--runs 1..5] [--max-cost-usd USD] [--live]",
    "",
    "Without --live, prints the planned paid requests and does not call DeepSeek.",
    `Tasks: ${TASKS.map((task) => task.id).join(", ")}`,
  ].join("\n");
}

function score(task: EvalTask, output: string, metrics: EvaluationMetrics | undefined): boolean {
  if (!metrics?.success || (task.kind === "protocol" && output.trim() !== task.expected)) return false;
  if (task.requiredToolName && !metrics.toolNames.includes(task.requiredToolName)) return false;
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
    schemaVersion: 3,
    suite: EVAL_SUITE,
    agent: "deepseek-code",
    task: task.id,
    taskKind: task.kind,
    run,
    model: options.model,
    thinking: options.thinking,
    promptProfile: options.promptProfile,
    passed: false,
    costUsd: 0,
    toolCalls: 0,
    toolErrors: 0,
    providerErrors: 0,
    attemptCount: 1,
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
      "--prompt-profile",
      options.promptProfile,
      task.prompt,
    ], { maxBuffer: 4 * 1024 * 1024 });
    const metrics = parseMetrics(stderr);
    return {
      type: "eval_result",
      schemaVersion: 3,
      suite: EVAL_SUITE,
      agent: "deepseek-code",
      task: task.id,
      taskKind: task.kind,
      run,
      model: options.model,
      thinking: options.thinking,
      promptProfile: options.promptProfile,
      passed: score(task, stdout, metrics),
      output: sanitizeError(stdout.trim()).slice(0, 160),
      metrics,
      durationMs: metrics?.durationMs,
      costUsd: metrics?.costUsd ?? 0,
      toolCalls: metrics?.toolCalls ?? 0,
      toolErrors: metrics?.toolErrors ?? 0,
      providerErrors: metrics?.providerErrors ?? 0,
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
    firstAttemptPassed: testResults[0] === true,
    firstAttemptFailed: testResults[0] === false,
    recoveredAfterFeedback: testResults.length === 2 && testResults[1] === true,
    toolErrorsWithinLimit: toolErrors <= 5,
    toolErrors,
  };
}

export function feedbackRecoveryPassed(
  checks: FeedbackRecoveryVerification,
  feedbackRequired: boolean,
): boolean {
  if (!checks.toolErrorsWithinLimit) return false;
  return feedbackRequired
    ? checks.firstAttemptFailed && checks.recoveredAfterFeedback
    : checks.firstAttemptPassed || checks.recoveredAfterFeedback;
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
    if (task.id === "repair-typescript-diagnostics") {
      const report = collectTypeScriptDiagnostics(fixture);
      return report.available && report.errorCount === 0
        ? { passed: true, output: "" }
        : { passed: false, output: report.diagnostics.map((diagnostic) => `${diagnostic.path ?? "tsconfig.json"} TS${diagnostic.code}: ${diagnostic.message}`).join("\n") };
    }
    let args = ["--test"];
    let cwd = fixture;
    if (task.id === "repair-feedback" || task.id === "repair-validation") {
      evaluatorDir = await mkdtemp(join(tmpdir(), "deepseek-code-eval-tests-"));
      const testPath = join(evaluatorDir, "regression.test.mjs");
      if (task.id === "repair-feedback") {
        const cartUrl = pathToFileURL(join(fixture, "src/cart.mjs")).href;
        const discountUrl = pathToFileURL(join(fixture, "src/discount.mjs")).href;
        const indexUrl = pathToFileURL(join(fixture, "src/index.mjs")).href;
        await writeFile(testPath, `import { subtotal } from ${JSON.stringify(cartUrl)};\nimport { applyDiscount } from ${JSON.stringify(discountUrl)};\nimport { checkout } from ${JSON.stringify(indexUrl)};\n\nconst failures = [];\nfunction check(label, actual, expected) {\n  if (!Object.is(actual, expected)) failures.push(\`FAIL \${label}: expected \${expected}, received \${actual}\`);\n}\ncheck("src/cart.mjs subtotal includes quantities", subtotal([{ price: 12, quantity: 2 }, { price: 5, quantity: 3 }]), 39);\ncheck("src/discount.mjs applyDiscount uses a percentage", applyDiscount(200, 15), 170);\ncheck("src/index.mjs checkout combines both calculations", checkout([{ price: 50, quantity: 2 }], 20), 80);\nif (failures.length > 0) {\n  console.error(failures.join("\\n"));\n  process.exitCode = 1;\n}\n`);
      } else {
        const csvUrl = pathToFileURL(join(fixture, "src/csv.mjs")).href;
        await writeFile(testPath, `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { parseCsv } from ${JSON.stringify(csvUrl)};\n\ntest("keeps the final column", () => {\n  assert.deepEqual(parseCsv("name,role\\nAda,admin\\n"), [["name", "role"], ["Ada", "admin"]]);\n});\n\ntest("preserves quoted commas and empty trailing fields", () => {\n  assert.deepEqual(parseCsv("name,note,tag\\r\\nAda,\\\"hello,world\\\",\\r\\n"), [["name", "note", "tag"], ["Ada", "hello,world", ""]]);\n});\n`);
      }
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
        "--prompt-profile",
        options.promptProfile,
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
    const feedbackPassed = feedbackChecks === undefined || feedbackRecoveryPassed(feedbackChecks, task.feedbackRequired ?? false);
    const diagnostic = finalAttempt.error ? classifyDeepSeekError(finalAttempt.error) : undefined;
    return {
      type: "eval_result",
      schemaVersion: 3,
      suite: EVAL_SUITE,
      agent: "deepseek-code",
      task: task.id,
      taskKind: task.kind,
      run,
      model: options.model,
      thinking: options.thinking,
      promptProfile: options.promptProfile,
      passed: finalAttempt.code === 0 && score(task, finalAttempt.output, finalAttempt.metrics) && checks.testPassed && checks.protectedFilesUnchanged && checks.expectedFilesChanged && checks.allFixtureFilesPresent && checks.noUnexpectedFiles && feedbackPassed,
      output: finalAttempt.output,
      checks,
      metrics: finalAttempt.metrics,
      durationMs: attempts.reduce((total, attempt) => total + (attempt.metrics?.durationMs ?? 0), 0),
      costUsd,
      toolCalls: attempts.reduce((total, attempt) => total + (attempt.metrics?.toolCalls ?? 0), 0),
      toolErrors: attempts.reduce((total, attempt) => total + (attempt.metrics?.toolErrors ?? 0), 0),
      providerErrors: attempts.reduce((total, attempt) => total + (attempt.metrics?.providerErrors ?? 0), 0),
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
  plans: ReadonlyArray<EvalTaskPlan>,
  results: ReadonlyArray<EvalSampleResult>,
  maxCostUsd: number,
  maxProviderRequests: number = plans.reduce((total, plan) => total + plan.plannedSamples, 0),
  promptProfile: PromptProfile = (results[0]?.promptProfile as PromptProfile | undefined) ?? DEFAULT_PROMPT_PROFILE,
): EvalSummary {
  const plannedSamples = plans.reduce((total, plan) => total + plan.plannedSamples, 0);
  const passedSamples = results.filter((result) => result.passed).length;
  const costUsd = results.reduce((total, result) => total + (result.costUsd ?? 0), 0);
  const providerRequests = results.reduce((total, result) => total + (result.attemptCount ?? 1), 0);
  const incomplete = results.length < plannedSamples;
  const budgetExceeded = costUsd > maxCostUsd;
  return {
    type: "eval_summary",
    schemaVersion: 3,
    suite: EVAL_SUITE,
    agent: "deepseek-code",
    promptProfile,
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
    tasks: summarizeEvalTasks(plans, results),
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
  const plans: EvalTaskPlan[] = tasks.map((task) => ({ task: task.id, taskKind: task.kind, plannedSamples: options.runs }));
  if (!options.live) {
    process.stdout.write(`${JSON.stringify({ type: "eval_plan", schemaVersion: 3, suite: EVAL_SUITE, agent: "deepseek-code", live: false, model: options.model, thinking: options.thinking, promptProfile: options.promptProfile, runs: options.runs, tasks: plans, sampleCount, maxProviderRequests, maxCostUsd: options.maxCostUsd })}\n`);
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
  const summary = summarizeEval(plans, results, options.maxCostUsd, maxProviderRequests, options.promptProfile);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary.passed ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) process.exitCode = await runEval(process.argv.slice(2));
