import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createInteractiveAutocompleteProvider } from "../src/autocomplete.ts";
import type { ContextSnapshot } from "../src/context-resources.ts";
import type { SessionControls } from "../src/sessions.ts";

function snapshot(): ContextSnapshot {
  return {
    projectResourcesEnabled: true,
    systemPromptCharacters: 0,
    estimatedSystemPromptTokens: 0,
    activeTools: [],
    agentsFiles: [],
    skills: [{ name: "review", path: "/workspace/review/SKILL.md", scope: "project", description: "Review code" }],
    prompts: [{ name: "fix", path: "/workspace/fix.md", scope: "project", description: "Fix a bug" }],
    diagnostics: [],
  };
}

function sessionControls(): SessionControls {
  return {
    snapshot: () => ({ id: "session", persisted: true, autoCompaction: true, compacting: false }),
    list: async () => [],
    listAll: async () => [],
    setName: () => {},
    compact: async () => ({ summary: "", firstKeptEntryId: "entry", tokensBefore: 0 }),
    abortCompaction: () => {},
    tree: () => [{ id: "entry-123", parentId: null, depth: 0, type: "message", preview: "user: inspect repo", isLeaf: true }],
    rawTree: () => [],
    leafId: () => "entry-123",
    navigate: async () => ({ cancelled: false }),
    fork: () => ({ id: "fork", file: "/tmp/fork.jsonl" }),
    clone: () => ({ id: "clone", file: "/tmp/clone.jsonl" }),
  };
}

function registry(): ModelRegistry {
  return ModelRegistry.inMemory(AuthStorage.inMemory({ deepseek: { type: "api_key", key: "test" } }));
}

async function suggestions(
  provider: ReturnType<typeof createInteractiveAutocompleteProvider>,
  input: string,
  force = false,
) {
  return provider.getSuggestions([input], 0, input.length, { signal: new AbortController().signal, force });
}

test("completes product commands, resources, DeepSeek models, and tree entries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "deepseek-code-autocomplete-"));
  try {
    const provider = createInteractiveAutocompleteProvider({
      cwd,
      modelRegistry: registry(),
      getThinkingLevels: () => ["off", "low", "high"],
      getContextSnapshot: snapshot,
      sessionControls: sessionControls(),
    });

    const commands = await suggestions(provider, "/");
    assert.ok(commands?.items.some((item) => item.value === "model"));
    assert.ok(commands?.items.some((item) => item.value === "diff"));
    assert.ok(commands?.items.some((item) => item.value === "verify"));
    assert.ok(commands?.items.some((item) => item.value === "tool"));
    assert.ok(commands?.items.some((item) => item.value === "settings"));
    assert.ok(commands?.items.some((item) => item.value === "trust"));
    assert.ok(commands?.items.some((item) => item.value === "undo"));
    assert.ok(commands?.items.some((item) => item.value === "skill:review"));
    assert.ok(commands?.items.some((item) => item.value === "fix"));

    const models = await suggestions(provider, "/model ");
    assert.ok(models?.items.length);
    assert.ok(models?.items.every((item) => item.description?.startsWith("deepseek ·")));

    const tree = await suggestions(provider, "/tree entry");
    assert.deepEqual(tree?.items.map((item) => item.value), ["entry-123"]);
    assert.match(tree?.items[0]?.description ?? "", /current.*inspect repo/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("file completion stays inside the workspace and hides protected paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "deepseek-code-autocomplete-"));
  try {
    await writeFile(join(cwd, "README.md"), "safe");
    await writeFile(join(cwd, ".env"), "DEEPSEEK_API_KEY=secret");
    await mkdir(join(cwd, ".ssh"));
    await writeFile(join(cwd, ".ssh", "id_rsa"), "secret");
    const provider = createInteractiveAutocompleteProvider({
      cwd,
      modelRegistry: registry(),
      getThinkingLevels: () => ["off"],
      getContextSnapshot: snapshot,
      sessionControls: sessionControls(),
    });

    const files = await suggestions(provider, "@", true);
    assert.ok(files?.items.some((item) => item.value === "@README.md"));
    assert.ok(files?.items.every((item) => !item.value.includes(".env") && !item.value.includes(".ssh")));

    const outside = await suggestions(provider, "/", true);
    assert.equal(outside, null);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
