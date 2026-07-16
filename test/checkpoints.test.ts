import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { createTurnCheckpointExtension, TurnCheckpointManager } from "../src/checkpoints.ts";

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "deepseek-agent-checkpoint-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("diffs and restores the pre-agent state without discarding existing dirty content", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "tracked.txt");
    await writeFile(path, "user dirty baseline\n");
    await chmod(path, 0o744);
    const checkpoints = new TurnCheckpointManager(workspace);

    checkpoints.beginTurn();
    await checkpoints.captureFileBefore("tracked.txt");
    await writeFile(path, "agent result\n");
    await chmod(path, 0o600);
    await checkpoints.finishTurn();

    const diff = checkpoints.diff();
    assert.deepEqual(diff.files, ["tracked.txt"]);
    assert.match(diff.patch, /-user dirty baseline/);
    assert.match(diff.patch, /\+agent result/);

    assert.deepEqual(await checkpoints.undo(), { restoredFiles: ["tracked.txt"] });
    assert.equal(await readFile(path, "utf8"), "user dirty baseline\n");
    assert.equal((await stat(path)).mode & 0o777, 0o744);
    assert.equal(checkpoints.snapshot().status, "undone");
  });
});

test("removes newly created files and keeps the first snapshot across repeated edits", async () => {
  await withWorkspace(async (workspace) => {
    const existing = join(workspace, "existing.txt");
    const created = join(workspace, "created.txt");
    await writeFile(existing, "before\n");
    const checkpoints = new TurnCheckpointManager(workspace);

    checkpoints.beginTurn();
    await checkpoints.captureFileBefore("existing.txt");
    await writeFile(existing, "middle\n");
    await checkpoints.captureFileBefore("existing.txt");
    await writeFile(existing, "after\n");
    await checkpoints.captureFileBefore("created.txt");
    await writeFile(created, "new\n");
    await checkpoints.finishTurn();

    assert.deepEqual(checkpoints.snapshot().files, ["created.txt", "existing.txt"]);
    await checkpoints.undo();
    assert.equal(await readFile(existing, "utf8"), "before\n");
    await assert.rejects(readFile(created), (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT");
  });
});

test("refuses the whole undo when any file changed after the agent turn", async () => {
  await withWorkspace(async (workspace) => {
    const first = join(workspace, "first.txt");
    const second = join(workspace, "second.txt");
    await writeFile(first, "first before\n");
    await writeFile(second, "second before\n");
    const checkpoints = new TurnCheckpointManager(workspace);

    checkpoints.beginTurn();
    await checkpoints.captureFileBefore("first.txt");
    await checkpoints.captureFileBefore("second.txt");
    await writeFile(first, "first agent\n");
    await writeFile(second, "second agent\n");
    await checkpoints.finishTurn();
    await writeFile(second, "user changed after agent\n");

    await assert.rejects(checkpoints.undo(), /files changed after the agent turn: second\.txt/);
    assert.equal(await readFile(first, "utf8"), "first agent\n");
    assert.equal(await readFile(second, "utf8"), "user changed after agent\n");
    assert.equal(checkpoints.snapshot().status, "ready");
  });
});

test("reports Bash as outside the automatic file undo boundary", async () => {
  await withWorkspace(async (workspace) => {
    const checkpoints = new TurnCheckpointManager(workspace);
    checkpoints.beginTurn();
    checkpoints.observeBash();
    await checkpoints.finishTurn();

    assert.deepEqual(checkpoints.snapshot(), {
      status: "ready",
      files: [],
      bashObserved: true,
      warnings: [],
    });
    assert.equal(checkpoints.diff().bashObserved, true);
    await assert.rejects(checkpoints.undo(), /No undoable write\/edit changes/);
  });
});

test("a read-only turn does not erase the latest mutating checkpoint", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "file.txt");
    await writeFile(path, "before\n");
    const checkpoints = new TurnCheckpointManager(workspace);

    checkpoints.beginTurn();
    await checkpoints.captureFileBefore("file.txt");
    await writeFile(path, "after\n");
    await checkpoints.finishTurn();
    checkpoints.beginTurn();
    await checkpoints.finishTurn();

    assert.deepEqual(checkpoints.snapshot().files, ["file.txt"]);
    await checkpoints.undo();
    assert.equal(await readFile(path, "utf8"), "before\n");
  });
});

test("persists one private checkpoint per session and supports undo after resume", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "resume.txt");
    const storage = join(workspace, ".agent-data", "session.json");
    await writeFile(path, "before resume\n");
    const firstProcess = new TurnCheckpointManager(workspace, storage);

    firstProcess.beginTurn();
    await firstProcess.captureFileBefore("resume.txt");
    await writeFile(path, "after agent\n");
    await firstProcess.finishTurn();
    assert.equal((await stat(storage)).mode & 0o777, 0o600);

    const resumedProcess = new TurnCheckpointManager(workspace, storage);
    await resumedProcess.load();
    assert.deepEqual(resumedProcess.snapshot().files, ["resume.txt"]);
    await resumedProcess.undo();
    assert.equal(await readFile(path, "utf8"), "before resume\n");
    await assert.rejects(stat(storage), (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT");
  });
});

test("captures real Pi extension lifecycle events around write tools", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "extension.txt");
    await writeFile(path, "before\n");
    const checkpoints = new TurnCheckpointManager(workspace);
    let agentStart: (() => Promise<void>) | undefined;
    let toolCall: ((event: ToolCallEvent) => Promise<void>) | undefined;
    let agentSettled: (() => Promise<void>) | undefined;
    const api = {
      on: (event: string, handler: unknown) => {
        if (event === "agent_start") agentStart = handler as () => Promise<void>;
        if (event === "tool_call") toolCall = handler as (toolEvent: ToolCallEvent) => Promise<void>;
        if (event === "agent_settled") agentSettled = handler as () => Promise<void>;
      },
    } as unknown as ExtensionAPI;
    const extension = createTurnCheckpointExtension(checkpoints);
    const factory = typeof extension === "function" ? extension : extension.factory;
    await factory(api);

    await agentStart?.();
    await toolCall?.({
      type: "tool_call",
      toolCallId: "write-1",
      toolName: "write",
      input: { path: "extension.txt", content: "after\n" },
    });
    await writeFile(path, "after\n");
    await agentSettled?.();

    assert.deepEqual(checkpoints.snapshot().files, ["extension.txt"]);
    assert.match(checkpoints.diff().patch, /\+after/);
  });
});

test("refuses undo when a checkpoint path is replaced by a symlink", async () => {
  await withWorkspace(async (workspace) => {
    const outside = await mkdtemp(join(tmpdir(), "deepseek-agent-checkpoint-outside-"));
    try {
      const path = join(workspace, "target.txt");
      const outsidePath = join(outside, "outside.txt");
      await writeFile(path, "before\n");
      await writeFile(outsidePath, "agent result\n");
      const checkpoints = new TurnCheckpointManager(workspace);
      checkpoints.beginTurn();
      await checkpoints.captureFileBefore("target.txt");
      await writeFile(path, "agent result\n");
      await checkpoints.finishTurn();

      await rm(path);
      await symlink(outsidePath, path);
      await assert.rejects(checkpoints.undo(), /files changed after the agent turn: target\.txt/);
      assert.equal(await readFile(outsidePath, "utf8"), "agent result\n");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
