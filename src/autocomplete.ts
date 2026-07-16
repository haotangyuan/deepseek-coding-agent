import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  CombinedAutocompleteProvider,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { DEEPSEEK_PROVIDER } from "./cli.ts";
import type { ContextSnapshot } from "./context-resources.ts";
import type { SessionControls } from "./sessions.ts";
import { AGENT_MODES, sensitivePathLabel } from "./tool-policy.ts";

interface AutocompleteOptions {
  cwd: string;
  modelRegistry: ModelRegistry;
  getThinkingLevels(): string[];
  getContextSnapshot(): ContextSnapshot;
  sessionControls: SessionControls;
}

const builtinCommands: SlashCommand[] = [
  { name: "help", description: "Show commands and shortcuts" },
  { name: "status", description: "Show the current runtime state" },
  { name: "cache", description: "Inspect DeepSeek cache usage for the latest turn" },
  { name: "diff", description: "Review write/edit changes from the latest mutating turn" },
  { name: "verify", argumentHint: "[confirm]", description: "Preview or start explicit validation" },
  { name: "undo", argumentHint: "[confirm]", description: "Safely undo the latest write/edit turn" },
  { name: "session", description: "Show the active session" },
  { name: "sessions", argumentHint: "[list]", description: "Select or list workspace sessions" },
  { name: "name", argumentHint: "<title>", description: "Name the active session" },
  { name: "compact", argumentHint: "[instructions]", description: "Compact the active context" },
  { name: "clone", description: "Clone the active session" },
  { name: "context", description: "Show the effective context map" },
  { name: "agents", description: "Show loaded AGENTS files" },
  { name: "skills", description: "Show discovered Skills" },
  { name: "prompts", description: "Show discovered prompt templates" },
  { name: "reasoning", description: "Expand or collapse reasoning" },
  { name: "clear", description: "Start a new conversation root" },
  { name: "exit", description: "Exit DeepSeek Code" },
];

function fuzzyItems(values: Array<{ value: string; description?: string }>, prefix: string): AutocompleteItem[] {
  const needle = prefix.toLowerCase();
  return values
    .filter((item) => item.value.toLowerCase().includes(needle))
    .map((item) => ({ value: item.value, label: item.value, description: item.description }));
}

function stripCompletionPath(value: string): string {
  let path = value.startsWith("@") ? value.slice(1) : value;
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  return path.replace(/\/$/, "");
}

function isInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function isSafeFileCompletion(cwd: string, item: AutocompleteItem): boolean {
  const candidate = stripCompletionPath(item.value);
  if (!candidate) return true;
  const target = resolve(cwd, candidate);
  if (!isInside(cwd, target) || sensitivePathLabel(relative(cwd, target))) return false;
  try {
    const realTarget = realpathSync(target);
    return isInside(realpathSync(cwd), realTarget) && !sensitivePathLabel(relative(cwd, realTarget));
  } catch {
    return false;
  }
}

function resourceCommands(snapshot: ContextSnapshot): SlashCommand[] {
  const reserved = new Set([
    ...builtinCommands.map((command) => command.name),
    "model",
    "thinking",
    "mode",
    "resources",
    "tree",
    "fork",
  ]);
  const prompts = snapshot.prompts
    .filter((prompt) => !reserved.has(prompt.name))
    .map((prompt) => ({ name: prompt.name, description: prompt.description ?? "Run prompt template" }));
  const skills = snapshot.skills.map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description ?? "Load Skill instructions",
  }));
  return [...prompts, ...skills];
}

function dynamicCommands(options: AutocompleteOptions): SlashCommand[] {
  const completeModels = (prefix: string) => fuzzyItems(
    options.modelRegistry
      .getAvailable()
      .filter((model) => model.provider === DEEPSEEK_PROVIDER)
      .map((model) => ({ value: model.id, description: `${DEEPSEEK_PROVIDER} · ${model.name}` })),
    prefix.replace(/^deepseek\//, ""),
  );
  const completeTree = (prefix: string) => fuzzyItems(
    options.sessionControls.tree().map((item) => ({
      value: item.id,
      description: `${item.isLeaf ? "current · " : ""}${item.preview}`,
    })),
    prefix,
  );
  return [
    ...builtinCommands,
    { name: "model", argumentHint: "[id]", description: "Select a DeepSeek model", getArgumentCompletions: completeModels },
    { name: "thinking", argumentHint: "[level]", description: "Set reasoning effort", getArgumentCompletions: (prefix) => fuzzyItems(options.getThinkingLevels().map((value) => ({ value })), prefix) },
    { name: "mode", argumentHint: "[plan|build]", description: "Switch agent capability boundary", getArgumentCompletions: (prefix) => fuzzyItems(AGENT_MODES.map((value) => ({ value })), prefix) },
    { name: "resources", argumentHint: "[on|off]", description: "Toggle project context resources", getArgumentCompletions: (prefix) => fuzzyItems(["on", "off"].map((value) => ({ value })), prefix) },
    {
      name: "tree",
      argumentHint: "[entry|list]",
      description: "Select, list, or navigate the message tree",
      getArgumentCompletions: (prefix) => [
        ...fuzzyItems([{ value: "list", description: "Print the tree without opening the selector" }], prefix),
        ...completeTree(prefix),
      ],
    },
    { name: "fork", argumentHint: "<entry>", description: "Fork from a message tree entry", getArgumentCompletions: completeTree },
    ...resourceCommands(options.getContextSnapshot()),
  ];
}

class InteractiveAutocompleteProvider implements AutocompleteProvider {
  private readonly options: AutocompleteOptions;

  constructor(options: AutocompleteOptions) {
    this.options = options;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    request: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const provider = new CombinedAutocompleteProvider(dynamicCommands(this.options), this.options.cwd);
    let suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol, request);
    const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const atMatch = beforeCursor.match(/(?:^|\s)(@[^\s]*)$/);
    if (!suggestions && atMatch) {
      const atPrefix = atMatch[1]!;
      const start = cursorCol - atPrefix.length;
      const fallbackLines = [...lines];
      fallbackLines[cursorLine] = `${beforeCursor.slice(0, start)}${atPrefix.slice(1)}${(lines[cursorLine] ?? "").slice(cursorCol)}`;
      const fallback = await provider.getSuggestions(fallbackLines, cursorLine, cursorCol - 1, { ...request, force: true });
      if (fallback) {
        suggestions = {
          prefix: atPrefix,
          items: fallback.items.map((item) => ({ ...item, value: `@${item.value}` })),
        };
      }
    }
    if (!suggestions) return null;
    const isFileContext = request.force || suggestions.prefix.startsWith("@") || !beforeCursor.trimStart().startsWith("/");
    if (!isFileContext) return suggestions;
    const items = suggestions.items.filter((item) => isSafeFileCompletion(this.options.cwd, item));
    return items.length > 0 ? { ...suggestions, items } : null;
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return new CombinedAutocompleteProvider([], this.options.cwd).applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return new CombinedAutocompleteProvider([], this.options.cwd).shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}

export function createInteractiveAutocompleteProvider(options: AutocompleteOptions): AutocompleteProvider {
  return new InteractiveAutocompleteProvider(options);
}
