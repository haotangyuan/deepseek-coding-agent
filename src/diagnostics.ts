import {
  defineTool,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import ts from "typescript";

const MAX_DIAGNOSTICS = 80;
const MAX_MESSAGE_LENGTH = 600;

export interface WorkspaceDiagnostic {
  category: "error" | "warning" | "suggestion" | "message";
  code: number;
  message: string;
  path?: string;
  line?: number;
  column?: number;
}

export interface TypeScriptDiagnosticsReport {
  available: boolean;
  configPath: "tsconfig.json";
  errorCount: number;
  warningCount: number;
  outsideWorkspaceCount: number;
  truncated: boolean;
  diagnostics: WorkspaceDiagnostic[];
  message?: string;
}

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function categoryName(category: ts.DiagnosticCategory): WorkspaceDiagnostic["category"] {
  if (category === ts.DiagnosticCategory.Error) return "error";
  if (category === ts.DiagnosticCategory.Warning) return "warning";
  if (category === ts.DiagnosticCategory.Suggestion) return "suggestion";
  return "message";
}

function normalizeDiagnostic(cwd: string, diagnostic: ts.Diagnostic): WorkspaceDiagnostic | undefined {
  if (diagnostic.file && !isInside(cwd, diagnostic.file.fileName)) return undefined;
  const location = diagnostic.file && diagnostic.start !== undefined
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    : undefined;
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ").slice(0, MAX_MESSAGE_LENGTH);
  return {
    category: categoryName(diagnostic.category),
    code: diagnostic.code,
    message,
    ...(diagnostic.file ? { path: relative(cwd, diagnostic.file.fileName).replaceAll("\\", "/") } : {}),
    ...(location ? { line: location.line + 1, column: location.character + 1 } : {}),
  };
}

export function collectTypeScriptDiagnostics(cwd: string): TypeScriptDiagnosticsReport {
  const root = realpathSync(cwd);
  const configCandidate = join(root, "tsconfig.json");
  if (!existsSync(configCandidate)) {
    return {
      available: false,
      configPath: "tsconfig.json",
      errorCount: 0,
      warningCount: 0,
      outsideWorkspaceCount: 0,
      truncated: false,
      diagnostics: [],
      message: "No workspace-root tsconfig.json was found.",
    };
  }
  const configFile = realpathSync(configCandidate);
  if (!isInside(root, configFile) || !statSync(configFile).isFile()) {
    return {
      available: false,
      configPath: "tsconfig.json",
      errorCount: 0,
      warningCount: 0,
      outsideWorkspaceCount: 0,
      truncated: false,
      diagnostics: [],
      message: "The workspace-root tsconfig.json does not resolve to a regular file inside the workspace.",
    };
  }

  const loaded = ts.readConfigFile(configFile, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config ?? {},
    ts.sys,
    root,
    { noEmit: true, incremental: false, composite: false },
    configFile,
  );
  const rawDiagnostics = loaded.error
    ? [loaded.error]
    : parsed.errors.length > 0
      ? parsed.errors
      : ts.getPreEmitDiagnostics(ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options }));
  const visible = rawDiagnostics
    .map((diagnostic) => normalizeDiagnostic(root, diagnostic))
    .filter((diagnostic): diagnostic is WorkspaceDiagnostic => diagnostic !== undefined);
  const diagnostics = visible.slice(0, MAX_DIAGNOSTICS);
  return {
    available: true,
    configPath: "tsconfig.json",
    errorCount: visible.filter((diagnostic) => diagnostic.category === "error").length,
    warningCount: visible.filter((diagnostic) => diagnostic.category === "warning").length,
    outsideWorkspaceCount: rawDiagnostics.length - visible.length,
    truncated: visible.length > diagnostics.length,
    diagnostics,
  };
}

function formatReport(report: TypeScriptDiagnosticsReport): string {
  if (!report.available) return `TypeScript diagnostics unavailable: ${report.message}`;
  const summary = `TypeScript diagnostics: ${report.errorCount} error${report.errorCount === 1 ? "" : "s"}, ${report.warningCount} warning${report.warningCount === 1 ? "" : "s"}.`;
  const outside = report.outsideWorkspaceCount > 0
    ? `\n${report.outsideWorkspaceCount} outside-workspace diagnostic${report.outsideWorkspaceCount === 1 ? " was" : "s were"} omitted.`
    : "";
  if (report.diagnostics.length === 0) return `${summary}\nNo workspace compiler diagnostics were reported.${outside}`;
  const lines = report.diagnostics.map((diagnostic) => {
    const location = diagnostic.path
      ? `${diagnostic.path}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column ?? 1}` : ""} `
      : "";
    return `${location}TS${diagnostic.code} ${diagnostic.category}: ${diagnostic.message}`;
  });
  if (report.truncated) lines.push(`... additional diagnostics omitted after ${MAX_DIAGNOSTICS} entries.`);
  return `${summary}\n${lines.join("\n")}${outside}`;
}

export function createTypeScriptDiagnosticsTool(cwd: string) {
  return defineTool({
    name: "diagnostics",
    label: "TypeScript diagnostics",
    description:
      "Run read-only TypeScript compiler diagnostics for the workspace-root tsconfig.json. Does not execute project scripts or emit files. Returns bounded file, line, code, and message entries.",
    promptSnippet: "Inspect workspace TypeScript compiler errors without running project scripts",
    promptGuidelines: [
      "Use diagnostics to locate TypeScript compiler errors before broad source searches and after TypeScript edits when validation is needed.",
    ],
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, _params, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const report = collectTypeScriptDiagnostics(cwd);
      if (signal?.aborted) throw new Error("Operation aborted");
      return {
        content: [{ type: "text" as const, text: formatReport(report) }],
        details: report,
      };
    },
  });
}

export function createDiagnosticsExtension(cwd: string): InlineExtension {
  return {
    name: "deepseek-readonly-diagnostics",
    factory: (pi) => {
      pi.registerTool(createTypeScriptDiagnosticsTool(cwd));
    },
  };
}
