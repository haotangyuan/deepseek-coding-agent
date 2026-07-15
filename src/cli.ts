import type { AgentSessionEvent, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { SessionSelection } from "./sessions.ts";
import { APPROVAL_MODES, type ApprovalMode } from "./tool-policy.ts";
import { describeDeepSeekError } from "./deepseek-errors.ts";

export const DEFAULT_MODEL_ID = "deepseek-v4-flash";
export const DEEPSEEK_PROVIDER = "deepseek";
export const THINKING_LEVELS = ["off", "high", "max"] as const;
export type DeepSeekThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface CliOptions {
  help: boolean;
  modelId: string;
  modelExplicit: boolean;
  thinkingLevel: DeepSeekThinkingLevel;
  thinkingExplicit: boolean;
  approvalMode: ApprovalMode;
  session: SessionSelection;
  metrics: boolean;
  task: string;
}

export interface OutputRecord {
  channel: "stdout" | "stderr";
  text: string;
}

type SelectedModel = NonNullable<CreateAgentSessionOptions["model"]>;

export interface ModelRegistryView {
  find(provider: string, modelId: string): SelectedModel | undefined;
  hasConfiguredAuth(model: SelectedModel): boolean;
}

function readOptionValue(args: string[], index: number, option: string): { value: string; nextIndex: number } {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

export function parseCliArgs(args: string[]): CliOptions {
  let help = false;
  let model = DEFAULT_MODEL_ID;
  let modelExplicit = false;
  let thinkingLevel: DeepSeekThinkingLevel = "high";
  let thinkingExplicit = false;
  let approvalMode: ApprovalMode = "ask";
  let session: SessionSelection = { type: "new" };
  let metrics = false;
  const taskParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--model") {
      const parsed = readOptionValue(args, index, "--model");
      model = parsed.value;
      modelExplicit = true;
      index = parsed.nextIndex;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      modelExplicit = true;
      if (!model) throw new Error("--model requires a value");
    } else if (arg === "--thinking") {
      const parsed = readOptionValue(args, index, "--thinking");
      if (!THINKING_LEVELS.includes(parsed.value as DeepSeekThinkingLevel)) {
        throw new Error(`Invalid thinking level: ${parsed.value}`);
      }
      thinkingLevel = parsed.value as DeepSeekThinkingLevel;
      thinkingExplicit = true;
      index = parsed.nextIndex;
    } else if (arg.startsWith("--thinking=")) {
      const value = arg.slice("--thinking=".length);
      if (!THINKING_LEVELS.includes(value as DeepSeekThinkingLevel)) {
        throw new Error(`Invalid thinking level: ${value || "(empty)"}`);
      }
      thinkingLevel = value as DeepSeekThinkingLevel;
      thinkingExplicit = true;
    } else if (arg === "--approval") {
      const parsed = readOptionValue(args, index, "--approval");
      if (!APPROVAL_MODES.includes(parsed.value as ApprovalMode)) {
        throw new Error(`Invalid approval mode: ${parsed.value}`);
      }
      approvalMode = parsed.value as ApprovalMode;
      index = parsed.nextIndex;
    } else if (arg.startsWith("--approval=")) {
      const value = arg.slice("--approval=".length);
      if (!APPROVAL_MODES.includes(value as ApprovalMode)) {
        throw new Error(`Invalid approval mode: ${value || "(empty)"}`);
      }
      approvalMode = value as ApprovalMode;
    } else if (arg === "--continue" || arg === "-c") {
      if (session.type !== "new") throw new Error("Only one session selection option is allowed");
      session = { type: "continue" };
    } else if (arg === "--ephemeral") {
      if (session.type !== "new") throw new Error("Only one session selection option is allowed");
      session = { type: "memory" };
    } else if (arg === "--metrics") {
      metrics = true;
    } else if (arg === "--resume" || arg === "-r") {
      if (session.type !== "new") throw new Error("Only one session selection option is allowed");
      const parsed = readOptionValue(args, index, arg);
      session = { type: "resume", target: parsed.value };
      index = parsed.nextIndex;
    } else if (arg.startsWith("--resume=")) {
      if (session.type !== "new") throw new Error("Only one session selection option is allowed");
      const target = arg.slice("--resume=".length);
      if (!target) throw new Error("--resume requires a value");
      session = { type: "resume", target };
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      taskParts.push(arg);
    }
  }

  const providerSeparator = model.indexOf("/");
  if (providerSeparator !== -1) {
    const provider = model.slice(0, providerSeparator);
    if (provider !== DEEPSEEK_PROVIDER) {
      throw new Error(`Only the ${DEEPSEEK_PROVIDER} provider is allowed`);
    }
    model = model.slice(providerSeparator + 1);
  }
  if (!model) throw new Error("Model ID cannot be empty");

  return {
    help,
    modelId: model,
    modelExplicit,
    thinkingLevel,
    thinkingExplicit,
    approvalMode,
    session,
    metrics,
    task: taskParts.join(" ").trim(),
  };
}

export function resolveDeepSeekModel(registry: ModelRegistryView, modelId: string): SelectedModel {
  const model = registry.find(DEEPSEEK_PROVIDER, modelId);
  if (!model) {
    throw new Error(`Unknown DeepSeek model: ${modelId}`);
  }
  if (model.provider !== DEEPSEEK_PROVIDER) {
    throw new Error(`Only the ${DEEPSEEK_PROVIDER} provider is allowed`);
  }
  if (!registry.hasConfiguredAuth(model)) {
    throw new Error("DEEPSEEK_API_KEY is not configured");
  }
  return model;
}

function stringify(value: unknown): string {
  try {
    const serialized = sanitizeError(JSON.stringify(value));
    return serialized.length <= 4000 ? serialized : `${serialized.slice(0, 4000)}...[truncated]`;
  } catch {
    return "[unserializable]";
  }
}

export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]");
}

export function formatDeepSeekError(error: unknown, retryableOverride?: boolean): string {
  return describeDeepSeekError(error, sanitizeError, retryableOverride);
}

export function formatAgentEvent(event: AgentSessionEvent): OutputRecord[] {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") {
      return [{ channel: "stdout", text: update.delta }];
    }
    if (update.type === "thinking_delta") {
      return [{ channel: "stderr", text: `[reasoning:delta] ${update.delta}\n` }];
    }
    if (update.type === "toolcall_start") {
      return [{ channel: "stderr", text: "[tool-call:start]\n" }];
    }
    if (update.type === "toolcall_delta") {
      return [{ channel: "stderr", text: `[tool-call:arguments-delta] ${update.delta}\n` }];
    }
    if (update.type === "toolcall_end") {
      return [
        {
          channel: "stderr",
          text: `[tool-call:parsed] ${update.toolCall.name} ${stringify(update.toolCall.arguments)}\n`,
        },
      ];
    }
    return [];
  }

  if (event.type === "tool_execution_start") {
    return [
      {
        channel: "stderr",
        text: `[tool:start] ${event.toolName} ${stringify(event.args)}\n`,
      },
    ];
  }
  if (event.type === "tool_execution_update") {
    return [
      {
        channel: "stderr",
        text: `[tool:update] ${event.toolName} ${stringify(event.partialResult)}\n`,
      },
    ];
  }
  if (event.type === "tool_execution_end") {
    return [
      {
        channel: "stderr",
        text: `[tool:${event.isError ? "error" : "result"}] ${event.toolName} ${stringify(event.result)}\n`,
      },
    ];
  }
  if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
    return [
      {
        channel: "stderr",
        text: `[provider:error] ${formatDeepSeekError(event.message.errorMessage ?? "Unknown error")}\n`,
      },
    ];
  }
  if (event.type === "auto_retry_start") {
    return [
      {
        channel: "stderr",
        text: `[provider:retry] attempt=${event.attempt}/${event.maxAttempts} delayMs=${event.delayMs} ${formatDeepSeekError(event.errorMessage, true)}\n`,
      },
    ];
  }
  if (event.type === "auto_retry_end" && !event.success) {
    return [
      {
        channel: "stderr",
        text: `[provider:retry-failed] ${formatDeepSeekError(event.finalError ?? "Unknown error")}\n`,
      },
    ];
  }
  if (event.type === "agent_settled") {
    return [{ channel: "stderr", text: "[agent:complete]\n" }];
  }
  return [];
}

export function usage(): string {
  return [
    "Usage: deepseek-code [--model MODEL] [--thinking LEVEL] [--approval MODE] [--continue | --resume ID_OR_PATH | --ephemeral] [--metrics] [\"task\"]",
    "",
    `Default model: ${DEFAULT_MODEL_ID}`,
    `Allowed provider: ${DEEPSEEK_PROVIDER}`,
    "Thinking levels: off, high (default), max",
    "Approval modes: ask (default), auto-read, deny",
    "Session options: --continue/-c resumes latest; --resume/-r selects history; --ephemeral disables persistence",
    "Metrics: --metrics emits one redacted JSON summary to stderr",
  ].join("\n");
}
