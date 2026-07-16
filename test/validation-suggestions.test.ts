import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createVerificationPrompt,
  discoverValidationSuggestions,
} from "../src/validation-suggestions.ts";

test("prefers the narrowest declared package validation and respects the package manager", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "deepseek-code-verify-"));
  try {
    await writeFile(join(cwd, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.0.0",
      scripts: { build: "tsc", test: "node --test", check: "tsc --noEmit" },
    }));
    assert.deepEqual(await discoverValidationSuggestions(cwd), [{
      name: "auto",
      command: "pnpm run check",
      source: "package.json",
      reason: "highest-priority available package script: check",
      scope: "inferred",
    }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("loads multiple named commands only when trusted project configuration is enabled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "deepseek-code-verify-"));
  try {
    await mkdir(join(cwd, ".deepseek-code"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { check: "tsc" } }));
    await writeFile(join(cwd, ".deepseek-code", "validation.json"), JSON.stringify({ commands: [
      { name: "unit", command: "npm test", description: "Fast unit tests" },
      { name: "full", command: "npm run check && npm test", description: "Full local gate" },
    ] }));

    assert.equal((await discoverValidationSuggestions(cwd))[0]?.scope, "inferred");
    assert.deepEqual(await discoverValidationSuggestions(cwd, { projectConfigEnabled: true }), [
      { name: "unit", command: "npm test", source: ".deepseek-code/validation.json", reason: "Fast unit tests", scope: "project" },
      { name: "full", command: "npm run check && npm test", source: ".deepseek-code/validation.json", reason: "Full local gate", scope: "project" },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects malformed project commands instead of silently falling back", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "deepseek-code-verify-"));
  try {
    await mkdir(join(cwd, ".deepseek-code"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { check: "tsc" } }));
    await writeFile(join(cwd, ".deepseek-code", "validation.json"), JSON.stringify({ commands: [
      { name: "check", command: "npm run check\nrm -rf ." },
    ] }));
    await assert.rejects(
      discoverValidationSuggestions(cwd, { projectConfigEnabled: true }),
      /command must be a single line/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects a validation configuration symlink that escapes the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-code-verify-"));
  const cwd = join(root, "workspace");
  try {
    await mkdir(join(cwd, ".deepseek-code"), { recursive: true });
    const outside = join(root, "outside.json");
    await writeFile(outside, JSON.stringify({ commands: [{ name: "check", command: "npm test" }] }));
    await symlink(outside, join(cwd, ".deepseek-code", "validation.json"));
    await assert.rejects(
      discoverValidationSuggestions(cwd, { projectConfigEnabled: true }),
      /resolves outside the workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back through known manifests without executing or reading arbitrary project files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "deepseek-code-verify-"));
  try {
    await writeFile(join(cwd, "package.json"), "not-json");
    await writeFile(join(cwd, "pyproject.toml"), "[project]\nname='demo'\n");
    assert.deepEqual(await discoverValidationSuggestions(cwd), [{
      name: "auto",
      command: "python -m pytest",
      source: "pyproject.toml",
      reason: "Python project manifest detected",
      scope: "inferred",
    }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("returns no suggestion for an unknown project and builds a bounded verification prompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "deepseek-code-verify-"));
  try {
    assert.deepEqual(await discoverValidationSuggestions(cwd), []);
    const prompt = createVerificationPrompt({
      name: "check",
      command: "npm run check",
      source: "package.json",
      reason: "check",
      scope: "inferred",
    });
    assert.match(prompt, /without modifying files/);
    assert.match(prompt, /exact suggested validation command.*npm run check/);
    assert.match(prompt, /instead of substituting another command/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
