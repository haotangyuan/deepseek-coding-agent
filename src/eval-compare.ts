#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sanitizeError } from "./cli.ts";
import { compareEvalResults, parseComparableEvalResults } from "./eval-report.ts";

export function evalCompareUsage(): string {
  return "Usage: npm run eval:compare -- RESULT.ndjson [RESULT.ndjson ...]";
}

export async function runEvalCompare(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${evalCompareUsage()}\n`);
    return 0;
  }
  if (args.length === 0 || args.some((arg) => arg.startsWith("-"))) {
    process.stderr.write(`${evalCompareUsage()}\n`);
    return 1;
  }
  try {
    const inputs = await Promise.all(args.map(async (path) => parseComparableEvalResults(await readFile(path, "utf8"), path)));
    process.stdout.write(`${JSON.stringify(compareEvalResults(inputs.flat()))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${sanitizeError(error)}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) process.exitCode = await runEvalCompare(process.argv.slice(2));
