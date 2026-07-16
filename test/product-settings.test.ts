import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_PRODUCT_PREFERENCES,
  ProductSettingsStore,
} from "../src/product-settings.ts";

test("persists only supported local preferences with private permissions", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "deepseek-code-settings-"));
  try {
    const store = new ProductSettingsStore(agentDir);
    assert.deepEqual(store.getPreferences(), DEFAULT_PRODUCT_PREFERENCES);
    store.update({
      model: "deepseek/deepseek-v4-pro",
      thinking: "max",
      mode: "plan",
      approval: "auto-read",
      showReasoning: true,
    });

    const restored = new ProductSettingsStore(agentDir);
    assert.deepEqual(restored.getPreferences(), {
      model: "deepseek-v4-pro",
      thinking: "max",
      mode: "plan",
      approval: "auto-read",
      showReasoning: true,
    });
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    const text = await readFile(store.path, "utf-8");
    assert.doesNotMatch(text, /api.?key|secret|token/i);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("invalid settings fail safe and remain read-only until repaired", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "deepseek-code-settings-"));
  try {
    const store = new ProductSettingsStore(agentDir);
    store.update({});
    await writeFile(store.path, JSON.stringify({ version: 1, apiKey: "must-not-be-loaded" }), "utf-8");
    const invalid = new ProductSettingsStore(agentDir);
    assert.match(invalid.getLoadError()?.message ?? "", /unknown field apiKey/);
    assert.deepEqual(invalid.getPreferences(), DEFAULT_PRODUCT_PREFERENCES);
    assert.throws(() => invalid.update({ mode: "plan" }), /read-only until the invalid file is fixed/);
    assert.match(await readFile(store.path, "utf-8"), /must-not-be-loaded/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
