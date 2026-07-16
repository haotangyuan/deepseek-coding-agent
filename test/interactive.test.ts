import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgentSessionEvent,
  AuthStorage,
  type CreateAgentSessionOptions,
  ModelRegistry,
  type SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";
import {
  InteractiveMode,
  type InteractiveSession,
  parseInteractiveCommand,
} from "../src/interactive.ts";
import type { ContextSnapshot } from "../src/context-resources.ts";
import type { SessionControls } from "../src/sessions.ts";

type SelectedModel = NonNullable<CreateAgentSessionOptions["model"]>;
type ThinkingLevel = InteractiveSession["thinkingLevel"];

class FakeTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  output = "";
  private input: ((data: string) => void) | undefined;

  start(onInput: (data: string) => void): void {
    this.input = onInput;
  }

  stop(): void {
    this.input = undefined;
  }

  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  type(text: string): void {
    for (const character of text) this.input?.(character);
    this.input?.("\r");
  }

  ctrlC(): void {
    this.input?.("\x03");
  }
}

class FakeSession implements InteractiveSession {
  isStreaming = false;
  get isIdle(): boolean { return !this.isStreaming; }
  thinkingLevel: ThinkingLevel = "high";
  systemPrompt = "system prompt";
  model: SelectedModel;
  prompts: string[] = [];
  steering: string[] = [];
  aborts = 0;
  reloads = 0;
  private listener: ((event: AgentSessionEvent) => void) | undefined;

  constructor(model: SelectedModel) {
    this.model = model;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }

  emit(event: AgentSessionEvent): void {
    this.listener?.(event);
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.isStreaming = true;
    const partial = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "deepseek",
      model: this.model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 0,
    } as const;
    this.listener?.({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "private plan", partial },
    } as unknown as AgentSessionEvent);
    this.listener?.({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: `answer ${text}`, partial },
    } as unknown as AgentSessionEvent);
    this.isStreaming = false;
    this.listener?.({ type: "agent_settled" });
  }

  async steer(text: string): Promise<void> {
    this.steering.push(text);
  }

  async abort(): Promise<void> {
    this.aborts += 1;
    this.isStreaming = false;
  }

  async waitForIdle(): Promise<void> {}

  async setModel(model: SelectedModel): Promise<void> {
    this.model = model;
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevel = level;
  }

  getAvailableThinkingLevels(): ThinkingLevel[] {
    return ["off", "low", "high"];
  }

  getActiveToolNames(): string[] {
    return ["read", "ls", "grep", "write", "edit", "bash"];
  }

  async reload(): Promise<void> {
    this.reloads += 1;
  }

  getSessionStats(): SessionStats {
    return {
      sessionFile: undefined,
      sessionId: "test",
      userMessages: this.prompts.length,
      assistantMessages: this.prompts.length,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: this.prompts.length * 2,
      tokens: { input: this.prompts.length, output: this.prompts.length, cacheRead: 0, cacheWrite: 0, total: this.prompts.length * 2 },
      cost: 0,
    };
  }

  dispose(): void {}
}

function createRegistry(): ModelRegistry {
  const auth = AuthStorage.inMemory({ deepseek: { type: "api_key", key: "test-api-key" } });
  return ModelRegistry.inMemory(auth);
}

function createSnapshot(): ContextSnapshot {
  return {
    projectResourcesEnabled: true,
    systemPromptCharacters: 120,
    estimatedSystemPromptTokens: 30,
    activeTools: ["read", "ls", "grep", "write", "edit", "bash"],
    agentsFiles: [{ name: "AGENTS.md", path: joinForTest("AGENTS.md"), scope: "project", characters: 42 }],
    skills: [{ name: "review", path: joinForTest(".pi/skills/review/SKILL.md"), scope: "project", description: "Review code", modelInvocable: true }],
    prompts: [{ name: "fix", path: joinForTest(".pi/prompts/fix.md"), scope: "project", description: "Fix prompt", characters: 20 }],
    diagnostics: [],
  };
}

function createSessionControls(): SessionControls & {
  names: string[];
  compactions: Array<string | undefined>;
  navigations: string[];
  compactionAborts: number;
} {
  const names: string[] = [];
  const compactions: Array<string | undefined> = [];
  const navigations: string[] = [];
  const controls = {
    names,
    compactions,
    navigations,
    compactionAborts: 0,
    snapshot: () => ({
      id: "session-test-id",
      name: names.at(-1),
      file: "/tmp/session-test-id.jsonl",
      persisted: true,
      autoCompaction: true,
      compacting: false,
    }),
    list: async () => [{
      id: "session-test-id",
      name: names.at(-1),
      created: new Date("2026-07-15T00:00:00Z"),
      modified: new Date("2026-07-15T01:00:00Z"),
      messageCount: 6,
      firstMessage: "first task",
      cwd: process.cwd(),
      model: "deepseek/deepseek-v4-flash",
      path: "/tmp/session-test-id.jsonl",
    }],
    setName: (name: string) => { names.push(name); },
    compact: async (instructions?: string) => {
      compactions.push(instructions);
      return { summary: "kept goal", firstKeptEntryId: "entry-2", tokensBefore: 100, estimatedTokensAfter: 20 };
    },
    abortCompaction: () => { controls.compactionAborts += 1; },
    tree: () => [{ id: "entry-1", parentId: null, depth: 0, type: "message", preview: "user: first task", isLeaf: true }],
    navigate: async (entryId: string) => {
      navigations.push(entryId);
      return { cancelled: false };
    },
    fork: () => ({ id: "forked-id", file: "/tmp/forked.jsonl" }),
    clone: () => ({ id: "cloned-id", file: "/tmp/cloned.jsonl" }),
  };
  return controls;
}

function joinForTest(path: string): string {
  return `${process.cwd()}/${path}`;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

function plainTerminalOutput(terminal: FakeTerminal): string {
  return terminal.output.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("parses supported interactive commands without treating normal prompts as commands", () => {
  assert.equal(parseInteractiveCommand("hello"), undefined);
  assert.deepEqual(parseInteractiveCommand("/model deepseek-v4-pro"), { name: "model", argument: "deepseek-v4-pro" });
  assert.deepEqual(parseInteractiveCommand("/thinking high"), { name: "thinking", argument: "high" });
  assert.deepEqual(parseInteractiveCommand("/missing"), { name: "unknown", argument: "missing" });
});

test("runs three turns, folds reasoning, handles approval, and exits in an 80x24 terminal", async () => {
  const registry = createRegistry();
  const model = registry.find("deepseek", "deepseek-v4-flash");
  assert.ok(model);
  const session = new FakeSession(model);
  const terminal = new FakeTerminal();
  let clears = 0;
  const snapshot = createSnapshot();
  const sessionControls = createSessionControls();
  const mode = new InteractiveMode({
    session,
    modelRegistry: registry,
    cwd: process.cwd(),
    approvalMode: "ask",
    sessionControls,
    terminal,
    clearContext: () => { clears += 1; },
    getContextSnapshot: () => snapshot,
    setProjectResourcesEnabled: async (enabled) => {
      snapshot.projectResourcesEnabled = enabled;
      await session.reload();
    },
    getGitStatus: async () => ({ available: true, status: "" }),
  });
  const running = mode.run();
  await flush();

  terminal.type("first");
  await flush();
  terminal.type("second");
  await flush();
  terminal.type("third");
  await flush();

  assert.deepEqual(session.prompts, ["first", "second", "third"]);
  assert.match(plainTerminalOutput(terminal), /\[thinking\] 12 chars/);
  assert.doesNotMatch(plainTerminalOutput(terminal), /private plan/);

  terminal.type("/reasoning");
  await flush();
  assert.match(plainTerminalOutput(terminal), /private plan/);

  terminal.type("/thinking low");
  await flush();
  assert.equal(session.thinkingLevel, "low");

  terminal.type("/model deepseek-v4-pro");
  await flush();
  assert.equal(session.model.id, "deepseek-v4-pro");

  session.emit({
    type: "tool_execution_start",
    toolCallId: "read-1",
    toolName: "read",
    args: { path: "README.md" },
  });
  session.emit({
    type: "tool_execution_end",
    toolCallId: "read-1",
    toolName: "read",
    result: { content: [{ type: "text", text: "read ok" }], details: undefined },
    isError: false,
  });
  await flush();
  assert.match(plainTerminalOutput(terminal), /\[tool:read\] done read ok/);

  session.emit({
    type: "tool_execution_end",
    toolCallId: "bash-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "exit 1" }], details: undefined },
    isError: true,
  });
  session.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "deepseek",
      model: session.model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error",
      errorMessage: "network unavailable",
      timestamp: 0,
    },
  } as unknown as AgentSessionEvent);
  session.emit({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 500,
    errorMessage: "network unavailable",
  });
  session.emit({ type: "auto_retry_end", success: true, attempt: 1 });
  session.emit({
    type: "auto_retry_start",
    attempt: 3,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: "503 service overloaded",
  });
  session.emit({ type: "auto_retry_end", success: false, attempt: 3, finalError: "503 service overloaded" });
  await flush();
  assert.match(plainTerminalOutput(terminal), /TOOL FAILED · bash.*exit 1.*Agent loop continues/s);
  assert.match(plainTerminalOutput(terminal), /PROVIDER ERROR · NETWORK.*network unavailable.*Check network/s);
  assert.match(plainTerminalOutput(terminal), /RETRY RECOVERED · ATTEMPT 1.*Agent loop continues/s);
  assert.match(plainTerminalOutput(terminal), /RETRY EXHAUSTED · ATTEMPT 3.*Session will return to idle/s);

  terminal.type("/context");
  await flush();
  terminal.type("/agents");
  await flush();
  terminal.type("/skills");
  await flush();
  terminal.type("/prompts");
  await flush();
  assert.match(plainTerminalOutput(terminal), /CONTEXT MAP/);
  assert.match(plainTerminalOutput(terminal), /AGENTS load order/);
  assert.match(plainTerminalOutput(terminal), /Review code/);
  assert.match(plainTerminalOutput(terminal), /Fix prompt/);

  terminal.type("/skill:review inspect this");
  await flush();
  terminal.type("/fix src/main.ts");
  await flush();
  assert.deepEqual(session.prompts.slice(-2), ["/skill:review inspect this", "/fix src/main.ts"]);

  terminal.type("/resources off");
  await flush();
  assert.equal(snapshot.projectResourcesEnabled, false);
  assert.equal(session.reloads, 1);

  terminal.type("/session");
  await flush();
  terminal.type("/sessions");
  await flush();
  terminal.type("/name demo session");
  await flush();
  terminal.type("/compact keep the goal");
  await flush();
  terminal.type("/tree entry-1");
  await flush();
  terminal.type("/fork entry-1");
  await flush();
  terminal.type("/clone");
  await flush();
  assert.deepEqual(sessionControls.names, ["demo session"]);
  assert.deepEqual(sessionControls.compactions, ["keep the goal"]);
  assert.deepEqual(sessionControls.navigations, ["entry-1"]);
  assert.match(plainTerminalOutput(terminal), /SESSION TREE/);
  assert.match(plainTerminalOutput(terminal), /fork created forked-id/);
  assert.match(plainTerminalOutput(terminal), /clone created cloned-id/);

  const approval = mode.requestApproval({ toolName: "write", summary: "write demo.txt", preview: "+demo" });
  terminal.type("y");
  assert.equal(await approval, true);

  terminal.type("/clear");
  await flush();
  assert.equal(clears, 1);

  terminal.type("/exit");
  await running;
});

test("queues steering while streaming and Ctrl+C aborts the active run", async () => {
  const registry = createRegistry();
  const model = registry.find("deepseek", "deepseek-v4-flash");
  assert.ok(model);
  const session = new FakeSession(model);
  const terminal = new FakeTerminal();
  const snapshot = createSnapshot();
  const sessionControls = createSessionControls();
  const mode = new InteractiveMode({
    session,
    modelRegistry: registry,
    cwd: process.cwd(),
    approvalMode: "ask",
    sessionControls,
    terminal,
    clearContext: () => undefined,
    getContextSnapshot: () => snapshot,
    setProjectResourcesEnabled: async (enabled) => { snapshot.projectResourcesEnabled = enabled; },
    getGitStatus: async () => ({ available: false, status: "" }),
  });
  const running = mode.run();
  await flush();

  session.isStreaming = true;
  terminal.type("adjust the plan");
  await flush();
  assert.deepEqual(session.steering, ["adjust the plan"]);

  terminal.ctrlC();
  await flush();
  assert.equal(session.aborts, 1);
  assert.match(plainTerminalOutput(terminal), /RUN CANCELLED.*Session ready/s);

  terminal.type("/exit");
  await running;
});
