#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
}

interface EvalOptions {
  help: boolean;
  live: boolean;
  model: string;
  thinking: DeepSeekThinkingLevel;
  task: string;
  runs: number;
}

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
];

const REPAIR_SOURCE = `export function add(left, right) {\n  return left - right;\n}\n`;
const REPAIR_TEST = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.mjs";\n\ntest("adds positive and negative numbers", () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(-2, 1), -1);\n});\n`;
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
  if (options.task !== "all" && !TASKS.some((task) => task.id === options.task)) {
    throw new Error(`Unknown task: ${options.task}`);
  }
  return options;
}

export function evalUsage(): string {
  return [
    "Usage: npm run eval -- [--task ID|all] [--model MODEL] [--thinking off|high|max] [--runs 1..5] [--live]",
    "",
    "Without --live, prints the planned paid requests and does not call DeepSeek.",
    `Tasks: ${TASKS.map((task) => task.id).join(", ")}`,
  ].join("\n");
}

function score(task: EvalTask, output: string, metrics: EvaluationMetrics | undefined): boolean {
  if (output.trim() !== task.expected || !metrics?.success) return false;
  if (task.requiredToolResult === "success") return metrics.toolSuccesses > 0;
  if (task.requiredToolResult === "error") return metrics.toolErrors > 0;
  return true;
}

function parseMetrics(stderr: string): EvaluationMetrics | undefined {
  const match = stderr.match(/^\[metrics\] (.+)$/m);
  return match ? JSON.parse(match[1]!) as EvaluationMetrics : undefined;
}

function failedResult(options: EvalOptions, task: EvalTask, run: number, error: unknown): Record<string, unknown> {
  const detail = error as Error & { stderr?: string };
  const sanitized = sanitizeError(detail.stderr || detail.message).slice(0, 500);
  const diagnostic = classifyDeepSeekError(sanitized);
  return {
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

async function executeProtocolTask(options: EvalOptions, task: EvalTask, run: number): Promise<Record<string, unknown>> {
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
      task: task.id,
      run,
      model: options.model,
      thinking: options.thinking,
      passed: score(task, stdout, metrics),
      output: sanitizeError(stdout.trim()).slice(0, 160),
      metrics,
    };
  } catch (error) {
    return failedResult(options, task, run, error);
  }
}

async function executeRepairTask(options: EvalOptions, task: EvalTask, run: number): Promise<Record<string, unknown>> {
  const fixture = await mkdtemp(join(tmpdir(), "deepseek-code-eval-"));
  const originalCwd = process.cwd();
  try {
    await mkdir(join(fixture, "src"));
    await mkdir(join(fixture, "test"));
    await writeFile(join(fixture, "src/math.mjs"), REPAIR_SOURCE);
    await writeFile(join(fixture, "test/math.test.mjs"), REPAIR_TEST);
    process.chdir(fixture);

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
      task.prompt,
    ], {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      approve: async (request) => request.toolName === "write" || request.toolName === "edit",
    });

    let testPassed = true;
    try {
      await execFileAsync(process.execPath, ["--test"], { cwd: fixture, timeout: 10_000, maxBuffer: 1024 * 1024 });
    } catch {
      testPassed = false;
    }
    const source = await readFile(join(fixture, "src/math.mjs"), "utf8");
    const testSource = await readFile(join(fixture, "test/math.test.mjs"), "utf8");
    const output = stdout.join("").trim();
    const metrics = parseMetrics(stderr.join(""));
    const checks = {
      testPassed,
      testsUnchanged: testSource === REPAIR_TEST,
      sourceChanged: source !== REPAIR_SOURCE,
    };
    return {
      task: task.id,
      run,
      model: options.model,
      thinking: options.thinking,
      passed: code === 0 && score(task, output, metrics) && Object.values(checks).every(Boolean),
      output: sanitizeError(output).slice(0, 160),
      checks,
      metrics,
    };
  } catch (error) {
    return failedResult(options, task, run, error);
  } finally {
    process.chdir(originalCwd);
    await rm(fixture, { recursive: true, force: true });
  }
}

async function executeTask(options: EvalOptions, task: EvalTask, run: number): Promise<Record<string, unknown>> {
  return task.kind === "repair"
    ? executeRepairTask(options, task, run)
    : executeProtocolTask(options, task, run);
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
  const requestCount = tasks.length * options.runs;
  if (!options.live) {
    process.stdout.write(`${JSON.stringify({ live: false, model: options.model, thinking: options.thinking, runs: options.runs, tasks: tasks.map((task) => task.id), requestCount })}\n`);
    return 0;
  }
  let failed = false;
  for (const task of tasks) {
    for (let run = 1; run <= options.runs; run += 1) {
      const result = await executeTask(options, task, run);
      failed = failed || result.passed !== true;
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }
  return failed ? 1 : 0;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) process.exitCode = await runEval(process.argv.slice(2));
