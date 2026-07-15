import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersistentSessionManager, createSessionControls } from "../src/sessions.ts";

type PersistedMessage = Parameters<SessionManager["appendMessage"]>[0];

function userMessage(text: string): PersistedMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMessage(text: string): PersistedMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("creates an in-memory session for ephemeral evaluation", async () => {
  const manager = await createPersistentSessionManager({
    cwd: process.cwd(),
    sessionDir: join(process.cwd(), ".unused-sessions"),
    selection: { type: "memory" },
  });
  assert.equal(manager.isPersisted(), false);
  assert.equal(manager.getSessionFile(), undefined);
});

test("creates, lists, continues and resumes Pi JSONL sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-sessions-"));
  const cwd = join(root, "workspace");
  const otherCwd = join(root, "other");
  const sessionDir = join(root, "sessions");
  try {
    await mkdir(cwd);
    await mkdir(otherCwd);
    const created = await createPersistentSessionManager({ cwd, sessionDir, selection: { type: "new" } });
    const firstEntryId = created.appendMessage(userMessage("keep the repository goal"));
    const firstAssistantId = created.appendMessage(assistantMessage("understood"));
    created.appendSessionInfo("demo session");
    const sessionFile = created.getSessionFile();
    assert.ok(sessionFile);

    const listed = await SessionManager.list(cwd, sessionDir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.name, "demo session");
    assert.equal(listed[0]?.firstMessage, "keep the repository goal");

    const resumed = await createPersistentSessionManager({
      cwd,
      sessionDir,
      selection: { type: "resume", target: created.getSessionId().slice(0, 8) },
    });
    assert.equal(resumed.getSessionId(), created.getSessionId());
    assert.equal(resumed.buildSessionContext().messages.length, 2);

    const continued = await createPersistentSessionManager({ cwd, sessionDir, selection: { type: "continue" } });
    assert.equal(continued.getSessionId(), created.getSessionId());

    let sessionName = created.getSessionName();
    const controls = createSessionControls({
      sessionId: created.getSessionId(),
      get sessionName() { return sessionName; },
      sessionFile,
      autoCompactionEnabled: true,
      isCompacting: false,
      sessionManager: created,
      setSessionName: (name) => { sessionName = name; created.appendSessionInfo(name); },
      compact: async () => ({ summary: "summary", firstKeptEntryId: firstEntryId, tokensBefore: 2 }),
      abortCompaction: () => undefined,
      navigateTree: async (entryId) => { created.branch(entryId); return { cancelled: false }; },
    }, cwd);
    assert.equal(controls.tree().at(-1)?.isLeaf, true);
    const forked = controls.fork(firstAssistantId.slice(0, 8));
    const cloned = controls.clone();
    assert.notEqual(forked.id, created.getSessionId());
    assert.notEqual(cloned.id, created.getSessionId());
    assert.equal(SessionManager.open(cloned.file).getHeader()?.parentSession, sessionFile);
    await controls.navigate(firstEntryId.slice(0, 8));
    assert.equal(created.getLeafId(), firstEntryId);

    await assert.rejects(
      createPersistentSessionManager({
        cwd: otherCwd,
        sessionDir,
        selection: { type: "resume", target: sessionFile },
      }),
      /different workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves branches and compaction context without rewriting old entries", () => {
  const manager = SessionManager.inMemory("/tmp/project");
  manager.appendMessage(userMessage("goal: fix the parser"));
  manager.appendMessage(assistantMessage("I will inspect it"));
  const keptUserId = manager.appendMessage(userMessage("constraint: do not change the public API"));
  manager.appendMessage(assistantMessage("constraint recorded"));
  const entriesBefore = manager.getEntries();

  manager.appendCompaction(
    "Goal: fix the parser. Constraint: preserve its public API. Key file: src/parser.ts. Unfinished: run the regression test.",
    keptUserId,
    120,
  );
  const context = manager.buildSessionContext().messages;
  assert.equal(manager.getEntries().length, entriesBefore.length + 1);
  assert.equal(context[0]?.role, "compactionSummary");
  assert.match(JSON.stringify(context), /preserve its public API/);
  assert.match(JSON.stringify(context), /do not change the public API/);
  assert.match(JSON.stringify(context), /src\/parser\.ts/);
  assert.match(JSON.stringify(context), /run the regression test/);

  manager.branch(entriesBefore[1]!.id);
  manager.appendMessage(userMessage("alternative branch"));
  assert.equal(manager.getTree().length, 1);
  assert.equal(manager.getChildren(entriesBefore[1]!.id).length, 2);
});

test("reports an explicit corrupted session instead of silently starting over", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-corrupt-session-"));
  const cwd = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  const corrupted = join(root, "broken.jsonl");
  try {
    await mkdir(cwd);
    await writeFile(corrupted, "not-json\n");
    await assert.rejects(
      createPersistentSessionManager({
        cwd,
        sessionDir,
        selection: { type: "resume", target: corrupted },
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
