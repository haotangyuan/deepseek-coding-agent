import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { relative, resolve } from "node:path";

export type ValidationStatus = "passed" | "failed";

export interface ValidationEvidence {
  name: string;
  status: ValidationStatus;
}

export interface CompletionEvidence {
  changedFiles: string[];
  diffReviewed: boolean;
  checks: ValidationEvidence[];
  bashCommandsObserved: number;
  toolErrorsObserved: number;
  providerErrorUnresolved: boolean;
}

export interface CompletionEvidenceSummary {
  detail: string;
  attention: string[];
}

interface PendingToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

const VALIDATION_COMMANDS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /^npm\s+(?:run\s+)?test(?:\s|$)/, name: "npm test" },
  { pattern: /^npm\s+run\s+check(?:\s|$)/, name: "npm run check" },
  { pattern: /^npm\s+run\s+build(?:\s|$)/, name: "npm run build" },
  { pattern: /^(?:pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)/, name: "package test" },
  { pattern: /^(?:pnpm|yarn|bun)\s+(?:run\s+)?(?:check|lint)(?:\s|$)/, name: "package check" },
  { pattern: /^(?:pnpm|yarn|bun)\s+(?:run\s+)?build(?:\s|$)/, name: "package build" },
  { pattern: /^(?:npx\s+)?tsc(?:\s|$)/, name: "TypeScript check" },
  { pattern: /^(?:python(?:3)?\s+-m\s+)?pytest(?:\s|$)/, name: "pytest" },
  { pattern: /^(?:python(?:3)?\s+-m\s+)?ruff\s+check(?:\s|$)/, name: "ruff check" },
  { pattern: /^cargo\s+test(?:\s|$)/, name: "cargo test" },
  { pattern: /^go\s+test(?:\s|$)/, name: "go test" },
  { pattern: /^(?:mvn|\.\/mvnw)\s+test(?:\s|$)/, name: "maven test" },
  { pattern: /^\.\/gradlew\s+(?:\S+\s+)*test(?:\s|$)/, name: "gradle test" },
  { pattern: /^git\s+diff\s+--check(?:\s|$)/, name: "git diff --check" },
];

function shellSegments(command: string): string[] {
  return command
    .split(/&&|;|\n/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.replace(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, ""));
}

function validationNames(command: string): string[] {
  const names = new Set<string>();
  for (const segment of shellSegments(command)) {
    const match = VALIDATION_COMMANDS.find(({ pattern }) => pattern.test(segment));
    if (match) names.add(match.name);
  }
  return [...names];
}

function reviewsDiff(command: string): boolean {
  return shellSegments(command).some((segment) => {
    if (!/^git\s+diff(?:\s|$)/.test(segment)) return false;
    return !/\s--(?:check|stat|shortstat|numstat|name-only|name-status)(?:\s|$)/.test(segment);
  });
}

function displayFile(cwd: string, inputPath: unknown): string | undefined {
  if (typeof inputPath !== "string" || inputPath.trim() === "") return undefined;
  const path = relative(cwd, resolve(cwd, inputPath));
  return path || ".";
}

export class CompletionEvidenceCollector {
  private readonly cwd: string;
  private readonly pendingTools = new Map<string, PendingToolCall>();
  private readonly changedFiles = new Set<string>();
  private readonly checks = new Map<string, ValidationStatus>();
  private diffReviewed = false;
  private bashCommandsObserved = 0;
  private toolErrorsObserved = 0;
  private providerErrorUnresolved = false;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  reset(): void {
    this.pendingTools.clear();
    this.changedFiles.clear();
    this.checks.clear();
    this.diffReviewed = false;
    this.bashCommandsObserved = 0;
    this.toolErrorsObserved = 0;
    this.providerErrorUnresolved = false;
  }

  observe(event: AgentSessionEvent): void {
    if (event.type === "tool_execution_start") {
      this.pendingTools.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      return;
    }
    if (event.type === "tool_execution_end") {
      const pending = this.pendingTools.get(event.toolCallId);
      this.pendingTools.delete(event.toolCallId);
      if (event.isError) this.toolErrorsObserved += 1;
      if (!pending) return;

      if (!event.isError && (pending.toolName === "write" || pending.toolName === "edit")) {
        const file = displayFile(this.cwd, pending.args.path);
        if (file) this.changedFiles.add(file);
      }
      if (pending.toolName === "bash") {
        this.bashCommandsObserved += 1;
        const command = typeof pending.args.command === "string" ? pending.args.command : "";
        const names = validationNames(command);
        if (names.length === 1) {
          this.checks.set(names[0]!, event.isError ? "failed" : "passed");
        } else if (names.length > 1) {
          if (event.isError) this.checks.set("combined validation", "failed");
          else for (const name of names) this.checks.set(name, "passed");
        }
        if (!event.isError && reviewsDiff(command)) this.diffReviewed = true;
      }
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      this.providerErrorUnresolved = event.message.stopReason === "error";
      return;
    }
    if (event.type === "auto_retry_end") {
      this.providerErrorUnresolved = !event.success;
    }
  }

  snapshot(): CompletionEvidence {
    return {
      changedFiles: [...this.changedFiles].sort(),
      diffReviewed: this.diffReviewed,
      checks: [...this.checks].map(([name, status]) => ({ name, status })),
      bashCommandsObserved: this.bashCommandsObserved,
      toolErrorsObserved: this.toolErrorsObserved,
      providerErrorUnresolved: this.providerErrorUnresolved,
    };
  }
}

export function summarizeCompletionEvidence(evidence: CompletionEvidence): CompletionEvidenceSummary {
  const files = evidence.changedFiles.length > 0 ? evidence.changedFiles.join(", ") : "none recorded";
  const checks = evidence.checks.length > 0
    ? evidence.checks.map((check) => `${check.name}:${check.status}`).join(", ")
    : "none recognized";
  const attention: string[] = [];
  if (evidence.changedFiles.length > 0 && !evidence.diffReviewed) attention.push("recorded changes were not reviewed with git diff");
  if (evidence.changedFiles.length > 0 && evidence.checks.length === 0) attention.push("no recognized validation followed recorded changes");
  const failedChecks = evidence.checks.filter((check) => check.status === "failed").map((check) => check.name);
  if (failedChecks.length > 0) attention.push(`latest validation failed: ${failedChecks.join(", ")}`);
  if (evidence.providerErrorUnresolved) attention.push("provider error was not observed recovering");

  return {
    detail: [
      `files=${files}`,
      `diff=${evidence.diffReviewed ? "reviewed" : "not reviewed"}`,
      `checks=${checks}`,
      `bash=${evidence.bashCommandsObserved} · tool-errors=${evidence.toolErrorsObserved}`,
    ].join("\n"),
    attention,
  };
}
