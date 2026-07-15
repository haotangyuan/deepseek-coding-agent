import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureContextSnapshot,
  createProjectResourceFilter,
} from "../src/context-resources.ts";

test("preserves Pi AGENTS order and can temporarily filter project resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-context-"));
  const agentDir = join(root, "agent-home");
  const parent = join(root, "workspace");
  const cwd = join(parent, "project");
  try {
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await mkdir(join(cwd, ".pi", "skills", "project-skill"), { recursive: true });
    await mkdir(join(cwd, ".pi", "prompts"), { recursive: true });
    await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
    await writeFile(join(parent, "AGENTS.md"), "parent instructions\n");
    await writeFile(join(cwd, "AGENTS.md"), "project instructions\n");
    await writeFile(
      join(cwd, ".pi", "skills", "project-skill", "SKILL.md"),
      "---\nname: project-skill\ndescription: Project test skill\n---\n\nUse this skill.\n",
    );
    await writeFile(
      join(cwd, ".pi", "prompts", "review.md"),
      "---\ndescription: Review template\n---\n\nReview $ARGUMENTS.\n",
    );

    const filter = createProjectResourceFilter(cwd, agentDir);
    const settingsManager = SettingsManager.inMemory({});
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      skillsOverride: filter.skillsOverride,
      promptsOverride: filter.promptsOverride,
      agentsFilesOverride: filter.agentsFilesOverride,
    });
    await loader.reload();

    const enabled = captureContextSnapshot({
      loader,
      cwd,
      agentDir,
      projectResourcesEnabled: filter.isEnabled(),
      effectiveSystemPrompt: "system prompt",
      activeTools: ["read"],
    });
    assert.deepEqual(enabled.agentsFiles.map((file) => file.path), [
      join(agentDir, "AGENTS.md"),
      join(parent, "AGENTS.md"),
      join(cwd, "AGENTS.md"),
    ]);
    assert.deepEqual(enabled.agentsFiles.map((file) => file.scope), ["user", "ancestor", "project"]);
    assert.ok(enabled.skills.some((skill) => skill.name === "project-skill" && skill.scope === "project"));
    assert.ok(enabled.prompts.some((prompt) => prompt.name === "review" && prompt.scope === "project"));
    assert.equal(enabled.estimatedSystemPromptTokens, 4);

    const authStorage = AuthStorage.inMemory({ deepseek: { type: "api_key", key: "test-api-key" } });
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const model = modelRegistry.find("deepseek", "deepseek-v4-flash");
    assert.ok(model);
    const { session } = await createAgentSession({
      cwd,
      authStorage,
      modelRegistry,
      model,
      tools: ["read"],
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
    });
    assert.match(session.systemPrompt, /project instructions/);

    filter.setEnabled(false);
    await session.reload();
    assert.doesNotMatch(session.systemPrompt, /project instructions/);
    assert.doesNotMatch(session.systemPrompt, /parent instructions/);
    const disabled = captureContextSnapshot({
      loader,
      cwd,
      agentDir,
      projectResourcesEnabled: filter.isEnabled(),
      effectiveSystemPrompt: "system prompt",
      activeTools: ["read"],
    });
    assert.deepEqual(disabled.agentsFiles.map((file) => file.path), [join(agentDir, "AGENTS.md")]);
    assert.equal(disabled.skills.some((skill) => skill.name === "project-skill"), false);
    assert.equal(disabled.prompts.some((prompt) => prompt.name === "review"), false);
    session.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
