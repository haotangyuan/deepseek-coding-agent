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
    approvalMode: "ask",
    session: { type: "new" },
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
});

test("parses explicit approval modes", () => {
  assert.equal(parseCliArgs(["--approval", "auto-read", "task"]).approvalMode, "auto-read");
  assert.equal(parseCliArgs(["--approval=deny", "task"]).approvalMode, "deny");
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
  assert.equal(formatAgentEvent(providerError)[0]?.text, "[provider:error] request failed with [REDACTED]\n");
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
  let prompt = "";
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
      return {
        session: {
          subscribe: (nextListener) => {
            listener = nextListener;
            return () => undefined;
          },
          prompt: async (text) => {
            prompt = text;
            listener?.({
              type: "tool_execution_end",
              toolCallId: "1",
              toolName: "bash",
              result: { content: [] },
              isError: false,
            });
            listener?.({ type: "agent_settled" });
          },
          dispose: () => undefined,
        },
      };
    },
    runInteractive: async () => undefined,
    getGitStatus: async () => ({ available: true, status: " M README.md" }),
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(["--model", "deepseek-v4-flash", "say", "ok"], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  }, dependencies);

  assert.equal(code, 0);
  assert.equal(selectedModel?.provider, "deepseek");
  assert.equal(selectedModel?.id, "deepseek-v4-flash");
  assert.deepEqual(selectedTools, ["read", "write", "edit", "bash"]);
  assert.equal(selectedSession, "new");
  assert.equal(restoreSavedModel, false);
  assert.equal(prompt, "say ok");
  assert.equal(stdout.join(""), "");
  assert.match(stderr.join(""), /agent:complete/);
  assert.match(stderr.join(""), /git:status.*README\.md/s);
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
    runInteractive: async ({ model, approvalMode }) => {
      started = true;
      assert.equal(model.id, "deepseek-v4-flash");
      assert.equal(approvalMode, "ask");
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
