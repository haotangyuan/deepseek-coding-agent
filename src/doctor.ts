import {
  DefaultResourceLoader,
  type ModelRegistry,
  SettingsManager,
  VERSION as PI_SDK_VERSION,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { promisify } from "node:util";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  detail: string;
}

export interface DoctorProbe {
  productVersion: string;
  sdkVersion: string;
  cwd: string;
  modelId: string;
  nodeVersion: string;
  minimumNodeVersion: string;
  modelExists: boolean;
  authConfigured: boolean;
  gitAvailable: boolean;
  gitRepository: boolean;
  gitDirty: boolean;
  rgAvailable: boolean;
  fdAvailable: boolean;
  sessionWritable: boolean;
  interactiveTerminal: boolean;
  resources: {
    agents: number;
    skills: number;
    prompts: number;
    diagnostics: number;
  };
}

export interface DoctorReport {
  status: DoctorCheckStatus;
  productVersion: string;
  sdkVersion: string;
  cwd: string;
  modelId: string;
  checks: DoctorCheck[];
}

interface ProductPackage {
  version?: string;
  engines?: { node?: string };
}

function parseVersion(version: string): number[] {
  return version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = parseVersion(actual);
  const minimumParts = parseVersion(minimum);
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const actualPart = actualParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;
    if (actualPart !== minimumPart) return actualPart > minimumPart;
  }
  return true;
}

function overallStatus(checks: DoctorCheck[]): DoctorCheckStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

export function buildDoctorReport(probe: DoctorProbe): DoctorReport {
  const checks: DoctorCheck[] = [
    {
      id: "runtime",
      label: "Runtime",
      status: versionAtLeast(probe.nodeVersion, probe.minimumNodeVersion) ? "pass" : "fail",
      detail: `Node ${probe.nodeVersion} · requires >=${probe.minimumNodeVersion}`,
    },
    {
      id: "model",
      label: "DeepSeek model",
      status: probe.modelExists ? "pass" : "fail",
      detail: probe.modelExists ? `${probe.modelId} is in the Pi catalog` : `${probe.modelId} is not in the Pi catalog`,
    },
    {
      id: "auth",
      label: "Credentials",
      status: probe.authConfigured ? "pass" : "fail",
      detail: probe.authConfigured ? "DeepSeek credential is configured (value hidden)" : "DEEPSEEK_API_KEY is not configured",
    },
    {
      id: "git",
      label: "Git workspace",
      status: probe.gitAvailable && probe.gitRepository ? "pass" : "warn",
      detail: !probe.gitAvailable
        ? "git is unavailable; diff and workspace status are limited"
        : probe.gitRepository
          ? probe.gitDirty ? "repository detected · working tree has changes" : "repository detected · working tree clean"
          : "current directory is not a Git repository",
    },
    {
      id: "rg",
      label: "Repository search",
      status: probe.rgAvailable ? "pass" : "warn",
      detail: probe.rgAvailable
        ? "ripgrep is available"
        : "ripgrep is unavailable locally; Pi may need a first-use download",
    },
    {
      id: "fd",
      label: "File discovery",
      status: probe.fdAvailable ? "pass" : "warn",
      detail: probe.fdAvailable ? "fd is available" : "fd is unavailable; optional find remains disabled",
    },
    {
      id: "sessions",
      label: "Session storage",
      status: probe.sessionWritable ? "pass" : "fail",
      detail: probe.sessionWritable ? "session directory is writable" : "session directory cannot be created or written",
    },
    {
      id: "terminal",
      label: "Terminal UI",
      status: probe.interactiveTerminal ? "pass" : "warn",
      detail: probe.interactiveTerminal ? "interactive TTY and color UI available" : "non-interactive output; one-shot tasks only",
    },
    {
      id: "resources",
      label: "Context resources",
      status: probe.resources.diagnostics === 0 ? "pass" : "warn",
      detail: `AGENTS ${probe.resources.agents} · skills ${probe.resources.skills} · prompts ${probe.resources.prompts} · diagnostics ${probe.resources.diagnostics}`,
    },
  ];
  return {
    status: overallStatus(checks),
    productVersion: probe.productVersion,
    sdkVersion: probe.sdkVersion,
    cwd: probe.cwd,
    modelId: probe.modelId,
    checks,
  };
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  blue: "\u001b[38;2;54;112;255m",
  cyan: "\u001b[38;2;91;226;210m",
  green: "\u001b[38;2;100;220;170m",
  amber: "\u001b[38;2;250;190;80m",
  red: "\u001b[38;2;255;105;120m",
  muted: "\u001b[38;2;135;155;180m",
} as const;

function paint(text: string, color: keyof typeof ANSI, enabled: boolean): string {
  return enabled ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

function compactPath(path: string, width: number): string {
  const available = Math.max(20, width - 4);
  return path.length <= available ? path : `…${path.slice(-(available - 1))}`;
}

export function renderDoctorReport(report: DoctorReport, color: boolean, width = 100): string {
  const icon = (status: DoctorCheckStatus): string => status === "pass" ? "✓" : status === "warn" ? "!" : "×";
  const tone = (status: DoctorCheckStatus): keyof typeof ANSI => status === "pass" ? "green" : status === "warn" ? "amber" : "red";
  const counts = {
    pass: report.checks.filter((check) => check.status === "pass").length,
    warn: report.checks.filter((check) => check.status === "warn").length,
    fail: report.checks.filter((check) => check.status === "fail").length,
  };
  const summary = report.status === "pass"
    ? "Ready"
    : report.status === "warn"
      ? `Ready with ${counts.warn} warning${counts.warn === 1 ? "" : "s"}`
      : `Blocked by ${counts.fail} failed check${counts.fail === 1 ? "" : "s"}`;
  const lines = [
    `${paint("◆", "cyan", color)} ${paint("DeepSeek Code Doctor", "blue", color)}`,
    `  ${paint(`v${report.productVersion} · Pi SDK ${report.sdkVersion} · offline checks only`, "muted", color)}`,
    "",
    ...report.checks.map((check) => `  ${paint(icon(check.status), tone(check.status), color)} ${paint(check.label.padEnd(19), "bold", color)} ${check.detail}`),
    "",
    `  ${paint(summary, tone(report.status), color)} ${paint(`· model ${report.modelId}`, "muted", color)}`,
    `  ${paint(compactPath(report.cwd, width), "muted", color)}`,
  ];
  return `${lines.join("\n")}\n`;
}

async function commandAvailable(command: string, args: string[]): Promise<boolean> {
  try {
    await promisify(execFile)(command, args, { timeout: 3000, maxBuffer: 64 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function managedOrSystemTool(agentDir: string, name: "rg" | "fd"): Promise<boolean> {
  const suffix = process.platform === "win32" ? ".exe" : "";
  try {
    await access(join(agentDir, "bin", `${name}${suffix}`), fsConstants.X_OK);
    return true;
  } catch {
    if (name === "fd" && await commandAvailable("fdfind", ["--version"])) return true;
    return commandAvailable(name, ["--version"]);
  }
}

async function writableAncestor(target: string): Promise<boolean> {
  let current = target;
  const root = parse(target).root;
  while (true) {
    try {
      if ((await stat(current)).isDirectory()) {
        await access(current, fsConstants.W_OK);
        return true;
      }
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      if (current === root) return false;
      current = dirname(current);
    }
  }
}

export async function collectDoctorReport(options: {
  cwd: string;
  agentDir: string;
  sessionDir: string;
  modelRegistry: ModelRegistry;
  modelId: string;
  interactiveTerminal: boolean;
}): Promise<DoctorReport> {
  const packageData = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as ProductPackage;
  const minimumNodeVersion = packageData.engines?.node?.replace(/^\s*>=\s*/, "") || "22.19.0";
  const model = options.modelRegistry.find("deepseek", options.modelId);
  const authModel = model ?? options.modelRegistry.getAll().find((candidate) => candidate.provider === "deepseek");
  const gitAvailable = await commandAvailable("git", ["--version"]);
  let gitRepository = false;
  let gitDirty = false;
  if (gitAvailable) {
    try {
      const { stdout } = await promisify(execFile)("git", ["-C", options.cwd, "rev-parse", "--is-inside-work-tree"], {
        timeout: 3000,
        maxBuffer: 64 * 1024,
      });
      gitRepository = stdout.trim() === "true";
      if (gitRepository) {
        const statusResult = await promisify(execFile)("git", ["-C", options.cwd, "status", "--short"], {
          timeout: 3000,
          maxBuffer: 1024 * 1024,
        });
        gitDirty = statusResult.stdout.trim().length > 0;
      }
    } catch {
      gitRepository = false;
    }
  }

  let resourceCounts = { agents: 0, skills: 0, prompts: 0, diagnostics: 0 };
  try {
    const previousOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
    try {
      const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
      const resourceLoader = new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir: options.agentDir,
        settingsManager,
        noExtensions: true,
      });
      await resourceLoader.reload();
      const agents = resourceLoader.getAgentsFiles().agentsFiles;
      const skills = resourceLoader.getSkills();
      const prompts = resourceLoader.getPrompts();
      resourceCounts = {
        agents: agents.length,
        skills: skills.skills.length,
        prompts: prompts.prompts.length,
        diagnostics: skills.diagnostics.length + prompts.diagnostics.length,
      };
    } finally {
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
    }
  } catch {
    resourceCounts.diagnostics = 1;
  }

  return buildDoctorReport({
    productVersion: packageData.version ?? "unknown",
    sdkVersion: PI_SDK_VERSION,
    cwd: options.cwd,
    modelId: options.modelId,
    nodeVersion: process.versions.node,
    minimumNodeVersion,
    modelExists: model !== undefined,
    authConfigured: authModel !== undefined && options.modelRegistry.hasConfiguredAuth(authModel),
    gitAvailable,
    gitRepository,
    gitDirty,
    rgAvailable: await managedOrSystemTool(options.agentDir, "rg"),
    fdAvailable: await managedOrSystemTool(options.agentDir, "fd"),
    sessionWritable: await writableAncestor(options.sessionDir),
    interactiveTerminal: options.interactiveTerminal,
    resources: resourceCounts,
  });
}
