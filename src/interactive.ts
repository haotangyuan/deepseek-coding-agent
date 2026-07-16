import {
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ModelRegistry,
  type SessionStats,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteProvider,
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
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { relative } from "node:path";
import { DEEPSEEK_PROVIDER, resolveDeepSeekModel, sanitizeError } from "./cli.ts";
import { CacheInspector, formatCacheReport, type CacheReport } from "./cache-inspector.ts";
import { createInteractiveAutocompleteProvider } from "./autocomplete.ts";
import { CompletionEvidenceCollector, summarizeCompletionEvidence } from "./completion-evidence.ts";
import type { ContextResourceItem, ContextSnapshot } from "./context-resources.ts";
import { classifyDeepSeekError } from "./deepseek-errors.ts";
import { sessionDisplayName, sessionFileName, type SessionControls } from "./sessions.ts";
import {
  AGENT_MODES,
  type AgentMode,
  type ApprovalDecision,
  type ApprovalMode,
  type ApprovalRequest,
} from "./tool-policy.ts";

type SelectedModel = NonNullable<CreateAgentSessionOptions["model"]>;
type ThinkingLevel = AgentSession["thinkingLevel"];

export interface InteractiveSession {
  readonly isStreaming: boolean;
  readonly isIdle: boolean;
  readonly model: SelectedModel | undefined;
  readonly thinkingLevel: ThinkingLevel;
  readonly systemPrompt: string;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
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
  agentMode: AgentMode;
  sessionControls: SessionControls;
  terminal?: Terminal;
  clearContext(): void;
  getContextSnapshot(): ContextSnapshot;
  setProjectResourcesEnabled(enabled: boolean): Promise<void>;
  setAgentMode(mode: AgentMode): void;
  getGitStatus(cwd: string): Promise<{ available: boolean; status: string }>;
}

export type InteractiveCommand =
  | { name: "help" | "status" | "cache" | "clear" | "exit" | "reasoning" | "context" | "agents" | "skills" | "prompts" | "session" | "sessions" | "clone"; argument: string }
  | { name: "model" | "thinking" | "mode" | "resources" | "name" | "compact" | "tree" | "fork"; argument: string }
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
  if (["help", "status", "cache", "clear", "exit", "reasoning", "context", "agents", "skills", "prompts", "session", "sessions", "clone"].includes(name)) {
    return {
      name: name as "help" | "status" | "cache" | "clear" | "exit" | "reasoning" | "context" | "agents" | "skills" | "prompts" | "session" | "sessions" | "clone",
      argument,
    };
  }
  if (["model", "thinking", "mode", "resources", "name", "compact", "tree", "fork"].includes(name)) {
    return { name: name as "model" | "thinking" | "mode" | "resources" | "name" | "compact" | "tree" | "fork", argument };
  }
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

interface NoticeCardContent {
  title: string;
  detail: string;
  action?: string;
  footer: string;
  tone: (text: string) => string;
}

class NoticeCard implements Component {
  private content: NoticeCardContent;

  constructor(content: NoticeCardContent) {
    this.content = content;
  }

  setContent(content: NoticeCardContent): void {
    this.content = content;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const available = Math.max(1, width);
    if (available < 8) return [this.content.tone(truncateToWidth(this.content.title, available))];
    const bodyWidth = Math.max(1, available - 4);
    const body = (label: string, text: string, maxLines = 2): string[] => {
      const safe = sanitizeError(text).replace(/\s+/g, " ").trim();
      const wrapped = wrapTextWithAnsi(`${label}${safe}`, bodyWidth);
      const visible = wrapped.slice(0, maxLines);
      if (wrapped.length > maxLines && visible.length > 0) {
        const last = visible.length - 1;
        visible[last] = `${truncateToWidth(visible[last]!, Math.max(1, bodyWidth - 1), "")}…`;
      }
      return visible.map((line) => truncateToWidth(`│ ${line}`, available));
    };
    const lines = [
      this.content.tone(truncateToWidth(`╭─ ${this.content.title}`, available)),
      ...body("", this.content.detail),
    ];
    if (this.content.action) lines.push(...body("Next: ", this.content.action));
    lines.push(this.content.tone(truncateToWidth(`╰─ ${this.content.footer}`, available)));
    return lines;
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

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.editor.setAutocompleteProvider(provider);
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
  private readonly toolLines = new Map<string, Component>();
  private retryCard: NoticeCard | undefined;
  private assistantText = "";
  private assistantComponent: Markdown | undefined;
  private readonly reasoningBlocks: Array<{ component: Text; text: string }> = [];
  private currentReasoning: { component: Text; text: string } | undefined;
  private showReasoning = false;
  private pendingApproval:
    | { request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void; line: Text }
    | undefined;
  private exitResolve: (() => void) | undefined;
  private exiting = false;
  private lastIdleCtrlC = 0;
  private mutatingToolSucceeded = false;
  private readonly completionEvidence: CompletionEvidenceCollector;
  private readonly cacheInspector = new CacheInspector();
  private agentMode: AgentMode;
  private unsubscribe: (() => void) | undefined;

  constructor(options: InteractiveModeOptions) {
    this.options = options;
    this.session = options.session;
    this.agentMode = options.agentMode;
    this.completionEvidence = new CompletionEvidenceCollector(options.cwd);
    this.tui = new TUI(options.terminal ?? new ProcessTerminal());
    this.status = new StatusLine("");
    this.editor = new InteractiveEditor(this.tui, (text) => void this.handleSubmit(text), () => void this.handleCtrlC());
    this.editor.setAutocompleteProvider(createInteractiveAutocompleteProvider({
      cwd: options.cwd,
      modelRegistry: options.modelRegistry,
      getThinkingLevels: () => options.session.getAvailableThinkingLevels(),
      getContextSnapshot: options.getContextSnapshot,
      sessionControls: options.sessionControls,
    }));
    this.header = new Text("", 1, 0);
    this.subheader = new Text("", 1, 0);

    this.tui.addChild(this.header);
    this.tui.addChild(this.subheader);
    this.tui.addChild(new Text(colors.dim("Enter send · / commands · @ files · Tab complete · Ctrl+C cancel/exit"), 1, 0));
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
    this.addSystem(`agent mode ${this.agentMode}`);
    const session = this.options.sessionControls.snapshot();
    this.addSystem(`session ${session.id} · ${session.persisted ? "persisted" : "memory"}`);
    this.addSystem("project context and tool approval are independent boundaries");
    this.tui.start();
    try {
      await new Promise<void>((resolve) => {
        this.exitResolve = resolve;
      });
    } finally {
      this.unsubscribe?.();
      this.pendingApproval?.resolve("deny");
      this.pendingApproval = undefined;
      this.tui.stop();
    }
  }

  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.exiting || this.pendingApproval) return Promise.resolve("deny");
    const choices = request.sessionApprovalKey
      ? "Type y to allow once, a to allow this exact Bash command for this process; anything else rejects."
      : "Type y and Enter to approve once; anything else rejects.";
    const line = new Text(
      `${colors.warning("[approval]")} ${request.summary}\n${sanitizeError(request.preview)}\n${choices}`,
      1,
      0,
    );
    this.transcript.addChild(line);
    this.updateStatus("waiting approval");
    this.tui.requestRender();
    return new Promise<ApprovalDecision>((resolve) => {
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

  private addProviderError(error: unknown): void {
    const diagnostic = classifyDeepSeekError(error);
    const status = diagnostic.statusCode === undefined ? "" : ` · HTTP ${diagnostic.statusCode}`;
    this.transcript.addChild(new NoticeCard({
      title: `PROVIDER ERROR · ${diagnostic.category.replaceAll("_", " ").toUpperCase()}${status}`,
      detail: sanitizeError(error).slice(0, 1000),
      action: diagnostic.action,
      footer: diagnostic.retryable ? "Retryable · waiting for Pi recovery" : "Manual action required",
      tone: colors.error,
    }));
    this.updateStatus("provider error");
  }

  private addCancelled(): void {
    this.transcript.addChild(new NoticeCard({
      title: "RUN CANCELLED",
      detail: "The active model request and tool loop were stopped.",
      action: "Edit the prompt or submit a new task when ready.",
      footer: "Session ready",
      tone: colors.warning,
    }));
  }

  private updateStatus(state: string): void {
    const stats = this.session.getSessionStats();
    const model = this.session.model?.id ?? "none";
    const cwd = relative(process.cwd(), this.options.cwd) || ".";
    const session = this.options.sessionControls.snapshot();
    this.status.setText(
      `${state} | ${DEEPSEEK_PROVIDER}/${model} | session=${session.id.slice(0, 8)} | tokens=${stats.tokens.total} | cwd=${cwd}`,
    );
    const context = this.options.getContextSnapshot();
    const modelLabel = model.replace(/^deepseek-v4-/, "V4 ").toUpperCase();
    this.header.setText(`${colors.ocean("◆")} ${colors.ice(colors.bold("DEEPSEEK CODE"))}`);
    this.subheader.setText(
      colors.dim(
        `${modelLabel} · ${this.agentMode.toUpperCase()} · THINKING ${this.session.thinkingLevel.toUpperCase()} · ${this.options.approvalMode.toUpperCase()} · PROJECT CONTEXT ${context.projectResourcesEnabled ? "ON" : "OFF"}`,
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
      const decision: ApprovalDecision = /^(?:y|yes)$/i.test(text)
        ? "allow-once"
        : approval.request.sessionApprovalKey && /^(?:a|always)$/i.test(text)
          ? "allow-session"
          : "deny";
      const approved = decision !== "deny";
      approval.line.setText(
        `${approved ? colors.success(decision === "allow-session" ? "[approval:allowed-session]" : "[approval:approved]") : colors.error("[approval:rejected]")} ${approval.request.summary}`,
      );
      approval.resolve(decision);
      this.updateStatus(this.session.isStreaming ? "running" : "idle");
      return;
    }

    const command = parseInteractiveCommand(text);
    if (command && !(command.name === "unknown" && this.isResourceInvocation(text))) {
      await this.handleCommand(command);
      return;
    }

    if (this.options.sessionControls.snapshot().compacting) {
      this.addError("wait for compaction to finish or press Ctrl+C to cancel it");
      return;
    }

    const continuingRun = this.session.isStreaming;
    this.transcript.addChild(new Text(`${colors.accent("you")}  ${sanitizeError(text)}`, 1, 0));
    if (!continuingRun) {
      this.completionEvidence.reset();
      this.cacheInspector.begin(this.session.getSessionStats());
    }
    this.resetTurnComponents();
    this.updateStatus(this.session.isStreaming ? "queued steering" : "running");
    this.tui.requestRender();
    try {
      if (this.session.isStreaming) {
        await this.session.steer(text);
        this.addSystem("message queued as steering input");
      } else {
        void this.session.prompt(text).catch((error) => {
          this.addProviderError(error);
          this.updateStatus("idle");
        });
      }
    } catch (error) {
      this.addError(error instanceof Error ? error.message : String(error));
      if (!this.session.isStreaming) this.updateStatus("idle");
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
        "/help /status /cache /session /sessions /name [title] /compact [instructions] /tree [entry] /fork <entry> /clone /context /agents /skills /prompts /resources [on|off] /mode [plan|build] /model [id] /thinking [level] /reasoning /clear /exit",
      );
    } else if (command.name === "status") {
      const stats = this.session.getSessionStats();
      const context = this.options.getContextSnapshot();
      this.addSystem(
        `model=${this.session.model?.id ?? "none"} mode=${this.agentMode} thinking=${this.session.thinkingLevel} approval=${this.options.approvalMode} project-context=${context.projectResourcesEnabled ? "on" : "off"} session=${stats.sessionId} messages=${stats.totalMessages} tokens=${stats.tokens.total}`,
      );
    } else if (command.name === "cache") {
      this.showCacheReport(this.cacheInspector.current(this.session.getSessionStats()));
    } else if (command.name === "session") {
      this.showSession();
    } else if (command.name === "sessions") {
      await this.showSessions();
    } else if (command.name === "name") {
      this.handleSessionName(command.argument);
    } else if (command.name === "compact") {
      await this.handleCompaction(command.argument);
    } else if (command.name === "tree") {
      await this.handleTree(command.argument);
    } else if (command.name === "fork") {
      this.handleFork(command.argument);
    } else if (command.name === "clone") {
      this.handleClone();
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
    } else if (command.name === "mode") {
      this.handleModeCommand(command.argument);
    } else if (command.name === "reasoning") {
      this.showReasoning = !this.showReasoning;
      this.refreshReasoning();
      this.addSystem(`reasoning display ${this.showReasoning ? "expanded" : "collapsed"}`);
    } else if (command.name === "clear") {
      if (this.session.isStreaming || this.options.sessionControls.snapshot().compacting) {
        this.addError("cancel the active run before clearing context");
      } else {
        this.options.clearContext();
        this.transcript.clear();
        this.toolLines.clear();
        this.reasoningBlocks.length = 0;
        this.resetTurnComponents();
        this.addSystem("conversation context cleared; the next prompt starts a new root while persisted history remains available");
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

  private showSession(): void {
    const snapshot = this.options.sessionControls.snapshot();
    const stats = this.session.getSessionStats();
    this.addSystem(
      [
        "SESSION",
        `  id                ${snapshot.id}`,
        `  name              ${snapshot.name ?? "(unnamed)"}`,
        `  storage           ${snapshot.persisted ? snapshot.file ? sessionFileName(snapshot.file) : "pending first response" : "memory"}`,
        `  workspace         ${this.options.cwd}`,
        `  model             ${DEEPSEEK_PROVIDER}/${this.session.model?.id ?? "none"}`,
        `  messages          ${stats.totalMessages}`,
        `  tokens            ${stats.tokens.total}`,
        `  auto compaction   ${snapshot.autoCompaction ? "on" : "off"}`,
      ].join("\n"),
    );
  }

  private async showSessions(): Promise<void> {
    let sessions;
    try {
      sessions = await this.options.sessionControls.list();
    } catch (error) {
      this.addError(`session listing failed: ${sanitizeError(error)}`);
      return;
    }
    if (sessions.length === 0) {
      this.addSystem("no persisted sessions in this workspace");
      return;
    }
    const currentId = this.options.sessionControls.snapshot().id;
    const lines = sessions.slice(0, 12).flatMap((session) => {
      const marker = session.id === currentId ? "*" : " ";
      const created = session.created.toISOString().replace("T", " ").slice(0, 16);
      const modified = session.modified.toISOString().replace("T", " ").slice(0, 16);
      return [
        `${marker} ${session.id.slice(0, 12)} · ${sessionDisplayName(session)}`,
        `    created=${created} · updated=${modified} · ${session.messageCount} msg · ${session.model ?? "model unknown"}`,
      ];
    });
    if (sessions.length > 12) lines.push(`  ... ${sessions.length - 12} more`);
    this.addSystem(`SESSIONS (* current)\n${lines.join("\n")}`);
  }

  private handleSessionName(name: string): void {
    if (!name) {
      this.addError("usage: /name <session title>");
      return;
    }
    const title = name.slice(0, 100);
    this.options.sessionControls.setName(title);
    this.addSystem(`session named ${title}`);
  }

  private async handleCompaction(instructions: string): Promise<void> {
    if (this.session.isStreaming || this.options.sessionControls.snapshot().compacting) {
      this.addError("wait for the active operation before compacting");
      return;
    }
    this.updateStatus("compacting");
    try {
      const result = await this.options.sessionControls.compact(instructions || undefined);
      this.addSystem(
        `compaction complete · before=${result.tokensBefore} tokens · after≈${result.estimatedTokensAfter ?? "unknown"} tokens`,
      );
    } catch (error) {
      this.addError(`compaction failed: ${sanitizeError(error)}`);
    }
  }

  private async handleTree(target: string): Promise<void> {
    if (this.session.isStreaming || this.options.sessionControls.snapshot().compacting) {
      this.addError("tree navigation is unavailable during an active run");
      return;
    }
    try {
      if (target) {
        const result = await this.options.sessionControls.navigate(target);
        if (result.cancelled) {
          this.addSystem("tree navigation cancelled");
          return;
        }
        this.addSystem(`session leaf moved to ${target}; existing branches were preserved`);
      }
      const items = this.options.sessionControls.tree();
      const lines = items.slice(0, 40).map((item) => {
        const marker = item.isLeaf ? "*" : " ";
        return `${marker} ${"  ".repeat(Math.min(item.depth, 6))}${item.id.slice(0, 12)} · ${item.preview}`;
      });
      if (items.length > 40) lines.push(`  ... ${items.length - 40} more`);
      this.addSystem(`SESSION TREE (* current leaf)\n${lines.join("\n") || "  empty"}`);
    } catch (error) {
      this.addError(`tree navigation failed: ${sanitizeError(error)}`);
    }
  }

  private handleFork(entryId: string): void {
    if (this.session.isStreaming || this.options.sessionControls.snapshot().compacting) {
      this.addError("fork is unavailable during an active run");
      return;
    }
    if (!entryId) {
      this.addError("usage: /fork <entry id or prefix>");
      return;
    }
    try {
      const forked = this.options.sessionControls.fork(entryId);
      this.addSystem(`fork created ${forked.id}; resume with: deepseek-code --resume ${forked.id}`);
    } catch (error) {
      this.addError(`fork failed: ${sanitizeError(error)}`);
    }
  }

  private handleClone(): void {
    if (this.session.isStreaming || this.options.sessionControls.snapshot().compacting) {
      this.addError("clone is unavailable during an active run");
      return;
    }
    try {
      const cloned = this.options.sessionControls.clone();
      this.addSystem(`clone created ${cloned.id}; resume with: deepseek-code --resume ${cloned.id}`);
    } catch (error) {
      this.addError(`clone failed: ${sanitizeError(error)}`);
    }
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
        `  Agent mode               ${this.agentMode} (plan exposes read-only tools)`,
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
    if (this.session.isStreaming || this.options.sessionControls.snapshot().compacting) {
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
    if (this.session.isStreaming || this.options.sessionControls.snapshot().compacting) {
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

  private handleModeCommand(mode: string): void {
    if (!mode) {
      this.addSystem(`mode=${this.agentMode}; available: ${AGENT_MODES.join(", ")}`);
      return;
    }
    if (!AGENT_MODES.includes(mode as AgentMode)) {
      this.addError(`invalid agent mode: ${mode}; available: ${AGENT_MODES.join(", ")}`);
      return;
    }
    if (!this.session.isIdle || this.pendingApproval || this.options.sessionControls.snapshot().compacting) {
      this.addError("agent mode cannot be changed during an active operation");
      return;
    }
    const nextMode = mode as AgentMode;
    if (nextMode === this.agentMode) {
      this.addSystem(`agent mode already ${nextMode}`);
      return;
    }
    try {
      this.options.setAgentMode(nextMode);
      this.agentMode = nextMode;
      this.addSystem(`agent mode changed to ${nextMode}; active tools: ${this.session.getActiveToolNames().join(", ") || "none"}`);
    } catch (error) {
      this.addError(`agent mode change failed: ${sanitizeError(error)}`);
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
      approval.resolve("deny");
      this.updateStatus("running");
      return;
    }
    if (this.options.sessionControls.snapshot().compacting) {
      this.options.sessionControls.abortCompaction();
      this.addSystem("compaction cancellation requested");
      this.updateStatus("cancelling compaction");
      return;
    }
    if (this.session.isStreaming) {
      this.updateStatus("cancelling");
      try {
        await this.session.abort();
        this.addCancelled();
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
    this.completionEvidence.observe(event);
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
      if (event.message.stopReason === "error") {
        this.addProviderError(event.message.errorMessage ?? "provider error");
      }
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
      const line = this.toolLines.get(event.toolCallId);
      if (line instanceof Text) {
        line.setText(`${colors.warning(`[tool:${event.toolName}]`)} running ${safeJson(event.partialResult)}`);
      }
    } else if (event.type === "tool_execution_end") {
      const summary = toolResultSummary(event);
      const label = event.isError ? colors.error(`[tool:${event.toolName}] failed`) : colors.success(`[tool:${event.toolName}] done`);
      if (event.isError) {
        const card = new NoticeCard({
          title: `TOOL FAILED · ${event.toolName}`,
          detail: summary || "Tool returned an error without text output.",
          action: "The result was returned to the agent; it can retry or choose another tool.",
          footer: "Agent loop continues",
          tone: colors.error,
        });
        const previous = this.toolLines.get(event.toolCallId);
        const index = previous ? this.transcript.children.indexOf(previous) : -1;
        if (index === -1) this.transcript.addChild(card);
        else this.transcript.children[index] = card;
        this.toolLines.set(event.toolCallId, card);
      } else {
        const line = this.toolLines.get(event.toolCallId);
        const text = line instanceof Text ? line : new Text("", 1, 0);
        if (!(line instanceof Text)) this.transcript.addChild(text);
        text.setText(`${label}${summary ? ` ${summary}` : ""}`);
        this.toolLines.set(event.toolCallId, text);
      }
      if (!event.isError && (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash")) {
        this.mutatingToolSucceeded = true;
      }
      this.updateStatus("running");
    } else if (event.type === "queue_update") {
      const count = event.steering.length + event.followUp.length;
      if (count > 0) this.updateStatus(`running | queued=${count}`);
    } else if (event.type === "auto_retry_start") {
      const diagnostic = classifyDeepSeekError(event.errorMessage);
      this.retryCard = new NoticeCard({
        title: `PROVIDER RETRY · ${event.attempt}/${event.maxAttempts} · ${event.delayMs}ms`,
        detail: `${diagnostic.category.replaceAll("_", " ")} · ${sanitizeError(event.errorMessage).slice(0, 1000)}`,
        action: diagnostic.action,
        footer: "Automatic backoff in progress",
        tone: colors.warning,
      });
      this.transcript.addChild(this.retryCard);
      this.updateStatus("retrying");
    } else if (event.type === "auto_retry_end") {
      const finalError = event.finalError ? sanitizeError(event.finalError).slice(0, 1000) : undefined;
      const card = this.retryCard ?? new NoticeCard({
        title: "",
        detail: "",
        footer: "",
        tone: colors.warning,
      });
      if (!this.retryCard) this.transcript.addChild(card);
      card.setContent(event.success
        ? {
            title: `RETRY RECOVERED · ATTEMPT ${event.attempt}`,
            detail: "DeepSeek streaming resumed after automatic backoff.",
            footer: "Agent loop continues",
            tone: colors.success,
          }
        : {
            title: `RETRY EXHAUSTED · ATTEMPT ${event.attempt}`,
            detail: finalError ?? "DeepSeek did not recover before the retry limit.",
            action: "Check the provider guidance above, then submit again when the issue is resolved.",
            footer: "Session will return to idle",
            tone: colors.error,
          });
      this.updateStatus(event.success ? "running" : "provider error");
    } else if (event.type === "compaction_start") {
      this.addSystem(`compaction started · reason=${event.reason}`);
      this.updateStatus("compacting");
    } else if (event.type === "compaction_end") {
      if (event.aborted) {
        this.addSystem("compaction cancelled");
      } else if (event.errorMessage) {
        this.addError(`compaction failed: ${event.errorMessage}`);
      }
      this.updateStatus("idle");
    } else if (event.type === "agent_settled") {
      this.showCacheReport(this.cacheInspector.finish(this.session.getSessionStats()));
      const summary = summarizeCompletionEvidence(this.completionEvidence.snapshot());
      this.transcript.addChild(new NoticeCard({
        title: summary.attention.length > 0 ? "COMPLETION EVIDENCE · REVIEW" : "COMPLETION EVIDENCE",
        detail: sanitizeError(summary.detail),
        action: summary.attention.length > 0 ? sanitizeError(summary.attention.join("; ")) : undefined,
        footer: "Observed facts only · no extra model request",
        tone: summary.attention.length > 0 ? colors.warning : colors.success,
      }));
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

  private showCacheReport(report: CacheReport): void {
    this.transcript.addChild(new NoticeCard({
      title: report.alert ? "CACHE INSPECTOR · DECLINE" : "CACHE INSPECTOR",
      detail: formatCacheReport(report),
      action: report.alert,
      footer: "DeepSeek usage via Pi · no extra request",
      tone: report.alert ? colors.warning : colors.ice,
    }));
  }

  private resetTurnComponents(): void {
    this.assistantText = "";
    this.assistantComponent = undefined;
    this.currentReasoning = undefined;
    this.retryCard = undefined;
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
    if (this.options.sessionControls.snapshot().compacting) this.options.sessionControls.abortCompaction();
    if (this.session.isStreaming) await this.session.abort();
    if (!this.session.isIdle) await this.session.waitForIdle();
    this.exitResolve?.();
  }
}
