import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ValidationSuggestion {
  command: string;
  source: string;
  reason: string;
}

const PACKAGE_SCRIPT_PRIORITY = ["check", "test", "lint", "build"] as const;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function packageSuggestion(cwd: string): Promise<ValidationSuggestion | undefined> {
  const path = join(cwd, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const manifest = parsed as { packageManager?: unknown; scripts?: unknown };
  if (!manifest.scripts || typeof manifest.scripts !== "object") return undefined;
  const scripts = manifest.scripts as Record<string, unknown>;
  const script = PACKAGE_SCRIPT_PRIORITY.find((name) => typeof scripts[name] === "string");
  if (!script) return undefined;

  const declaredManager = typeof manifest.packageManager === "string"
    ? manifest.packageManager.split("@", 1)[0]
    : undefined;
  const manager = declaredManager && ["npm", "pnpm", "yarn", "bun"].includes(declaredManager)
    ? declaredManager
    : "npm";
  return {
    command: `${manager} run ${script}`,
    source: "package.json",
    reason: `highest-priority available package script: ${script}`,
  };
}

export async function discoverValidationSuggestion(cwd: string): Promise<ValidationSuggestion | undefined> {
  const packageResult = await packageSuggestion(cwd);
  if (packageResult) return packageResult;

  const candidates: Array<{ file: string; command: string; reason: string }> = [
    { file: "pyproject.toml", command: "python -m pytest", reason: "Python project manifest detected" },
    { file: "Cargo.toml", command: "cargo test", reason: "Cargo project manifest detected" },
    { file: "go.mod", command: "go test ./...", reason: "Go module detected" },
    { file: "pom.xml", command: "mvn test", reason: "Maven project manifest detected" },
    { file: "gradlew", command: "./gradlew test", reason: "Gradle wrapper detected" },
  ];
  for (const candidate of candidates) {
    if (await isFile(join(cwd, candidate.file))) {
      return { command: candidate.command, source: candidate.file, reason: candidate.reason };
    }
  }
  return undefined;
}

export function createVerificationPrompt(suggestion: ValidationSuggestion): string {
  return [
    "Verify the latest code changes without modifying files.",
    `Run this exact suggested validation command through the Bash tool: ${suggestion.command}`,
    "If that command is not appropriate for the current changes, explain why and stop instead of substituting another command.",
    "Report whether validation passed or failed, with only the shortest useful error summary.",
  ].join("\n");
}
