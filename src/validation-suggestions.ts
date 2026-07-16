import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export const PROJECT_VALIDATION_CONFIG = join(".deepseek-code", "validation.json");

export interface ValidationSuggestion {
  name: string;
  command: string;
  source: string;
  reason: string;
  scope: "project" | "inferred";
}

export interface ValidationDiscoveryOptions {
  projectConfigEnabled?: boolean;
}

const PACKAGE_SCRIPT_PRIORITY = ["check", "test", "lint", "build"] as const;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_COMMANDS = 20;
const MAX_COMMAND_LENGTH = 1000;
const MAX_DESCRIPTION_LENGTH = 200;
const VALID_NAME = /^[a-z0-9][a-z0-9:_-]{0,31}$/;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function configError(message: string): Error {
  return new Error(`Invalid ${PROJECT_VALIDATION_CONFIG}: ${message}`);
}

function parseProjectCommands(parsed: unknown): ValidationSuggestion[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw configError("expected an object");
  }
  const commands = (parsed as { commands?: unknown }).commands;
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > MAX_COMMANDS) {
    throw configError(`commands must contain 1-${MAX_COMMANDS} entries`);
  }

  const names = new Set<string>();
  return commands.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw configError(`commands[${index}] must be an object`);
    }
    const candidate = entry as { name?: unknown; command?: unknown; description?: unknown };
    if (typeof candidate.name !== "string" || !VALID_NAME.test(candidate.name)) {
      throw configError(`commands[${index}].name must match ${VALID_NAME}`);
    }
    if (names.has(candidate.name)) throw configError(`duplicate command name: ${candidate.name}`);
    names.add(candidate.name);
    if (typeof candidate.command !== "string") {
      throw configError(`commands[${index}].command must be a string`);
    }
    const command = candidate.command.trim();
    if (!command || command.length > MAX_COMMAND_LENGTH || /[\r\n\0]/u.test(command)) {
      throw configError(`commands[${index}].command must be a single line of 1-${MAX_COMMAND_LENGTH} characters`);
    }
    if (candidate.description !== undefined
      && (typeof candidate.description !== "string"
        || !candidate.description.trim()
        || candidate.description.length > MAX_DESCRIPTION_LENGTH)) {
      throw configError(`commands[${index}].description must be 1-${MAX_DESCRIPTION_LENGTH} characters`);
    }
    return {
      name: candidate.name,
      command,
      source: PROJECT_VALIDATION_CONFIG,
      reason: typeof candidate.description === "string" ? candidate.description.trim() : `project command: ${candidate.name}`,
      scope: "project" as const,
    };
  });
}

async function projectSuggestions(cwd: string): Promise<ValidationSuggestion[] | undefined> {
  const path = join(cwd, PROJECT_VALIDATION_CONFIG);
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw configError("cannot inspect the file");
  }
  if (!metadata.isFile()) throw configError("expected a regular file");
  if (metadata.size > MAX_CONFIG_BYTES) throw configError(`file exceeds ${MAX_CONFIG_BYTES} bytes`);

  const [root, resolved] = await Promise.all([realpath(cwd), realpath(path)]);
  const location = relative(root, resolved);
  if (!location || location.startsWith("..") || isAbsolute(location)) {
    throw configError("file resolves outside the workspace");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw configError("expected valid JSON");
    throw configError("cannot read the file");
  }
  return parseProjectCommands(parsed);
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
    name: "auto",
    command: `${manager} run ${script}`,
    source: "package.json",
    reason: `highest-priority available package script: ${script}`,
    scope: "inferred",
  };
}

export async function discoverValidationSuggestions(
  cwd: string,
  options: ValidationDiscoveryOptions = {},
): Promise<ValidationSuggestion[]> {
  if (options.projectConfigEnabled) {
    const configured = await projectSuggestions(cwd);
    if (configured) return configured;
  }

  const packageResult = await packageSuggestion(cwd);
  if (packageResult) return [packageResult];

  const candidates: Array<{ file: string; command: string; reason: string }> = [
    { file: "pyproject.toml", command: "python -m pytest", reason: "Python project manifest detected" },
    { file: "Cargo.toml", command: "cargo test", reason: "Cargo project manifest detected" },
    { file: "go.mod", command: "go test ./...", reason: "Go module detected" },
    { file: "pom.xml", command: "mvn test", reason: "Maven project manifest detected" },
    { file: "gradlew", command: "./gradlew test", reason: "Gradle wrapper detected" },
  ];
  for (const candidate of candidates) {
    if (await isFile(join(cwd, candidate.file))) {
      return [{ name: "auto", command: candidate.command, source: candidate.file, reason: candidate.reason, scope: "inferred" }];
    }
  }
  return [];
}

export function createVerificationPrompt(suggestion: ValidationSuggestion): string {
  return [
    "Verify the latest code changes without modifying files.",
    `Run this exact suggested validation command through the Bash tool: ${suggestion.command}`,
    "If that command is not appropriate for the current changes, explain why and stop instead of substituting another command.",
    "Report whether validation passed or failed, with only the shortest useful error summary.",
  ].join("\n");
}
