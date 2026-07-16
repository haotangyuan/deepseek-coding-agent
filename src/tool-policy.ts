import {
  generateDiffString,
  type InlineExtension,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const APPROVAL_MODES = ["ask", "auto-read", "deny"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const AGENT_MODES = ["plan", "build"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export interface ApprovalRequest {
  toolName: "write" | "edit" | "bash";
  summary: string;
  preview: string;
  sessionApprovalKey?: string;
}

export type ApprovalDecision = "allow-once" | "allow-session" | "deny";
export type ApprovalPrompt = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export interface ToolPolicyDecision {
  allowed: boolean;
  reason?: string;
}

export interface ToolPolicy {
  mode: ApprovalMode;
  agentMode: AgentMode;
  setAgentMode(mode: AgentMode): void;
  evaluate(toolName: string, input: Record<string, unknown>): Promise<ToolPolicyDecision>;
}

const READ_ONLY_TOOLS = ["read", "ls", "grep", "diagnostics"] as const;
const SUPPORTED_TOOLS = [...READ_ONLY_TOOLS, "write", "edit", "bash"] as const;
const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);
const SENSITIVE_DIRECTORIES = new Set([".ssh", ".aws", ".gnupg", ".kube", ".secrets"]);
const SENSITIVE_FILES = new Set([
  ".envrc",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials.json",
  "service-account.json",
  "service_account.json",
  "secrets.json",
]);
const PRIVATE_KEY_FILES = new Set(["id_dsa", "id_ecdsa", "id_ed25519", "id_rsa"]);
const MAX_PREVIEW_LENGTH = 4000;

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

async function findExistingAncestor(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export function sensitivePathLabel(path: string): string | undefined {
  const parts = path.replaceAll("\\", "/").split("/").filter((part) => part !== "" && part !== ".");
  const normalized = parts.map((part) => part.toLowerCase());
  const directory = normalized.find((part) => SENSITIVE_DIRECTORIES.has(part));
  if (directory) return directory;

  const fileName = normalized.at(-1);
  if (!fileName) return undefined;
  if (/^\.env(?:\.|$)/.test(fileName) && !/\.(?:example|sample|template)$/.test(fileName)) return fileName;
  if (SENSITIVE_FILES.has(fileName) || PRIVATE_KEY_FILES.has(fileName)) return fileName;
  return undefined;
}

function getSensitiveCommandReason(command: string): string | undefined {
  const candidates = command.match(/[A-Za-z0-9_./${}~-]+/g) ?? [];
  for (const candidate of candidates) {
    const path = candidate.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, "");
    const label = sensitivePathLabel(path);
    if (label) return `Command references protected sensitive path: ${label}`;
  }
  return undefined;
}

async function validateWorkspacePath(cwd: string, inputPath: unknown): Promise<ToolPolicyDecision> {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    return { allowed: false, reason: "Tool path must be a non-empty string" };
  }

  const root = await realpath(cwd);
  const target = resolve(root, inputPath);
  if (!isInside(root, target)) {
    return { allowed: false, reason: `Path is outside the workspace: ${inputPath}` };
  }

  const sensitive = sensitivePathLabel(relative(root, target));
  if (sensitive) {
    return { allowed: false, reason: `Sensitive path is protected: ${sensitive}` };
  }

  const existingTargetOrAncestor = await findExistingAncestor(target);
  if (!isInside(root, existingTargetOrAncestor)) {
    return { allowed: false, reason: `Path resolves outside the workspace: ${inputPath}` };
  }
  return { allowed: true };
}

function truncatePreview(preview: string): string {
  return preview.length <= MAX_PREVIEW_LENGTH
    ? preview
    : `${preview.slice(0, MAX_PREVIEW_LENGTH)}\n...[preview truncated]`;
}

async function readExistingFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

async function buildWriteApproval(cwd: string, input: Record<string, unknown>): Promise<ApprovalRequest> {
  if (typeof input.path !== "string" || typeof input.content !== "string") {
    throw new Error("Invalid write arguments");
  }
  const oldContent = await readExistingFile(resolve(cwd, input.path));
  const { diff } = generateDiffString(oldContent, input.content);
  return {
    toolName: "write",
    summary: `write ${input.path}`,
    preview: truncatePreview(diff || "(no textual changes)"),
  };
}

async function buildEditApproval(cwd: string, input: Record<string, unknown>): Promise<ApprovalRequest> {
  if (typeof input.path !== "string" || !Array.isArray(input.edits)) {
    throw new Error("Invalid edit arguments");
  }
  const original = await readExistingFile(resolve(cwd, input.path));
  const replacements: Array<{ start: number; end: number; newText: string }> = [];
  let exact = true;

  for (const edit of input.edits) {
    if (
      typeof edit !== "object" ||
      edit === null ||
      !("oldText" in edit) ||
      !("newText" in edit) ||
      typeof edit.oldText !== "string" ||
      typeof edit.newText !== "string"
    ) {
      throw new Error("Invalid edit arguments");
    }
    const occurrences = original.split(edit.oldText).length - 1;
    if (edit.oldText === "" || occurrences !== 1) {
      exact = false;
      break;
    }
    const start = original.indexOf(edit.oldText);
    const end = start + edit.oldText.length;
    if (replacements.some((replacement) => start < replacement.end && end > replacement.start)) {
      exact = false;
      break;
    }
    replacements.push({ start, end, newText: edit.newText });
  }

  let previewContent = original;
  if (exact) {
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
      previewContent =
        previewContent.slice(0, replacement.start) + replacement.newText + previewContent.slice(replacement.end);
    }
  }
  const preview = exact
    ? generateDiffString(original, previewContent).diff
    : "Exact preview unavailable; Pi will validate and resolve the requested edits before execution.";
  return {
    toolName: "edit",
    summary: `edit ${input.path} (${input.edits.length} change${input.edits.length === 1 ? "" : "s"})`,
    preview: truncatePreview(preview || "(no textual changes)"),
  };
}

function getBlockedCommandReason(command: string): string | undefined {
  const blockedPatterns: Array<[RegExp, string]> = [
    [/\bgit\s+reset\s+--hard\b/i, "git reset --hard is blocked"],
    [/\bgit\s+clean\b[^\n]*(?:\s(?:-[A-Za-z]*f[A-Za-z]*|--force))(?:\s|$)/i, "git clean with force is blocked"],
    [/\brm\s+(?:-[^\s]*[rf][^\s]*\s+)+(?:--no-preserve-root\s+)?\/(?:\s|$)/i, "recursive deletion of / is blocked"],
    [/\b(?:mkfs|shutdown|reboot|halt|poweroff)\b/i, "system-destructive command is blocked"],
    [/\bdd\b[^\n]*\bof=\/dev\//i, "raw device writes are blocked"],
    [/\bcurl\b[^\n|]*\|\s*(?:sh|bash)\b/i, "piping remote scripts to a shell is blocked"],
    [/\bwget\b[^\n|]*\|\s*(?:sh|bash)\b/i, "piping remote scripts to a shell is blocked"],
    [/^\s*:\(\)\s*\{.*:\s*\|\s*:\s*&/s, "fork bomb pattern is blocked"],
  ];
  return blockedPatterns.find(([pattern]) => pattern.test(command))?.[1];
}

function buildBashApproval(cwd: string, input: Record<string, unknown>): ApprovalRequest {
  if (typeof input.command !== "string" || input.command.trim() === "") {
    throw new Error("Invalid bash arguments");
  }
  return {
    toolName: "bash",
    summary: `bash in ${cwd}`,
    preview: truncatePreview(`${input.command}\n\nBash runs with local user permissions and is not sandboxed.`),
    sessionApprovalKey: input.command,
  };
}

function isSupportedTool(toolName: string): toolName is (typeof SUPPORTED_TOOLS)[number] {
  return SUPPORTED_TOOLS.some((name) => name === toolName);
}

export function activeToolsForMode(mode: ApprovalMode): string[] {
  if (mode === "deny") return [];
  if (mode === "auto-read") return [...READ_ONLY_TOOLS];
  return [...SUPPORTED_TOOLS];
}

export function activeToolsForAgentMode(approvalMode: ApprovalMode, agentMode: AgentMode): string[] {
  if (approvalMode === "deny") return [];
  if (agentMode === "plan") return [...READ_ONLY_TOOLS];
  return activeToolsForMode(approvalMode);
}

export function createToolPolicy(options: {
  cwd: string;
  mode: ApprovalMode;
  agentMode?: AgentMode;
  approve: ApprovalPrompt;
}): ToolPolicy {
  const approvedBashCommands = new Set<string>();
  const policy: ToolPolicy = {
    mode: options.mode,
    agentMode: options.agentMode ?? "build",
    setAgentMode: (mode) => {
      policy.agentMode = mode;
    },
    evaluate: async (toolName, input) => {
      if (!isSupportedTool(toolName)) {
        return { allowed: false, reason: `Unsupported tool: ${toolName}` };
      }
      if (options.mode === "deny") {
        return { allowed: false, reason: "Tool execution is disabled by approval mode deny" };
      }
      if (policy.agentMode === "plan" && MUTATING_TOOLS.has(toolName)) {
        return { allowed: false, reason: `${toolName} is disabled in plan mode` };
      }

      if (toolName === "read" || toolName === "write" || toolName === "edit") {
        const pathDecision = await validateWorkspacePath(options.cwd, input.path);
        if (!pathDecision.allowed) return pathDecision;
      }

      if ((toolName === "ls" || toolName === "grep") && input.path !== undefined) {
        const pathDecision = await validateWorkspacePath(options.cwd, input.path);
        if (!pathDecision.allowed) return pathDecision;
      }

      if (READ_ONLY_TOOLS.some((name) => name === toolName)) return { allowed: true };
      if (options.mode === "auto-read") {
        return { allowed: false, reason: `${toolName} is disabled by approval mode auto-read` };
      }

      try {
        let request: ApprovalRequest;
        if (toolName === "write") {
          request = await buildWriteApproval(options.cwd, input);
        } else if (toolName === "edit") {
          request = await buildEditApproval(options.cwd, input);
        } else {
          if (typeof input.command !== "string") return { allowed: false, reason: "Invalid bash arguments" };
          const sensitiveReason = getSensitiveCommandReason(input.command);
          if (sensitiveReason) return { allowed: false, reason: sensitiveReason };
          const blockedReason = getBlockedCommandReason(input.command);
          if (blockedReason) return { allowed: false, reason: blockedReason };
          if (approvedBashCommands.has(input.command)) return { allowed: true };
          request = buildBashApproval(options.cwd, input);
        }

        const decision = await options.approve(request);
        if (decision === "deny") {
          return { allowed: false, reason: `User rejected ${toolName} tool execution` };
        }
        if (decision === "allow-session" && request.sessionApprovalKey) {
          approvedBashCommands.add(request.sessionApprovalKey);
        }
        return { allowed: true };
      } catch (error) {
        return {
          allowed: false,
          reason: `Could not prepare ${toolName} approval: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
  return policy;
}

export function createToolPolicyExtension(policy: ToolPolicy): InlineExtension {
  return {
    name: "deepseek-tool-policy",
    factory: (pi) => {
      pi.on("tool_call", async (event: ToolCallEvent) => {
        const decision = await policy.evaluate(event.toolName, event.input);
        return decision.allowed ? undefined : { block: true, reason: decision.reason ?? "Tool execution blocked" };
      });
    },
  };
}
