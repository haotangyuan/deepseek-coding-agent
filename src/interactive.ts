import {
  type AgentSession,
  type AgentSessionEvent,
  type BashToolDetails,
  type CreateAgentSessionOptions,
  initTheme,
  type ModelRegistry,
  SessionSelectorComponent,
  type SessionStats,
  TreeSelectorComponent,
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
import { type TurnCheckpointControls } from "./checkpoints.ts";
import { createInteractiveAutocompleteProvider } from "./autocomplete.ts";
import { CompletionEvidenceCollector, summarizeCompletionEvidence } from "./completion-evidence.ts";
import type { ProductPreferences } from "./product-settings.ts";
import type { ProductProjectTrustSnapshot } from "./project-trust.ts";
import { DEFAULT_PROMPT_PROFILE, type PromptProfile } from "./prompt-profile.ts";
import type { ContextResourceItem, ContextSnapshot } from "./context-resources.ts";
import { classifyDeepSeekError } from "./deepseek-errors.ts";
import {
  sessionDisplayName,
  sessionFileName,
  type SessionControls,
  type SessionSelection,
} from "./sessions.ts";
import {
  AGENT_MODES,
  APPROVAL_MODES,
  type AgentMode,
  type ApprovalDecision,
  type ApprovalMode,
  type ApprovalRequest,
} from "./tool-policy.ts";
import {
  createVerificationPrompt,
  discoverValidationSuggestions,
  type ValidationSuggestion,
} from "./validation-suggestions.ts";
import {
  parseToolOutputCommand,
  readToolOutputPage,
  searchToolOutput,
  type ToolOutputPage,
  type ToolOutputSearch,
  type ToolOutputSource,
} from "./tool-output.ts";

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
  promptProfile?: PromptProfile;
  initialShowReasoning?: boolean;
  settingsPath?: string;
  settingsWarning?: string;
  savePreferences?(patch: Partial<ProductPreferences>): void;
  projectTrust?: {
    required: boolean;
    resources: ContextResourceItem[];
    snapshot: ProductProjectTrustSnapshot;
  };
  setProjectTrust?(trusted: boolean, remember: boolean): Promise<string | undefined>;
  checkpoints: TurnCheckpointControls;
  sessionControls: SessionControls;
  terminal?: Terminal;
  clearContext(): void;
  getContextSnapshot(): ContextSnapshot;
  setProjectResourcesEnabled(enabled: boolean): Promise<void>;
  setAgentMode(mode: AgentMode): void;
  getGitStatus(cwd: string): Promise<{ available: boolean; status: string }>;
}

export type InteractiveCommand =
  | { name: "help" | "status" | "cache" | "diff" | "clear" | "exit" | "reasoning" | "context" | "agents" | "skills" | "prompts" | "session" | "sessions" | "clone"; argument: string }
  | { name: "model" | "thinking" | "mode" | "resources" | "trust" | "name" | "compact" | "tree" | "fork" | "undo" | "verify" | "tool" | "settings"; argument: string }
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

function toolResultText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const content = (result.content ?? [])
    .filter((item: { type: string }) => item.type === "text")
    .map((item: { text?: string }) => item.text ?? "")
    .join("\n");
  const safe = sanitizeError(content).trim();
  return safe.length <= 64 * 1024 ? safe : `${safe.slice(0, 64 * 1024)}\n...[display truncated]`;
}

export function parseInteractiveCommand(input: string): InteractiveCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const separator = trimmed.indexOf(" ");
  const name = trimmed.slice(1, separator === -1 ? undefined : separator).toLowerCase();
  const argument = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  if (["help", "status", "cache", "diff", "clear", "exit", "reasoning", "context", "agents", "skills", "prompts", "session", "sessions", "clone"].includes(name)) {
    return {
      name: name as "help" | "status" | "cache" | "diff" | "clear" | "exit" | "reasoning" | "context" | "agents" | "skills" | "prompts" | "session" | "sessions" | "clone",
      argument,
    };
  }
  if (["model", "thinking", "mode", "resources", "trust", "name", "compact", "tree", "fork", "undo", "verify", "tool", "settings"].includes(name)) {
    return { name: name as "model" | "thinking" | "mode" | "resources" | "trust" | "name" | "compact" | "tree" | "fork" | "undo" | "verify" | "tool" | "settings", argument };
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

class TurnDiffCard implements Component {
  private readonly files: string[];
  private readonly patch: string;
  private readonly warning: string | undefined;

  constructor(files: string[], patch: string, warning?: string) {
    this.files = files;
    this.patch = patch;
    this.warning = warning;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const available = Math.max(1, width);
    const bodyWidth = Math.max(1, available - 2);
    const patchLines = this.patch.split("\n");
    const visible = patchLines.slice(0, 18).map((line) => {
      const clipped = truncateToWidth(line, bodyWidth);
      if (line.startsWith("+") && !line.startsWith("+++")) return colors.success(clipped);
      if (line.startsWith("-") && !line.startsWith("---")) return colors.error(clipped);
      if (line.startsWith("@@")) return colors.accent(clipped);
      return clipped;
    });
    if (patchLines.length > visible.length) visible.push(colors.dim(`… ${patchLines.length - visible.length} more diff lines`));
    const lines = [
      colors.ice(truncateToWidth(`╭─ TURN DIFF · ${this.files.length} FILE${this.files.length === 1 ? "" : "S"}`, available)),
      ...visible.map((line) => truncateToWidth(`│ ${line}`, available)),
    ];
    if (this.warning) lines.push(colors.warning(truncateToWidth(`│ Warning: ${this.warning}`, available)));
    lines.push(colors.ice(truncateToWidth("╰─ /undo to review rollback · /undo confirm to apply", available)));
    return lines;
  }
}

class ToolOutputViewCard implements Component {
  private readonly toolName: string;
  private readonly toolId: string;
  private readonly view: ToolOutputPage | ToolOutputSearch;

  constructor(toolName: string, toolId: string, view: ToolOutputPage | ToolOutputSearch) {
    this.toolName = toolName;
    this.toolId = toolId;
    this.view = view;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const available = Math.max(1, width);
    const bodyWidth = Math.max(1, available - 4);
    const isPage = "lines" in this.view;
    const items = isPage ? this.view.lines : this.view.matches;
    const source = this.view.source === "pi-bash-temp" ? "Pi temp file" : "event result";
    const summary = isPage
      ? `page=${this.view.page}/${this.view.totalPages} · lines=${this.view.totalLines} · source=${source}`
      : `query=${sanitizeError(this.view.query)} · matches=${this.view.totalMatches} · source=${source}`;
    const numberWidth = Math.max(1, String(items.at(-1)?.number ?? 0).length);
    const lines = [
      colors.ice(truncateToWidth(`╭─ TOOL OUTPUT · ${this.toolName.toUpperCase()} · ${this.toolId.slice(0, 12)}`, available)),
      colors.dim(truncateToWidth(`│ ${summary}`, available)),
    ];
    for (const item of items) {
      const prefix = `${String(item.number).padStart(numberWidth, " ")} │ `;
      const text = truncateToWidth(sanitizeError(item.text), Math.max(1, bodyWidth - prefix.length));
      lines.push(truncateToWidth(`│ ${colors.accent(prefix)}${isPage ? text : colors.warning(text)}`, available));
    }
    if (items.length === 0) lines.push(colors.dim(truncateToWidth(`│ ${isPage ? "No output lines" : "No matching lines"}`, available)));
    if (!isPage && this.view.limited) {
      lines.push(colors.dim(truncateToWidth(`│ … ${this.view.totalMatches - this.view.matches.length} more matches`, available)));
    }
    lines.push(colors.ice(truncateToWidth(
      `╰─ /tool ${this.toolId.slice(0, 12)} page <n> · /tool ${this.toolId.slice(0, 12)} find <text>`,
      available,
    )));
    return lines;
  }
}

type ToolCardStatus = "running" | "done" | "failed" | "timeout" | "cancelled";

class ToolActivityCard implements Component {
  readonly id: string;
  private readonly name: string;
  private readonly cwd: string;
  private readonly startedAt = Date.now();
  private args: Record<string, unknown>;
  private endedAt: number | undefined;
  private status: ToolCardStatus = "running";
  private exitCode: number | undefined;
  private output = "";
  private details: BashToolDetails | undefined;
  private expanded = false;

  constructor(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>, cwd: string) {
    this.id = event.toolCallId;
    this.name = event.toolName;
    this.args = event.args;
    this.cwd = cwd;
  }

  update(event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>): void {
    this.args = event.args;
    this.output = toolResultText(event.partialResult);
    this.details = this.readBashDetails(event.partialResult.details);
  }

  finish(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
    this.endedAt = Date.now();
    this.output = toolResultText(event.result);
    this.details = this.readBashDetails(event.result.details);
    if (!event.isError) {
      this.status = "done";
      if (this.name === "bash") this.exitCode = 0;
      return;
    }
    const exitMatch = this.output.match(/Command exited with code (\d+)/);
    if (exitMatch) this.exitCode = Number(exitMatch[1]);
    if (/Command timed out after/.test(this.output)) this.status = "timeout";
    else if (/Command aborted/.test(this.output)) this.status = "cancelled";
    else this.status = "failed";
  }

  toggleExpanded(): boolean {
    this.expanded = !this.expanded;
    return this.expanded;
  }

  outputSnapshot(): { name: string; source: ToolOutputSource; running: boolean } {
    if (this.details?.truncation?.truncated && !this.details.fullOutputPath) {
      throw new Error("Pi truncated this result but its full output file is unavailable; use /tool to inspect the retained tail");
    }
    return {
      name: this.name,
      source: {
        inline: this.output,
        fullOutputPath: this.details?.truncation?.truncated ? this.details.fullOutputPath : undefined,
        totalLines: this.details?.truncation?.totalLines,
      },
      running: this.status === "running",
    };
  }

  invalidate(): void {}

  render(width: number): string[] {
    const available = Math.max(1, width);
    const bodyWidth = Math.max(1, available - 4);
    const titleStatus = this.status === "done"
      ? this.name === "bash" ? "EXIT 0" : "DONE"
      : this.status === "failed"
        ? this.exitCode === undefined ? "FAILED" : `EXIT ${this.exitCode}`
        : this.status.toUpperCase();
    const tone = this.status === "running" ? colors.warning : this.status === "done" ? colors.success : colors.error;
    const call = this.name === "bash" && typeof this.args.command === "string"
      ? `$ ${sanitizeError(this.args.command)}`
      : safeJson(this.args);
    const elapsedMs = Math.max(0, (this.endedAt ?? Date.now()) - this.startedAt);
    const duration = elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;
    const lines = [tone(truncateToWidth(`╭─ ${this.name.toUpperCase()} · ${titleStatus}`, available))];
    const callLines = wrapTextWithAnsi(call, bodyWidth);
    const visibleCall = callLines.slice(0, this.expanded ? 8 : 2);
    lines.push(...visibleCall.map((line) => truncateToWidth(`│ ${line}`, available)));
    if (callLines.length > visibleCall.length) {
      lines.push(colors.dim(truncateToWidth(`│ … ${callLines.length - visibleCall.length} argument lines`, available)));
    }
    if (this.name === "bash") {
      lines.push(colors.dim(truncateToWidth(`│ cwd=${displayPath(this.cwd, this.cwd)} · duration=${duration}`, available)));
    }
    const outputLines = this.output.split("\n").filter((line) => line.trim() !== "");
    const visibleOutput = this.expanded ? outputLines.slice(-16) : outputLines.slice(-2);
    for (const line of visibleOutput) lines.push(truncateToWidth(`│ ${line}`, available));
    if (outputLines.length > visibleOutput.length) {
      lines.push(colors.dim(truncateToWidth(`│ … ${outputLines.length - visibleOutput.length} earlier lines`, available)));
    }
    if (this.details?.truncation?.truncated) {
      lines.push(colors.warning(truncateToWidth(
        `│ truncated=${this.details.truncation.truncatedBy ?? "yes"} · full=${this.details.fullOutputPath ?? "unavailable"}`,
        available,
      )));
    }
    const shortId = this.id.slice(0, 12);
    const footer = this.status === "running"
      ? `streaming · id=${shortId}`
      : `${this.expanded ? `/tool ${shortId} to collapse` : `/tool ${shortId} to expand`} · id=${shortId}`;
    lines.push(tone(truncateToWidth(`╰─ ${footer}`, available)));
    return lines;
  }

  private readBashDetails(value: unknown): BashToolDetails | undefined {
    if (this.name !== "bash" || !value || typeof value !== "object") return undefined;
    return value as BashToolDetails;
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
  private readonly editorContainer = new Container();
  private readonly toolCards = new Map<string, ToolActivityCard>();
  private latestToolId: string | undefined;
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
  private readonly promptProfile: PromptProfile;
  private unsubscribe: (() => void) | undefined;
  private nextSessionSelection: SessionSelection | undefined;
  private pendingVerification: ValidationSuggestion | undefined;
  private toolOutputAbort: AbortController | undefined;
  private pendingProjectTrust = false;
  private projectTrustStatus: ProductProjectTrustSnapshot["status"];

  constructor(options: InteractiveModeOptions) {
    initTheme("dark");
    this.options = options;
    this.session = options.session;
    this.agentMode = options.agentMode;
    this.promptProfile = options.promptProfile ?? DEFAULT_PROMPT_PROFILE;
    this.showReasoning = options.initialShowReasoning ?? false;
    this.projectTrustStatus = options.projectTrust?.snapshot.status ?? "trusted";
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
    this.editorContainer.addChild(this.editor);
    this.tui.addChild(this.editorContainer);
    this.tui.setFocus(this.editor);
    this.updateStatus("idle");
  }

  async run(): Promise<SessionSelection | undefined> {
    this.unsubscribe = this.session.subscribe((event) => this.handleEvent(event));
    this.addSystem(`workspace ${this.options.cwd}`);
    this.addSystem(`approval ${this.options.approvalMode}`);
    this.addSystem(`agent mode ${this.agentMode}`);
    this.addSystem(`prompt profile ${this.promptProfile}`);
    if (this.options.settingsWarning) this.addSystem(`settings warning: ${this.options.settingsWarning}; safe defaults are active`);
    const session = this.options.sessionControls.snapshot();
    this.addSystem(`session ${session.id} · ${session.persisted ? "persisted" : "memory"}`);
    this.addSystem("project context and tool approval are independent boundaries");
    this.showInitialProjectTrustPrompt();
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
    return this.nextSessionSelection;
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
      `${state} | ${DEEPSEEK_PROVIDER}/${model} | prompt=${this.promptProfile} | session=${session.id.slice(0, 8)} | tokens=${stats.tokens.total} | cwd=${cwd}`,
    );
    const context = this.options.getContextSnapshot();
    const modelLabel = model.replace(/^deepseek-v4-/, "V4 ").toUpperCase();
    this.header.setText(`${colors.ocean("◆")} ${colors.ice(colors.bold("DEEPSEEK CODE"))}`);
    this.subheader.setText(
      colors.dim(
        `${modelLabel} · ${this.agentMode.toUpperCase()} · PROMPT ${this.promptProfile.toUpperCase()} · THINKING ${this.session.thinkingLevel.toUpperCase()} · ${this.options.approvalMode.toUpperCase()} · PROJECT CONTEXT ${context.projectResourcesEnabled ? "ON" : "OFF"}`,
      ),
    );
    this.tui.requestRender();
  }

  private async handleSubmit(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text) return;
    this.editor.clearInput();

    if (this.pendingProjectTrust) {
      await this.handleProjectTrustInput(text);
      return;
    }

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
    this.pendingVerification = undefined;
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
        "/help /status /settings [approval value] /trust [once|always|off|deny] /cache /diff /verify [name|confirm] /tool [id] [page n|find text] /undo [confirm] /session /sessions [list] /name [title] /compact [instructions] /tree [entry|list] /fork <entry> /clone /context /agents /skills /prompts /resources [on|off] /mode [plan|build] /model [id] /thinking [level] /reasoning /clear /exit",
      );
    } else if (command.name === "status") {
      const stats = this.session.getSessionStats();
      const context = this.options.getContextSnapshot();
      this.addSystem(
        `model=${this.session.model?.id ?? "none"} mode=${this.agentMode} prompt=${this.promptProfile} thinking=${this.session.thinkingLevel} approval=${this.options.approvalMode} project-context=${context.projectResourcesEnabled ? "on" : "off"} session=${stats.sessionId} messages=${stats.totalMessages} tokens=${stats.tokens.total}`,
      );
    } else if (command.name === "settings") {
      this.handleSettingsCommand(command.argument);
    } else if (command.name === "cache") {
      this.showCacheReport(this.cacheInspector.current(this.session.getSessionStats()));
    } else if (command.name === "diff") {
      this.showTurnDiff();
    } else if (command.name === "verify") {
      await this.handleVerify(command.argument);
    } else if (command.name === "tool") {
      await this.handleToolCommand(command.argument);
    } else if (command.name === "undo") {
      await this.handleUndo(command.argument);
    } else if (command.name === "session") {
      this.showSession();
    } else if (command.name === "sessions") {
      await this.showSessions(command.argument);
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
    } else if (command.name === "trust") {
      await this.handleTrustCommand(command.argument);
    } else if (command.name === "mode") {
      this.handleModeCommand(command.argument);
    } else if (command.name === "reasoning") {
      this.showReasoning = !this.showReasoning;
      this.refreshReasoning();
      this.addSystem(`reasoning display ${this.showReasoning ? "expanded" : "collapsed"}`);
      this.persistPreference({ showReasoning: this.showReasoning });
    } else if (command.name === "clear") {
      if (this.session.isStreaming || this.options.sessionControls.snapshot().compacting) {
        this.addError("cancel the active run before clearing context");
      } else {
        this.options.clearContext();
        this.transcript.clear();
        this.toolCards.clear();
        this.latestToolId = undefined;
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

  private async showSessions(argument: string): Promise<void> {
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
    const current = this.options.sessionControls.snapshot();
    if (argument !== "list") {
      const close = (): void => this.hideSelector();
      const currentPaths = new Set(sessions.map((session) => session.path));
      const selector = new SessionSelectorComponent(
        () => this.options.sessionControls.list(),
        () => this.options.sessionControls.listAll(),
        (sessionPath) => {
          close();
          if (!currentPaths.has(sessionPath)) {
            this.addError("selected session belongs to another workspace; launch DeepSeek Code from that directory to resume it");
            return;
          }
          if (sessionPath === current.file) {
            this.addSystem("selected session is already active");
            return;
          }
          this.nextSessionSelection = { type: "resume", target: sessionPath };
          this.addSystem(`switching to session ${sessionFileName(sessionPath)}`);
          void this.exit();
        },
        close,
        () => void this.exit(),
        () => this.tui.requestRender(),
        { showRenameHint: false },
        current.file,
      );
      this.showSelector(selector, selector.getSessionList());
      return;
    }
    const currentId = current.id;
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
      if (!target) {
        const rawTree = this.options.sessionControls.rawTree();
        if (rawTree.length === 0) {
          this.addSystem("session tree is empty");
          return;
        }
        const close = (): void => this.hideSelector();
        const selector = new TreeSelectorComponent(
          rawTree,
          this.options.sessionControls.leafId(),
          this.tui.terminal.rows,
          (entryId) => {
            close();
            if (entryId === this.options.sessionControls.leafId()) {
              this.addSystem("selected tree entry is already the current leaf");
              return;
            }
            void this.navigateTree(entryId);
          },
          close,
        );
        this.showSelector(selector, selector);
        return;
      }
      if (target !== "list") {
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

  private async navigateTree(entryId: string): Promise<void> {
    try {
      const result = await this.options.sessionControls.navigate(entryId);
      if (result.cancelled) {
        this.addSystem("tree navigation cancelled");
      } else {
        this.addSystem(`session leaf moved to ${entryId}; existing branches were preserved`);
      }
    } catch (error) {
      this.addError(`tree navigation failed: ${sanitizeError(error)}`);
    }
    this.updateStatus(this.session.isStreaming ? "running" : "idle");
    this.tui.requestRender();
  }

  private showSelector(component: Component, focus: Component): void {
    this.editorContainer.clear();
    this.editorContainer.addChild(component);
    this.tui.setFocus(focus);
    this.tui.requestRender();
  }

  private hideSelector(): void {
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
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

  private showInitialProjectTrustPrompt(): void {
    const trust = this.options.projectTrust;
    if (!trust?.required) return;
    if (this.projectTrustStatus === "trusted") {
      this.addSystem(`project context trusted${trust.snapshot.remembered ? ` via ${trust.snapshot.savedPath}` : " for this session"}`);
      return;
    }
    if (this.projectTrustStatus === "untrusted" && trust.snapshot.remembered) {
      this.addSystem(`project context disabled by saved decision at ${trust.snapshot.savedPath ?? this.options.cwd}; use /trust once to override this session`);
      return;
    }
    const resources = trust.resources.slice(0, 6).map((item) => `  ${item.scope}:${item.name} · ${displayPath(item.path, this.options.cwd)}`);
    const omitted = trust.resources.length > resources.length ? `\n  … ${trust.resources.length - resources.length} more` : "";
    const error = trust.snapshot.error ? `\n${colors.warning(`Trust store warning: ${sanitizeError(trust.snapshot.error)}`)}` : "";
    this.transcript.addChild(new Text(
      `${colors.ice("PROJECT CONTEXT TRUST")}\n${this.options.cwd}\n${resources.join("\n") || "  .pi project settings/resources"}${omitted}${error}\nType y=enable once, a=enable and remember, n=disable once, d=disable and remember.\nTool approval remains independent. Project extensions stay disabled.`,
      1,
      0,
    ));
    this.pendingProjectTrust = true;
    this.updateStatus("waiting project trust");
  }

  private async handleProjectTrustInput(input: string): Promise<void> {
    const normalized = input.toLowerCase();
    const choice = normalized === "y" || normalized === "yes"
      ? { trusted: true, remember: false }
      : normalized === "a" || normalized === "always"
        ? { trusted: true, remember: true }
        : normalized === "n" || normalized === "no"
          ? { trusted: false, remember: false }
          : normalized === "d" || normalized === "deny"
            ? { trusted: false, remember: true }
            : undefined;
    if (!choice) {
      this.addError("choose y, a, n, or d before submitting a task");
      this.pendingProjectTrust = true;
      return;
    }
    await this.applyProjectTrust(choice.trusted, choice.remember);
  }

  private async handleTrustCommand(argument: string): Promise<void> {
    const trust = this.options.projectTrust;
    if (!trust?.required) {
      this.addSystem("project trust is not required; no project context resources were discovered");
      return;
    }
    if (!argument) {
      this.addSystem(`project trust=${this.projectTrustStatus}; resources=${trust.resources.length}; use /trust once|always|off|deny`);
      return;
    }
    if (this.session.isStreaming || this.options.sessionControls.snapshot().compacting) {
      this.addError("project trust cannot change during an active operation");
      return;
    }
    const choice = argument === "once"
      ? { trusted: true, remember: false }
      : argument === "always"
        ? { trusted: true, remember: true }
        : argument === "off"
          ? { trusted: false, remember: false }
          : argument === "deny"
            ? { trusted: false, remember: true }
            : undefined;
    if (!choice) {
      this.addError("usage: /trust [once|always|off|deny]");
      return;
    }
    await this.applyProjectTrust(choice.trusted, choice.remember);
  }

  private async applyProjectTrust(trusted: boolean, remember: boolean): Promise<void> {
    if (!this.options.setProjectTrust) {
      this.addError("project trust is unavailable in this runtime");
      return;
    }
    this.pendingProjectTrust = false;
    this.updateStatus("reloading trusted context");
    try {
      const warning = await this.options.setProjectTrust(trusted, remember);
      this.projectTrustStatus = trusted ? "trusted" : "untrusted";
      this.pendingVerification = undefined;
      const snapshot = this.options.getContextSnapshot();
      this.addSystem(
        `project context ${trusted ? "enabled" : "disabled"}${remember && !warning ? " and remembered" : " for this session"}; AGENTS=${snapshot.agentsFiles.length} Skills=${snapshot.skills.length} Prompts=${snapshot.prompts.length}`,
      );
      if (warning) this.addError(`trust decision applied for this session but was not remembered: ${warning}`);
      this.updateStatus("idle");
    } catch (error) {
      this.addError(`project trust change failed: ${sanitizeError(error)}`);
      this.updateStatus("idle");
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
        `  Project trust            ${this.options.projectTrust?.required ? this.projectTrustStatus : "not required"}`,
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
    if (enabled && this.options.projectTrust?.required && this.projectTrustStatus !== "trusted") {
      this.addError("project resources are untrusted; use /trust once or /trust always first");
      return;
    }
    if (enabled === current) {
      this.addSystem(`project resources already ${enabled ? "enabled" : "disabled"}`);
      return;
    }
    this.updateStatus("reloading context");
    try {
      await this.options.setProjectResourcesEnabled(enabled);
      this.pendingVerification = undefined;
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
      this.persistPreference({ model: model.id });
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
      this.persistPreference({ mode: nextMode });
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
    this.persistPreference({ thinking: this.session.thinkingLevel as ProductPreferences["thinking"] });
  }

  private handleSettingsCommand(argument: string): void {
    if (!argument) {
      this.addSystem([
        "USER SETTINGS",
        `  file       ${this.options.settingsPath ?? "in-memory"}`,
        `  model      ${this.session.model?.id ?? "none"}`,
        `  thinking   ${this.session.thinkingLevel}`,
        `  mode       ${this.agentMode}`,
        `  approval   ${this.options.approvalMode} (current)`,
        `  reasoning  ${this.showReasoning ? "expanded" : "collapsed"}`,
        "Use /settings approval <ask|auto-read|deny> for the next launch.",
      ].join("\n"));
      return;
    }
    const [field, value, ...extra] = argument.split(/\s+/);
    if (field !== "approval" || !value || extra.length > 0 || !APPROVAL_MODES.includes(value as ApprovalMode)) {
      this.addError("usage: /settings [approval <ask|auto-read|deny>]");
      return;
    }
    if (this.persistPreference({ approval: value as ApprovalMode })) {
      this.addSystem(`default approval saved as ${value}; current session remains ${this.options.approvalMode}`);
    }
  }

  private persistPreference(patch: Partial<ProductPreferences>): boolean {
    if (!this.options.savePreferences) return false;
    try {
      this.options.savePreferences(patch);
      return true;
    } catch (error) {
      this.addError(`settings save failed: ${sanitizeError(error)}`);
      return false;
    }
  }

  private async handleCtrlC(): Promise<void> {
    if (this.pendingProjectTrust) {
      await this.applyProjectTrust(false, false);
      return;
    }
    if (this.pendingApproval) {
      const approval = this.pendingApproval;
      this.pendingApproval = undefined;
      approval.line.setText(`${colors.error("[approval:rejected]")} ${approval.request.summary}`);
      approval.resolve("deny");
      this.updateStatus("running");
      return;
    }
    if (this.toolOutputAbort) {
      this.toolOutputAbort.abort();
      this.addSystem("tool output view cancellation requested");
      this.updateStatus("cancelling tool output view");
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
      const card = new ToolActivityCard(event, this.options.cwd);
      this.toolCards.set(event.toolCallId, card);
      this.latestToolId = event.toolCallId;
      this.transcript.addChild(card);
      this.updateStatus(`tool ${event.toolName}`);
    } else if (event.type === "tool_execution_update") {
      this.toolCards.get(event.toolCallId)?.update(event);
    } else if (event.type === "tool_execution_end") {
      let card = this.toolCards.get(event.toolCallId);
      if (!card) {
        card = new ToolActivityCard({
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: {},
        }, this.options.cwd);
        this.toolCards.set(event.toolCallId, card);
        this.transcript.addChild(card);
      }
      card.finish(event);
      this.latestToolId = event.toolCallId;
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
      const evidence = this.completionEvidence.snapshot();
      const summary = summarizeCompletionEvidence(evidence);
      const needsClosure = evidence.changedFiles.length > 0 && (!evidence.diffReviewed || evidence.checks.length === 0);
      this.transcript.addChild(new NoticeCard({
        title: summary.attention.length > 0 ? "COMPLETION EVIDENCE · REVIEW" : "COMPLETION EVIDENCE",
        detail: sanitizeError(summary.detail),
        action: needsClosure
          ? `${sanitizeError(summary.attention.join("; "))}. Choose /diff · /verify · /undo, or continue typing to accept.`
          : summary.attention.length > 0 ? sanitizeError(summary.attention.join("; ")) : undefined,
        footer: needsClosure ? "No extra request until /verify confirm" : "Observed facts only · no extra model request",
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

  private showTurnDiff(): void {
    const snapshot = this.options.checkpoints.snapshot();
    if (snapshot.status === "recording") {
      this.addError("wait for the active agent turn before reviewing its diff");
      return;
    }
    const diff = this.options.checkpoints.diff();
    if (diff.files.length === 0) {
      const detail = snapshot.status === "undone"
        ? "The latest write/edit checkpoint has already been undone."
        : "No write/edit changes were recorded for the latest mutating turn.";
      this.transcript.addChild(new NoticeCard({
        title: "TURN DIFF · EMPTY",
        detail,
        action: [
          diff.bashObserved ? "Bash ran in that turn; its filesystem side effects are outside automatic Undo." : undefined,
          ...snapshot.warnings,
        ].filter((warning) => warning !== undefined).join(" ") || undefined,
        footer: "No workspace files changed by tracked Pi write/edit tools",
        tone: colors.dim,
      }));
      return;
    }
    const warnings = [
      diff.bashObserved ? "Bash side effects are not included in automatic Undo." : undefined,
      ...diff.warnings,
    ].filter((warning) => warning !== undefined).join(" ");
    this.transcript.addChild(new TurnDiffCard(diff.files, diff.patch, warnings || undefined));
  }

  private async handleToolCommand(argument: string): Promise<void> {
    let command;
    try {
      command = parseToolOutputCommand(argument);
    } catch (error) {
      this.addError(error instanceof Error ? error.message : String(error));
      return;
    }
    const target = command.target || this.latestToolId;
    if (!target) {
      this.addError("no tool result is available");
      return;
    }
    const matches = [...this.toolCards.entries()].filter(([id]) => id === target || id.startsWith(target));
    if (matches.length === 0) {
      this.addError(`tool call not found: ${target}`);
      return;
    }
    if (matches.length > 1) {
      this.addError(`tool call id is ambiguous: ${target}`);
      return;
    }
    const [id, card] = matches[0]!;
    this.latestToolId = id;
    if (command.action === "toggle") {
      const expanded = card.toggleExpanded();
      this.addSystem(`tool ${id.slice(0, 12)} ${expanded ? "expanded" : "collapsed"}`);
      return;
    }

    if (this.session.isStreaming || this.options.sessionControls.snapshot().compacting) {
      this.addError("wait for the active Agent or compaction before paging or searching tool output");
      return;
    }
    if (this.toolOutputAbort) {
      this.addError("another tool output view is still loading");
      return;
    }

    const abort = new AbortController();
    this.toolOutputAbort = abort;
    let snapshot;
    try {
      snapshot = card.outputSnapshot();
      if (snapshot.running) throw new Error("wait for the tool to finish before paging or searching its output");
      this.updateStatus(command.action === "page" ? "loading tool output" : "searching tool output");
      const view = command.action === "page"
        ? await readToolOutputPage(snapshot.source, command.page, abort.signal)
        : await searchToolOutput(snapshot.source, command.query, abort.signal);
      this.transcript.addChild(new ToolOutputViewCard(snapshot.name, id, view));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.addSystem("tool output view cancelled; Session remains ready");
      } else {
        this.addError(`tool output unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (this.toolOutputAbort === abort) this.toolOutputAbort = undefined;
    }
  }

  private async handleVerify(argument: string): Promise<void> {
    if (this.session.isStreaming || this.options.sessionControls.snapshot().compacting) {
      this.addError("wait for the active operation before starting verification");
      return;
    }
    const checkpoint = this.options.checkpoints.snapshot();
    if (checkpoint.status !== "ready" || checkpoint.files.length === 0) {
      this.pendingVerification = undefined;
      this.addError("no tracked write/edit changes are available to verify");
      return;
    }
    if (argument !== "confirm") {
      const projectConfigEnabled = this.projectTrustStatus === "trusted"
        && this.options.getContextSnapshot().projectResourcesEnabled;
      let suggestions: ValidationSuggestion[];
      try {
        suggestions = await discoverValidationSuggestions(this.options.cwd, { projectConfigEnabled });
      } catch (error) {
        this.pendingVerification = undefined;
        this.addError(`validation configuration failed: ${sanitizeError(error)}`);
        return;
      }
      if (suggestions.length === 0) {
        this.pendingVerification = undefined;
        this.transcript.addChild(new NoticeCard({
          title: "VERIFY · NO SUGGESTION",
          detail: "No supported validation entry was found in known project manifests.",
          action: "Run the appropriate check yourself, or tell the Agent exactly which command to run.",
          footer: "No model request · no command executed",
          tone: colors.warning,
        }));
        return;
      }
      if (!argument && suggestions.length > 1) {
        this.pendingVerification = undefined;
        this.transcript.addChild(new NoticeCard({
          title: "VERIFY · CHOOSE COMMAND",
          detail: suggestions.map((suggestion) => `${suggestion.name} → ${suggestion.command}`).join(" · "),
          action: "Run /verify <name> to preview one exact command before confirmation.",
          footer: `${suggestions.length} trusted project commands · no model request · no command executed`,
          tone: colors.ice,
        }));
        return;
      }
      const suggestion = argument
        ? suggestions.find((candidate) => candidate.name === argument)
        : suggestions[0];
      if (!suggestion) {
        this.pendingVerification = undefined;
        this.addError(`unknown validation command: ${argument}; available: ${suggestions.map((candidate) => candidate.name).join(", ")}`);
        return;
      }
      this.pendingVerification = suggestion;
      this.transcript.addChild(new NoticeCard({
        title: "VERIFY READY",
        detail: `${suggestion.command}\nname=${suggestion.name} · source=${suggestion.source} · ${suggestion.reason}`,
        action: "Run /verify confirm to start one new paid Agent turn. Bash approval still applies.",
        footer: "Preview only · no model request · no command executed",
        tone: colors.ice,
      }));
      return;
    }
    const suggestion = this.pendingVerification;
    if (!suggestion) {
      this.addError("run /verify first to review the exact suggested command and cost warning");
      return;
    }
    if (suggestion.scope === "project"
      && (this.projectTrustStatus !== "trusted" || !this.options.getContextSnapshot().projectResourcesEnabled)) {
      this.pendingVerification = undefined;
      this.addError("project validation command is no longer trusted or enabled; run /verify again");
      return;
    }
    this.pendingVerification = undefined;
    this.transcript.addChild(new Text(`${colors.accent("you")}  [verify] ${sanitizeError(suggestion.command)}`, 1, 0));
    this.completionEvidence.reset();
    this.cacheInspector.begin(this.session.getSessionStats());
    this.resetTurnComponents();
    this.updateStatus("running verification");
    this.tui.requestRender();
    void this.session.prompt(createVerificationPrompt(suggestion)).catch((error) => {
      this.addProviderError(error);
      this.updateStatus("idle");
    });
  }

  private async handleUndo(argument: string): Promise<void> {
    if (this.session.isStreaming || this.options.sessionControls.snapshot().compacting) {
      this.addError("cancel the active operation before undoing file changes");
      return;
    }
    const snapshot = this.options.checkpoints.snapshot();
    if (snapshot.status !== "ready" || snapshot.files.length === 0) {
      this.addError("no undoable write/edit changes are available for the latest mutating turn");
      return;
    }
    if (argument !== "confirm") {
      this.transcript.addChild(new NoticeCard({
        title: `UNDO READY · ${snapshot.files.length} FILE${snapshot.files.length === 1 ? "" : "S"}`,
        detail: snapshot.files.join(", "),
        action: "Review /diff, then run /undo confirm. Undo restores files only; conversation history is preserved.",
        footer: snapshot.bashObserved ? "Bash side effects are not covered" : "Conflict check runs before any file is restored",
        tone: colors.warning,
      }));
      return;
    }
    try {
      const result = await this.options.checkpoints.undo();
      this.pendingVerification = undefined;
      this.transcript.addChild(new NoticeCard({
        title: "UNDO COMPLETE",
        detail: result.restoredFiles.join(", "),
        action: "Continue with a corrected instruction; the prior conversation remains in the Session tree.",
        footer: snapshot.bashObserved ? "write/edit restored · Bash side effects unchanged" : "write/edit files restored",
        tone: colors.success,
      }));
      await this.showGitStatusIfChanged();
    } catch (error) {
      this.addError(`undo failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    this.toolOutputAbort?.abort();
    if (this.options.sessionControls.snapshot().compacting) this.options.sessionControls.abortCompaction();
    if (this.session.isStreaming) await this.session.abort();
    if (!this.session.isIdle) await this.session.waitForIdle();
    this.exitResolve?.();
  }
}
