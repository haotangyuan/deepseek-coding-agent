import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  applyPromptProfile,
  DEEPSEEK_CODING_PROMPT,
} from "../src/prompt-profile.ts";

test("pi prompt profile preserves the upstream append prompt exactly", () => {
  const base = ["user append prompt"];
  assert.equal(applyPromptProfile("pi", base), base);
});

test("deepseek prompt profile prepends one stable workflow without dropping user context", () => {
  const base = ["user append prompt"];
  assert.deepEqual(applyPromptProfile("deepseek", base), [DEEPSEEK_CODING_PROMPT, "user append prompt"]);
  assert.match(DEEPSEEK_CODING_PROMPT, /Inspect relevant files before editing/);
  assert.match(DEEPSEEK_CODING_PROMPT, /Do not claim success without evidence/);
});

test("deepseek profile composes with Pi's trusted project append prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-code-prompt-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(cwd, ".pi", "APPEND_SYSTEM.md"), "project-owned instruction\n");
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPromptOverride: (base) => applyPromptProfile("deepseek", base),
    });
    await loader.reload();
    assert.deepEqual(loader.getAppendSystemPrompt(), [DEEPSEEK_CODING_PROMPT, "project-owned instruction\n"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
