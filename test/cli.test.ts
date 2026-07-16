import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { AuthStorage, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { formatAgentEvent, parseCliArgs, resolveDeepSeekModel, sanitizeError } from "../src/cli.ts";
import { type CliDependencies, resolveSessionModel, runCli } from "../src/main.ts";

type SelectedModel = NonNullable<CreateAgentSessionOptions["model"]>;

function createRegistry(configured: boolean): { authStorage: AuthStorage; modelRegistry: ModelRegistry } {
  const authStorage = configured
    ? AuthStorage.inMemory({ deepseek: { type: "api_key", key: "test-api-key" } })
    : AuthStorage.inMemory();
  return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
}

test("parses the default model and task text", () => {
  assert.deepEqual(parseCliArgs(["summarize", "this", "repo"]), {
    help: false,
    modelId: "deepseek-v4-flash",
    modelExplicit: false,
    thinkingLevel: "high",
    thinkingExplicit: false,
    approvalMode: "ask",
    agentMode: "build",
    session: { type: "new" },
    metrics: false,
    task: "summarize this repo",
  });
});

test("accepts an explicit DeepSeek model and rejects other providers", () => {
  const parsed = parseCliArgs(["--model", "deepseek/deepseek-v4-flash", "task"]);
  assert.equal(parsed.modelId, "deepseek-v4-flash");
  assert.equal(parsed.modelExplicit, true);
  assert.throws(() => parseCliArgs(["--model", "openai/gpt-5", "task"]), /Only the deepseek provider/);
});

test("rejects unknown options and missing model values", () => {
  assert.throws(() => parseCliArgs(["--unknown"]), /Unknown option/);
  assert.throws(() => parseCliArgs(["--model"]), /requires a value/);
  assert.throws(() => parseCliArgs(["--approval", "always"]), /Invalid approval mode/);
  assert.throws(() => parseCliArgs(["--mode", "review"]), /Invalid agent mode/);
});

test("parses explicit approval modes", () => {
  assert.equal(parseCliArgs(["--approval", "auto-read", "task"]).approvalMode, "auto-read");
  assert.equal(parseCliArgs(["--approval=deny", "task"]).approvalMode, "deny");
});

test("parses explicit plan and build modes", () => {
  assert.equal(parseCliArgs(["--mode", "plan", "task"]).agentMode, "plan");
  assert.equal(parseCliArgs(["--mode=build", "task"]).agentMode, "build");
});

test("parses reproducible thinking, metrics and ephemeral options", () => {
  const parsed = parseCliArgs(["--thinking=max", "--metrics", "--ephemeral", "task"]);
  assert.equal(parsed.thinkingLevel, "max");
  assert.equal(parsed.thinkingExplicit, true);
  assert.equal(parsed.metrics, true);
  assert.deepEqual(parsed.session, { type: "memory" });
  assert.throws(() => parseCliArgs(["--thinking", "medium", "task"]), /Invalid thinking level/);
  assert.throws(() => parseCliArgs(["--ephemeral", "--continue", "task"]), /Only one session selection/);
});

test("parses persistent session selection and rejects conflicts", () => {
  assert.deepEqual(parseCliArgs(["--continue"]).session, { type: "continue" });
  assert.deepEqual(parseCliArgs(["--resume", "abc123"]).session, { type: "resume", target: "abc123" });
  assert.deepEqual(parseCliArgs(["--resume=history.jsonl"]).session, { type: "resume", target: "history.jsonl" });
  assert.throws(() => parseCliArgs(["--continue", "--resume", "abc"]), /Only one session selection/);
  assert.throws(() => parseCliArgs(["--resume"]), /requires a value/);
});

test("resolves only an existing and authenticated DeepSeek model", () => {
  const available = createRegistry(true).modelRegistry;
  assert.equal(resolveDeepSeekModel(available, "deepseek-v4-flash").provider, "deepseek");
  assert.throws(() => resolveDeepSeekModel(available, "missing"), /Unknown DeepSeek model/);

  const unavailable = createRegistry(false).modelRegistry;
  assert.throws(() => resolveDeepSeekModel(unavailable, "deepseek-v4-flash"), /DEEPSEEK_API_KEY/);
});

test("restores only a saved DeepSeek model unless the CLI model was explicit", () => {
  const { modelRegistry } = createRegistry(true);
  const flash = modelRegistry.find("deepseek", "deepseek-v4-flash");
  assert.ok(flash);
  const saved = SessionManager.inMemory(process.cwd());
  saved.appendModelChange("deepseek", "deepseek-v4-pro");
  assert.equal(resolveSessionModel(modelRegistry, flash, saved, true).id, "deepseek-v4-pro");
  assert.equal(resolveSessionModel(modelRegistry, flash, saved, false).id, "deepseek-v4-flash");

  const unsupported = SessionManager.inMemory(process.cwd());
  unsupported.appendModelChange("openai", "gpt-5");
  assert.throws(() => resolveSessionModel(modelRegistry, flash, unsupported, true), /Only the deepseek provider/);
});

test("formats text, reasoning, tool and completion events", () => {
  const partial = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  } as const;
  const textEvent = {
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok", partial },
  } as unknown as AgentSessionEvent;
  const thinkingEvent = {
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "plan", partial },
  } as unknown as AgentSessionEvent;
  const toolStart = { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "README.md" } } as AgentSessionEvent;
  const toolEnd = { type: "tool_execution_end", toolCallId: "1", toolName: "read", result: { content: [] }, isError: false } as AgentSessionEvent;
  const toolArguments = {
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"path":"READ', partial },
  } as unknown as AgentSessionEvent;
  const providerError = {
    type: "message_end",
    message: { ...partial, stopReason: "error", errorMessage: "request failed with sk-1234567890abcdef" },
  } as unknown as AgentSessionEvent;

  assert.deepEqual(formatAgentEvent(textEvent), [{ channel: "stdout", text: "ok" }]);
  assert.match(formatAgentEvent(thinkingEvent)[0]?.text ?? "", /reasoning:delta.*plan/);
  assert.match(formatAgentEvent(toolArguments)[0]?.text ?? "", /arguments-delta.*path/);
  assert.match(formatAgentEvent(toolStart)[0]?.text ?? "", /tool:start.*README\.md/);
  assert.match(formatAgentEvent(toolEnd)[0]?.text ?? "", /tool:result/);
  assert.match(formatAgentEvent(providerError)[0]?.text ?? "", /provider:error.*category=unknown.*\[REDACTED\]/);
  assert.deepEqual(formatAgentEvent({ type: "agent_settled" }), [{ channel: "stderr", text: "[agent:complete]\n" }]);
});

test("redacts key-shaped values from errors", () => {
  assert.equal(sanitizeError(new Error("request failed with sk-1234567890abcdef")), "request failed with [REDACTED]");
});

test("runCli passes the explicit DeepSeek model and emits substitute events", async () => {
  const { authStorage, modelRegistry } = createRegistry(true);
  let selectedModel: SelectedModel | undefined;
  let selectedTools: string[] = [];
  let selectedSession = "";
  let restoreSavedModel = true;
  let selectedThinking: string | undefined;
  let selectedAgentMode = "";
  let prompt = "";
  let prompted = false;
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const dependencies: CliDependencies = {
    cwd: process.cwd(),
    interactiveTerminal: false,
    authStorage,
    modelRegistry,
    createSession: async (options) => {
      selectedModel = options.model;
      selectedTools = options.tools;
      selectedSession = options.sessionSelection.type;
      restoreSavedModel = options.restoreSavedModel;
      selectedThinking = options.thinkingLevel;
      selectedAgentMode = options.toolPolicy.agentMode;
      return {
        session: {
          subscribe: (nextListener) => {
            listener = nextListener;
            return () => undefined;
          },
          prompt: async (text) => {
            prompt = text;
            prompted = true;
            listener?.({
              type: "tool_execution_start",
              toolCallId: "1",
              toolName: "edit",
              args: { path: "README.md", edits: [] },
            });
            listener?.({
              type: "tool_execution_end",
              toolCallId: "1",
              toolName: "edit",
              result: { content: [] },
              isError: false,
            });
            listener?.({ type: "agent_settled" });
          },
          getSessionStats: () => ({
            sessionFile: undefined,
            sessionId: "test-session",
            userMessages: 1,
            assistantMessages: 1,
            toolCalls: 1,
            toolResults: 1,
            totalMessages: 3,
            tokens: prompted
              ? { input: 10, output: 2, cacheRead: 30, cacheWrite: 0, total: 42 }
              : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: prompted ? 0.001 : 0,
          }),
          dispose: () => undefined,
        },
      };
    },
    runInteractive: async () => undefined,
    getGitStatus: async () => ({ available: true, status: " M README.md" }),
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(["--model", "deepseek-v4-flash", "--thinking", "max", "--metrics", "say", "ok"], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  }, dependencies);

  assert.equal(code, 0);
  assert.equal(selectedModel?.provider, "deepseek");
  assert.equal(selectedModel?.id, "deepseek-v4-flash");
  assert.deepEqual(selectedTools, ["read", "ls", "grep", "write", "edit", "bash"]);
  assert.equal(selectedSession, "new");
  assert.equal(restoreSavedModel, false);
  assert.equal(selectedThinking, "max");
  assert.equal(selectedAgentMode, "build");
  assert.equal(prompt, "say ok");
  assert.equal(stdout.join(""), "");
  assert.match(stderr.join(""), /agent:complete/);
  assert.match(stderr.join(""), /\[evidence\].*files=README\.md.*bash=0 · tool-errors=0/s);
  assert.match(stderr.join(""), /evidence:attention.*no recognized validation/s);
  assert.match(stderr.join(""), /\[cache\].*turn hit=30 miss=10 rate=75\.0% prompt=40/s);
  assert.match(stderr.join(""), /git:status.*README\.md/s);
  assert.match(stderr.join(""), /\[metrics\].*"cacheHitRate":0\.75/);
});

test("runCli fails before session creation when credentials are missing", async () => {
  const { authStorage, modelRegistry } = createRegistry(false);
  let created = false;
  const code = await runCli(["task"], { stdout: () => undefined, stderr: () => undefined }, {
    cwd: process.cwd(),
    interactiveTerminal: false,
    authStorage,
    modelRegistry,
    createSession: async () => {
      created = true;
      throw new Error("must not run");
    },
    runInteractive: async () => undefined,
    getGitStatus: async () => ({ available: false, status: "" }),
  });
  assert.equal(code, 1);
  assert.equal(created, false);
});

test("runCli aborts a one-shot session when its signal fires", async () => {
  const { authStorage, modelRegistry } = createRegistry(true);
  const controller = new AbortController();
  let aborted = false;
  let rejectPrompt: ((error: Error) => void) | undefined;
  const stderr: string[] = [];
  const result = runCli(["task"], {
    stdout: () => undefined,
    stderr: (text) => stderr.push(text),
  }, {
    cwd: process.cwd(),
    interactiveTerminal: false,
    authStorage,
    modelRegistry,
    createSession: async () => ({
      session: {
        subscribe: () => () => undefined,
        prompt: () => new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
        getSessionStats: () => ({
          sessionFile: undefined,
          sessionId: "abort-session",
          userMessages: 1,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 1,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        }),
        abort: async () => {
          aborted = true;
          rejectPrompt?.(new Error("aborted by test"));
        },
        dispose: () => undefined,
      },
    }),
    runInteractive: async () => undefined,
    getGitStatus: async () => ({ available: false, status: "" }),
  }, { signal: controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error("evaluation timeout"));
  assert.equal(await result, 1);
  assert.equal(aborted, true);
  assert.match(stderr.join(""), /aborted by test/);
});

test("runCli enters interactive mode only when no task and a TTY are available", async () => {
  const { authStorage, modelRegistry } = createRegistry(true);
  let started = false;
  const dependencies: CliDependencies = {
    cwd: process.cwd(),
    interactiveTerminal: true,
    authStorage,
    modelRegistry,
    createSession: async () => {
      throw new Error("one-shot session should not be created");
    },
    runInteractive: async ({ model, approvalMode, agentMode }) => {
      started = true;
      assert.equal(model.id, "deepseek-v4-flash");
      assert.equal(approvalMode, "ask");
      assert.equal(agentMode, "build");
    },
    getGitStatus: async () => ({ available: false, status: "" }),
  };

  assert.equal(await runCli([], { stdout: () => undefined, stderr: () => undefined }, dependencies), 0);
  assert.equal(started, true);

  dependencies.interactiveTerminal = false;
  const stderr: string[] = [];
  assert.equal(await runCli([], { stdout: () => undefined, stderr: (text) => stderr.push(text) }, dependencies), 1);
  assert.match(stderr.join(""), /outside an interactive terminal/);
});
