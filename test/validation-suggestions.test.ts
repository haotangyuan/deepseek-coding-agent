import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createVerificationPrompt,
  discoverValidationSuggestion,
} from "../src/validation-suggestions.ts";

test("prefers the narrowest declared package validation and respects the package manager", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "deepseek-code-verify-"));
  try {
    await writeFile(join(cwd, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.0.0",
      scripts: { build: "tsc", test: "node --test", check: "tsc --noEmit" },
    }));
    assert.deepEqual(await discoverValidationSuggestion(cwd), {
      command: "pnpm run check",
      source: "package.json",
      reason: "highest-priority available package script: check",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("falls back through known manifests without executing or reading arbitrary project files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "deepseek-code-verify-"));
  try {
    await writeFile(join(cwd, "package.json"), "not-json");
    await writeFile(join(cwd, "pyproject.toml"), "[project]\nname='demo'\n");
    assert.deepEqual(await discoverValidationSuggestion(cwd), {
      command: "python -m pytest",
      source: "pyproject.toml",
      reason: "Python project manifest detected",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("returns no suggestion for an unknown project and builds a bounded verification prompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "deepseek-code-verify-"));
  try {
    assert.equal(await discoverValidationSuggestion(cwd), undefined);
    const prompt = createVerificationPrompt({ command: "npm run check", source: "package.json", reason: "check" });
    assert.match(prompt, /without modifying files/);
    assert.match(prompt, /exact suggested validation command.*npm run check/);
    assert.match(prompt, /instead of substituting another command/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
