import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { formatAgentEvent, parseCliArgs, resolveDeepSeekModel, sanitizeError } from "../src/cli.ts";
import { type CliDependencies, runCli } from "../src/main.ts";

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
    task: "summarize this repo",
  });
});

test("accepts an explicit DeepSeek model and rejects other providers", () => {
  assert.equal(parseCliArgs(["--model", "deepseek/deepseek-v4-flash", "task"]).modelId, "deepseek-v4-flash");
  assert.throws(() => parseCliArgs(["--model", "openai/gpt-5", "task"]), /Only the deepseek provider/);
});

test("rejects unknown options and missing model values", () => {
  assert.throws(() => parseCliArgs(["--unknown"]), /Unknown option/);
  assert.throws(() => parseCliArgs(["--model"]), /requires a value/);
});

test("resolves only an existing and authenticated DeepSeek model", () => {
  const available = createRegistry(true).modelRegistry;
  assert.equal(resolveDeepSeekModel(available, "deepseek-v4-flash").provider, "deepseek");
  assert.throws(() => resolveDeepSeekModel(available, "missing"), /Unknown DeepSeek model/);

  const unavailable = createRegistry(false).modelRegistry;
  assert.throws(() => resolveDeepSeekModel(unavailable, "deepseek-v4-flash"), /DEEPSEEK_API_KEY/);
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
  let prompt = "";
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const dependencies: CliDependencies = {
    authStorage,
    modelRegistry,
    createSession: async (options) => {
      selectedModel = options.model;
      return {
        session: {
          subscribe: (nextListener) => {
            listener = nextListener;
            return () => undefined;
          },
          prompt: async (text) => {
            prompt = text;
            listener?.({ type: "agent_settled" });
          },
          dispose: () => undefined,
        },
      };
    },
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
  assert.equal(prompt, "say ok");
  assert.equal(stdout.join(""), "");
  assert.match(stderr.join(""), /agent:complete/);
});

test("runCli fails before session creation when credentials are missing", async () => {
  const { authStorage, modelRegistry } = createRegistry(false);
  let created = false;
  const code = await runCli(["task"], { stdout: () => undefined, stderr: () => undefined }, {
    authStorage,
    modelRegistry,
    createSession: async () => {
      created = true;
      throw new Error("must not run");
    },
  });
  assert.equal(code, 1);
  assert.equal(created, false);
});
