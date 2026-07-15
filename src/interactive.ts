import {
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ModelRegistry,
  type SessionStats,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Editor,
  type EditorTheme,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  ProcessTerminal,
  type Terminal,
  Text,
  TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { relative } from "node:path";
import { DEEPSEEK_PROVIDER, resolveDeepSeekModel, sanitizeError } from "./cli.ts";
import type { ContextResourceItem, ContextSnapshot } from "./context-resources.ts";
import type { ApprovalMode, ApprovalRequest } from "./tool-policy.ts";

type SelectedModel = NonNullable<CreateAgentSessionOptions["model"]>;
type ThinkingLevel = AgentSession["thinkingLevel"];

export interface InteractiveSession {
  readonly isStreaming: boolean;
  readonly model: SelectedModel | undefined;
  readonly thinkingLevel: ThinkingLevel;
  readonly systemPrompt: string;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  setModel(model: SelectedModel): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  getAvailableThinkingLevels(): ThinkingLevel[];
  getActiveToolNames(): string[];
  getSessionStats(): SessionStats;
  reload(): Promise<void>;
  dispose(): void;
}

export interface InteractiveModeOptions {
  session: InteractiveSession;
  modelRegistry: ModelRegistry;
  cwd: string;
  approvalMode: ApprovalMode;
  terminal?: Terminal;
  clearContext(): void;
  getContextSnapshot(): ContextSnapshot;
  setProjectResourcesEnabled(enabled: boolean): Promise<void>;
  getGitStatus(cwd: string): Promise<{ available: boolean; status: string }>;
}

export type InteractiveCommand =
  | { name: "help" | "status" | "clear" | "exit" | "reasoning" | "context" | "agents" | "skills" | "prompts"; argument: string }
  | { name: "model" | "thinking"; argument: string }
  | { name: "resources"; argument: string }
  | { name: "unknown"; argument: string };

const RESET = "\x1b[0m";
const colors = {
  accent: (text: string) => `\x1b[36m${text}${RESET}`,
  dim: (text: string) => `\x1b[2m${text}${RESET}`,
  error: (text: string) => `\x1b[31m${text}${RESET}`,
  success: (text: string) => `\x1b[32m${text}${RESET}`,
  warning: (text: string) => `\x1b[33m${text}${RESET}`,
  bold: (text: string) => `\x1b[1m${text}${RESET}`,
  ocean: (text: string) => `\x1b[38;2;74;128;255m${text}${RESET}`,
  ice: (text: string) => `\x1b[38;2;92;224;255m${text}${RESET}`,
};

const editorTheme: EditorTheme = {
  borderColor: colors.accent,
  selectList: {
    selectedPrefix: colors.accent,
    selectedText: colors.accent,
    description: colors.dim,
    scrollInfo: colors.dim,
    noMatch: colors.warning,
  },
};

const markdownTheme: MarkdownTheme = {
  heading: colors.bold,
  link: colors.accent,
  linkUrl: colors.dim,
  code: colors.warning,
  codeBlock: (text) => text,
  codeBlockBorder: colors.dim,
  quote: (text) => text,
  quoteBorder: colors.dim,
  hr: colors.dim,
  listBullet: colors.accent,
  bold: colors.bold,
  italic: (text) => `\x1b[3m${text}${RESET}`,
  strikethrough: (text) => `\x1b[9m${text}${RESET}`,
  underline: (text) => `\x1b[4m${text}${RESET}`,
};

function safeJson(value: unknown): string {
  try {
    const json = sanitizeError(JSON.stringify(value));
    return json.length <= 1200 ? json : `${json.slice(0, 1200)}...[truncated]`;
  } catch {
    return "[unserializable]";
  }
}

function displayPath(path: string, cwd: string): string {
  const fromCwd = relative(cwd, path);
  if (fromCwd === "") return ".";
  if (!fromCwd.startsWith("..")) return fromCwd;
  const home = process.env.HOME;
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

function formatResourceItems(items: ContextResourceItem[], cwd: string, limit = 20): string {
  if (items.length === 0) return "  none";
  const visible = items.slice(0, limit).map((item, index) => {
    const details = [item.scope, item.characters === undefined ? undefined : `${item.characters} chars`]
      .filter((value) => value !== undefined)
      .join(" · ");
    const invocation = item.modelInvocable === undefined ? "" : item.modelInvocable ? " · model-visible" : " · explicit-only";
    const description = item.description ? `\n     ${item.description}` : "";
    return `  ${index + 1}. ${item.name} [${details}${invocation}]\n     ${displayPath(item.path, cwd)}${description}`;
  });
  if (items.length > limit) visible.push(`  ... ${items.length - limit} more`);
  return visible.join("\n");
}

function toolResultSummary(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): string {
  const content = event.result.content
    .filter((item: { type: string }) => item.type === "text")
    .map((item: { text?: string }) => item.text ?? "")
    .join(" ");
  const safe = sanitizeError(content).replace(/\s+/g, " ").trim();
  return safe.length <= 240 ? safe : `${safe.slice(0, 240)}...[truncated]`;
}

export function parseInteractiveCommand(input: string): InteractiveCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const separator = trimmed.indexOf(" ");
  const name = trimmed.slice(1, separator === -1 ? undefined : separator).toLowerCase();
  const argument = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  if (["help", "status", "clear", "exit", "reasoning", "context", "agents", "skills", "prompts"].includes(name)) {
    return {
      name: name as "help" | "status" | "clear" | "exit" | "reasoning" | "context" | "agents" | "skills" | "prompts",
      argument,
    };
  }
  if (name === "model" || name === "thinking") return { name, argument };
  if (name === "resources") return { name, argument };
  return { name: "unknown", argument: name };
}

class StatusLine implements Component {
  private text: string;

  constructor(text: string) {
    this.text = text;
  }

  setText(text: string): void {
    this.text = text;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [colors.dim(truncateToWidth(this.text, Math.max(1, width)))];
  }
}

class InteractiveEditor extends Container {
  private _focused = false;
  private readonly editor: Editor;
  private readonly onCtrlC: () => void;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  constructor(tui: TUI, onSubmit: (text: string) => void, onCtrlC: () => void) {
    super();
    this.onCtrlC = onCtrlC;
    this.editor = new Editor(tui, editorTheme, { paddingX: 1 });
    this.editor.onSubmit = onSubmit;
    this.addChild(this.editor);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.onCtrlC();
      return;
    }
    this.editor.handleInput(data);
  }

  clearInput(): void {
    this.editor.addToHistory(this.editor.getExpandedText());
    this.editor.setText("");
  }
}

export class InteractiveMode {
  private readonly options: InteractiveModeOptions;
  private readonly session: InteractiveSession;
  private readonly tui: TUI;
  private readonly transcript = new Container();
  private readonly header: Text;
  private readonly subheader: Text;
  private readonly status: StatusLine;
  private readonly editor: InteractiveEditor;
  private readonly toolLines = new Map<string, Text>();
  private assistantText = "";
  private assistantComponent: Markdown | undefined;
  private readonly reasoningBlocks: Array<{ component: Text; text: string }> = [];
  private currentReasoning: { component: Text; text: string } | undefined;
  private showReasoning = false;
  private pendingApproval:
    | { request: ApprovalRequest; resolve: (approved: boolean) => void; line: Text }
    | undefined;
  private exitResolve: (() => void) | undefined;
  private exiting = false;
  private lastIdleCtrlC = 0;
  private mutatingToolSucceeded = false;
  private unsubscribe: (() => void) | undefined;

  constructor(options: InteractiveModeOptions) {
    this.options = options;
    this.session = options.session;
    this.tui = new TUI(options.terminal ?? new ProcessTerminal());
    this.status = new StatusLine("");
    this.editor = new InteractiveEditor(this.tui, (text) => void this.handleSubmit(text), () => void this.handleCtrlC());
    this.header = new Text("", 1, 0);
    this.subheader = new Text("", 1, 0);

    this.tui.addChild(this.header);
    this.tui.addChild(this.subheader);
    this.tui.addChild(new Text(colors.dim("Enter submit · Shift+Enter newline · Ctrl+C cancel/exit · /help commands"), 1, 0));
    this.tui.addChild(this.transcript);
    this.tui.addChild(this.status);
    this.tui.addChild(this.editor);
    this.tui.setFocus(this.editor);
    this.updateStatus("idle");
  }

  async run(): Promise<void> {
    this.unsubscribe = this.session.subscribe((event) => this.handleEvent(event));
    this.addSystem(`workspace ${this.options.cwd}`);
    this.addSystem(`approval ${this.options.approvalMode}`);
    this.addSystem("project context and tool approval are independent boundaries");
    this.tui.start();
    try {
      await new Promise<void>((resolve) => {
        this.exitResolve = resolve;
      });
    } finally {
      this.unsubscribe?.();
      this.pendingApproval?.resolve(false);
      this.pendingApproval = undefined;
      this.tui.stop();
    }
  }

  requestApproval(request: ApprovalRequest): Promise<boolean> {
    if (this.exiting || this.pendingApproval) return Promise.resolve(false);
    const line = new Text(
      `${colors.warning("[approval]")} ${request.summary}\n${sanitizeError(request.preview)}\nType y and Enter to approve; anything else rejects.`,
      1,
      0,
    );
    this.transcript.addChild(line);
    this.updateStatus("waiting approval");
    this.tui.requestRender();
    return new Promise<boolean>((resolve) => {
      this.pendingApproval = { request, resolve, line };
    });
  }

  private addSystem(text: string): void {
    this.transcript.addChild(new Text(colors.dim(`[system] ${sanitizeError(text)}`), 1, 0));
  }

  private addError(text: string): void {
    this.transcript.addChild(new Text(colors.error(`[error] ${sanitizeError(text)}`), 1, 0));
    this.updateStatus("error");
    this.tui.requestRender();
  }

  private updateStatus(state: string): void {
    const stats = this.session.getSessionStats();
    const model = this.session.model?.id ?? "none";
    const cwd = relative(process.cwd(), this.options.cwd) || ".";
    this.status.setText(
      `${state} | ${DEEPSEEK_PROVIDER}/${model} | thinking=${this.session.thinkingLevel} | tokens=${stats.tokens.total} | cwd=${cwd}`,
    );
    const context = this.options.getContextSnapshot();
    const modelLabel = model.replace(/^deepseek-v4-/, "V4 ").toUpperCase();
    this.header.setText(`${colors.ocean("◆")} ${colors.ice(colors.bold("DEEPSEEK CODE"))}`);
    this.subheader.setText(
      colors.dim(
        `${modelLabel} · THINKING ${this.session.thinkingLevel.toUpperCase()} · ${this.options.approvalMode.toUpperCase()} · PROJECT CONTEXT ${context.projectResourcesEnabled ? "ON" : "OFF"}`,
      ),
    );
    this.tui.requestRender();
  }

  private async handleSubmit(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text) return;
    this.editor.clearInput();

    if (this.pendingApproval) {
      const approval = this.pendingApproval;
      this.pendingApproval = undefined;
      const approved = /^(?:y|yes)$/i.test(text);
      approval.line.setText(
        `${approved ? colors.success("[approval:approved]") : colors.error("[approval:rejected]")} ${approval.request.summary}`,
      );
      approval.resolve(approved);
      this.updateStatus(this.session.isStreaming ? "running" : "idle");
      return;
    }

    const command = parseInteractiveCommand(text);
    if (command && !(command.name === "unknown" && this.isResourceInvocation(text))) {
      await this.handleCommand(command);
      return;
    }

    this.transcript.addChild(new Text(`${colors.accent("you")}  ${sanitizeError(text)}`, 1, 0));
    this.resetTurnComponents();
    this.updateStatus(this.session.isStreaming ? "queued steering" : "running");
    this.tui.requestRender();
    try {
      if (this.session.isStreaming) {
        await this.session.steer(text);
        this.addSystem("message queued as steering input");
      } else {
        void this.session.prompt(text).catch((error) => this.addError(error instanceof Error ? error.message : String(error)));
      }
    } catch (error) {
      this.addError(error instanceof Error ? error.message : String(error));
    }
  }

  private isResourceInvocation(text: string): boolean {
    const invocation = text.slice(1).split(/\s+/, 1)[0] ?? "";
    const snapshot = this.options.getContextSnapshot();
    if (invocation.startsWith("skill:")) {
      const skillName = invocation.slice("skill:".length);
      return snapshot.skills.some((skill) => skill.name === skillName);
    }
    return snapshot.prompts.some((prompt) => prompt.name === invocation);
  }

  private async handleCommand(command: InteractiveCommand): Promise<void> {
    if (command.name === "help") {
      this.addSystem(
        "/help /status /context /agents /skills /prompts /resources [on|off] /model [id] /thinking [level] /reasoning /clear /exit",
      );
    } else if (command.name === "status") {
      const stats = this.session.getSessionStats();
      const context = this.options.getContextSnapshot();
      this.addSystem(
        `model=${this.session.model?.id ?? "none"} thinking=${this.session.thinkingLevel} approval=${this.options.approvalMode} project-context=${context.projectResourcesEnabled ? "on" : "off"} messages=${stats.totalMessages} tokens=${stats.tokens.total}`,
      );
    } else if (command.name === "context") {
      this.showContextSummary();
    } else if (command.name === "agents") {
      const snapshot = this.options.getContextSnapshot();
      this.addSystem(`AGENTS load order (first → last)\n${formatResourceItems(snapshot.agentsFiles, this.options.cwd)}`);
    } else if (command.name === "skills") {
      const snapshot = this.options.getContextSnapshot();
      this.addSystem(`Skills (${snapshot.skills.length})\n${formatResourceItems(snapshot.skills, this.options.cwd)}`);
    } else if (command.name === "prompts") {
      const snapshot = this.options.getContextSnapshot();
      this.addSystem(`Prompt templates (${snapshot.prompts.length})\n${formatResourceItems(snapshot.prompts, this.options.cwd)}`);
    } else if (command.name === "resources") {
      await this.handleResourcesCommand(command.argument);
    } else if (command.name === "reasoning") {
      this.showReasoning = !this.showReasoning;
      this.refreshReasoning();
      this.addSystem(`reasoning display ${this.showReasoning ? "expanded" : "collapsed"}`);
    } else if (command.name === "clear") {
      if (this.session.isStreaming) {
        this.addError("cancel the active run before clearing context");
      } else {
        this.options.clearContext();
        this.transcript.clear();
        this.toolLines.clear();
        this.reasoningBlocks.length = 0;
        this.resetTurnComponents();
        this.addSystem("conversation context cleared");
      }
    } else if (command.name === "exit") {
      await this.exit();
    } else if (command.name === "model") {
      await this.handleModelCommand(command.argument);
    } else if (command.name === "thinking") {
      this.handleThinkingCommand(command.argument);
    } else {
      this.addError(`unknown command: /${command.argument}`);
    }
    this.updateStatus(this.session.isStreaming ? "running" : "idle");
    this.tui.requestRender();
  }

  private showContextSummary(): void {
    const snapshot = this.options.getContextSnapshot();
    const agentCharacters = snapshot.agentsFiles.reduce((total, file) => total + (file.characters ?? 0), 0);
    const modelSkills = snapshot.skills.filter((skill) => skill.modelInvocable).length;
    const diagnosticSummary = snapshot.diagnostics.length === 0
      ? "none"
      : `${snapshot.diagnostics.length} (${snapshot.diagnostics.slice(0, 3).map((diagnostic) => diagnostic.type).join(", ")})`;
    this.addSystem(
      [
        "CONTEXT MAP",
        `  effective system prompt  ${snapshot.systemPromptCharacters} chars · ~${snapshot.estimatedSystemPromptTokens} tokens`,
        `  active tools             ${snapshot.activeTools.join(", ") || "none"}`,
        `  AGENTS                   ${snapshot.agentsFiles.length} files · ${agentCharacters} chars`,
        `  Skills                   ${snapshot.skills.length} discovered · ${modelSkills} model-visible`,
        `  Prompt templates         ${snapshot.prompts.length} discoverable`,
        `  Diagnostics              ${diagnosticSummary}`,
        `  Project resources        ${snapshot.projectResourcesEnabled ? "enabled" : "disabled"}`,
        `  Tool approval            ${this.options.approvalMode} (independent from context trust)`,
      ].join("\n"),
    );
  }

  private async handleResourcesCommand(argument: string): Promise<void> {
    const current = this.options.getContextSnapshot().projectResourcesEnabled;
    if (!argument) {
      this.addSystem(`project resources ${current ? "enabled" : "disabled"}; use /resources on or /resources off`);
      return;
    }
    if (argument !== "on" && argument !== "off") {
      this.addError("usage: /resources [on|off]");
      return;
    }
    if (this.session.isStreaming) {
      this.addError("project resources cannot be reloaded during an active run");
      return;
    }
    const enabled = argument === "on";
    if (enabled === current) {
      this.addSystem(`project resources already ${enabled ? "enabled" : "disabled"}`);
      return;
    }
    this.updateStatus("reloading context");
    try {
      await this.options.setProjectResourcesEnabled(enabled);
      const snapshot = this.options.getContextSnapshot();
      this.addSystem(
        `project resources ${enabled ? "enabled" : "disabled"}; loaded AGENTS=${snapshot.agentsFiles.length} Skills=${snapshot.skills.length} Prompts=${snapshot.prompts.length}`,
      );
    } catch (error) {
      this.addError(`context reload failed: ${sanitizeError(error)}`);
    }
  }

  private async handleModelCommand(modelId: string): Promise<void> {
    if (!modelId) {
      const models = this.options.modelRegistry
        .getAvailable()
        .filter((model) => model.provider === DEEPSEEK_PROVIDER)
        .map((model) => model.id)
        .join(", ");
      this.addSystem(`available DeepSeek models: ${models || "none"}`);
      return;
    }
    if (this.session.isStreaming) {
      this.addError("model cannot be changed during an active run");
      return;
    }
    try {
      const model = resolveDeepSeekModel(this.options.modelRegistry, modelId.replace(/^deepseek\//, ""));
      await this.session.setModel(model);
      this.addSystem(`model changed to ${DEEPSEEK_PROVIDER}/${model.id}`);
    } catch (error) {
      this.addError(error instanceof Error ? error.message : String(error));
    }
  }

  private handleThinkingCommand(level: string): void {
    const available = this.session.getAvailableThinkingLevels();
    if (!level) {
      this.addSystem(`thinking=${this.session.thinkingLevel}; available: ${available.join(", ")}`);
      return;
    }
    if (!available.includes(level as ThinkingLevel)) {
      this.addError(`invalid thinking level: ${level}; available: ${available.join(", ")}`);
      return;
    }
    this.session.setThinkingLevel(level as ThinkingLevel);
    this.addSystem(`thinking changed to ${this.session.thinkingLevel}`);
  }

  private async handleCtrlC(): Promise<void> {
    if (this.pendingApproval) {
      const approval = this.pendingApproval;
      this.pendingApproval = undefined;
      approval.line.setText(`${colors.error("[approval:rejected]")} ${approval.request.summary}`);
      approval.resolve(false);
      this.updateStatus("running");
      return;
    }
    if (this.session.isStreaming) {
      this.updateStatus("cancelling");
      try {
        await this.session.abort();
        this.addSystem("current run cancelled");
        this.updateStatus("idle");
      } catch (error) {
        this.addError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const now = Date.now();
    if (now - this.lastIdleCtrlC <= 1500) {
      await this.exit();
      return;
    }
    this.lastIdleCtrlC = now;
    this.addSystem("press Ctrl+C again within 1.5s to exit");
    this.tui.requestRender();
  }

  private handleEvent(event: AgentSessionEvent): void {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "thinking_delta") {
        if (!this.currentReasoning) {
          const block = { component: new Text("", 1, 0), text: "" };
          this.currentReasoning = block;
          this.reasoningBlocks.push(block);
          this.transcript.addChild(block.component);
        }
        this.currentReasoning.text += sanitizeError(update.delta);
        this.refreshReasoning();
      } else if (update.type === "text_delta") {
        this.assistantText += sanitizeError(update.delta);
        if (!this.assistantComponent) {
          this.assistantComponent = new Markdown("", 1, 0, markdownTheme);
          this.transcript.addChild(new Text(colors.success("assistant"), 1, 0));
          this.transcript.addChild(this.assistantComponent);
        }
        this.assistantComponent.setText(this.assistantText);
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      if (event.message.stopReason === "error") this.addError(event.message.errorMessage ?? "provider error");
      this.assistantComponent = undefined;
      this.assistantText = "";
      this.currentReasoning = undefined;
    } else if (event.type === "tool_execution_start") {
      const line = new Text(
        `${colors.warning(`[tool:${event.toolName}]`)} running ${safeJson(event.args)}`,
        1,
        0,
      );
      this.toolLines.set(event.toolCallId, line);
      this.transcript.addChild(line);
      this.updateStatus(`tool ${event.toolName}`);
    } else if (event.type === "tool_execution_update") {
      this.toolLines.get(event.toolCallId)?.setText(
        `${colors.warning(`[tool:${event.toolName}]`)} running ${safeJson(event.partialResult)}`,
      );
    } else if (event.type === "tool_execution_end") {
      const summary = toolResultSummary(event);
      const label = event.isError ? colors.error(`[tool:${event.toolName}] failed`) : colors.success(`[tool:${event.toolName}] done`);
      const line = this.toolLines.get(event.toolCallId) ?? new Text("", 1, 0);
      if (!this.toolLines.has(event.toolCallId)) this.transcript.addChild(line);
      line.setText(`${label}${summary ? ` ${summary}` : ""}`);
      if (!event.isError && (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash")) {
        this.mutatingToolSucceeded = true;
      }
      this.updateStatus("running");
    } else if (event.type === "queue_update") {
      const count = event.steering.length + event.followUp.length;
      if (count > 0) this.updateStatus(`running | queued=${count}`);
    } else if (event.type === "auto_retry_start") {
      this.addSystem(`retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms: ${event.errorMessage}`);
      this.updateStatus("retrying");
    } else if (event.type === "agent_settled") {
      this.updateStatus("idle");
      if (this.mutatingToolSucceeded) {
        this.mutatingToolSucceeded = false;
        void this.showGitStatusIfChanged();
      }
    }
    this.tui.requestRender();
  }

  private refreshReasoning(): void {
    for (const block of this.reasoningBlocks) {
      const text = this.showReasoning
        ? `${colors.dim("[thinking]")} ${block.text.slice(0, 4000)}${block.text.length > 4000 ? "...[truncated]" : ""}`
        : colors.dim(`[thinking] ${block.text.length} chars · /reasoning to expand`);
      block.component.setText(text);
    }
  }

  private resetTurnComponents(): void {
    this.assistantText = "";
    this.assistantComponent = undefined;
    this.currentReasoning = undefined;
  }

  private async showGitStatusIfChanged(): Promise<void> {
    const git = await this.options.getGitStatus(this.options.cwd);
    if (git.available && git.status) {
      this.addSystem(`git status\n${git.status}`);
      this.tui.requestRender();
    }
  }

  private async exit(): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    if (this.session.isStreaming) await this.session.abort();
    this.exitResolve?.();
  }
}
