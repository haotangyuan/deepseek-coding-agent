import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import { classifyDeepSeekError, type DeepSeekErrorCategory } from "./deepseek-errors.ts";

export interface EvaluationMetrics {
  schemaVersion: 1;
  model: string;
  thinking: string;
  success: boolean;
  durationMs: number;
  firstResponseMs?: number;
  firstTextMs?: number;
  textChars: number;
  reasoningChars: number;
  toolCalls: number;
  toolSuccesses: number;
  toolErrors: number;
  retries: number;
  providerErrors: number;
  providerErrorCategories: DeepSeekErrorCategory[];
  eventSequence: string[];
  tokens: SessionStats["tokens"];
  cacheHitRate: number;
  costUsd: number;
}

export class EvaluationMetricsCollector {
  private readonly model: string;
  private readonly thinking: string;
  private readonly now: () => number;
  private readonly startedAt: number;
  private firstResponseAt?: number;
  private firstTextAt?: number;
  private textChars = 0;
  private reasoningChars = 0;
  private toolCalls = 0;
  private toolSuccesses = 0;
  private toolErrors = 0;
  private retries = 0;
  private providerErrors = 0;
  private readonly providerErrorCategories = new Set<DeepSeekErrorCategory>();
  private readonly eventSequence: string[] = [];

  constructor(
    model: string,
    thinking: string,
    now: () => number = Date.now,
  ) {
    this.model = model;
    this.thinking = thinking;
    this.now = now;
    this.startedAt = now();
  }

  observe(event: AgentSessionEvent): void {
    const timestamp = this.now();
    this.recordEvent(event);
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        this.markResponse(timestamp);
        this.firstTextAt ??= timestamp;
        this.textChars += update.delta.length;
      } else if (update.type === "thinking_delta") {
        this.markResponse(timestamp);
        this.reasoningChars += update.delta.length;
      } else if (update.type === "toolcall_start") {
        this.markResponse(timestamp);
      }
    } else if (event.type === "tool_execution_start") {
      this.markResponse(timestamp);
      this.toolCalls += 1;
    } else if (event.type === "tool_execution_end") {
      if (event.isError) this.toolErrors += 1;
      else this.toolSuccesses += 1;
    } else if (event.type === "auto_retry_start") {
      this.retries += 1;
    } else if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "error"
    ) {
      this.providerErrors += 1;
      this.providerErrorCategories.add(classifyDeepSeekError(event.message.errorMessage ?? "Unknown error").category);
    }
  }

  finish(stats: SessionStats, success: boolean): EvaluationMetrics {
    const promptTokens = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite;
    return {
      schemaVersion: 1,
      model: this.model,
      thinking: this.thinking,
      success: success && this.providerErrors === 0,
      durationMs: Math.max(0, this.now() - this.startedAt),
      ...(this.firstResponseAt === undefined ? {} : { firstResponseMs: this.firstResponseAt - this.startedAt }),
      ...(this.firstTextAt === undefined ? {} : { firstTextMs: this.firstTextAt - this.startedAt }),
      textChars: this.textChars,
      reasoningChars: this.reasoningChars,
      toolCalls: this.toolCalls,
      toolSuccesses: this.toolSuccesses,
      toolErrors: this.toolErrors,
      retries: this.retries,
      providerErrors: this.providerErrors,
      providerErrorCategories: [...this.providerErrorCategories],
      eventSequence: [...this.eventSequence],
      tokens: stats.tokens,
      cacheHitRate: promptTokens === 0 ? 0 : stats.tokens.cacheRead / promptTokens,
      costUsd: stats.cost,
    };
  }

  private markResponse(timestamp: number): void {
    this.firstResponseAt ??= timestamp;
  }

  private recordEvent(event: AgentSessionEvent): void {
    let label: string = event.type;
    if (event.type === "message_update") label = event.assistantMessageEvent.type;
    if (event.type === "tool_execution_end") label = event.isError ? "tool_execution_error" : "tool_execution_end";
    if (this.eventSequence.at(-1) !== label && this.eventSequence.length < 64) {
      this.eventSequence.push(label);
    }
  }
}
