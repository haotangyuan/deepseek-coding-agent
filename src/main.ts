#!/usr/bin/env node

import {
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  type CreateAgentSessionOptions,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  formatAgentEvent,
  parseCliArgs,
  resolveDeepSeekModel,
  sanitizeError,
  usage,
} from "./cli.ts";
import {
  activeToolsForMode,
  type ApprovalRequest,
  createToolPolicy,
  createToolPolicyExtension,
  type ToolPolicy,
} from "./tool-policy.ts";

type SelectedModel = NonNullable<CreateAgentSessionOptions["model"]>;

interface SessionView {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  dispose(): void;
}

interface SessionFactoryOptions {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: SelectedModel;
  toolPolicy: ToolPolicy;
  tools: string[];
}

export interface CliDependencies {
  cwd: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  createSession(options: SessionFactoryOptions): Promise<{ session: SessionView }>;
  getGitStatus(cwd: string): Promise<{ available: boolean; status: string }>;
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  approve?(request: ApprovalRequest): Promise<boolean>;
}

function productionDependencies(): CliDependencies {
  const cwd = process.cwd();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  return {
    cwd,
    authStorage,
    modelRegistry,
    createSession: async (options) => {
      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        extensionFactories: [createToolPolicyExtension(options.toolPolicy)],
      });
      await resourceLoader.reload();
      return createAgentSession({
        cwd,
        authStorage: options.authStorage,
        modelRegistry: options.modelRegistry,
        model: options.model,
        tools: options.tools,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(cwd),
      });
    },
    getGitStatus: async (targetCwd) => {
      try {
        const { stdout } = await promisify(execFile)("git", ["-C", targetCwd, "status", "--short"], {
          maxBuffer: 1024 * 1024,
        });
        return { available: true, status: stdout.trimEnd() };
      } catch {
        return { available: false, status: "" };
      }
    },
  };
}

const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  approve: async (request) => {
    process.stderr.write(`\n[approval] ${request.summary}\n${sanitizeError(request.preview)}\n`);
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      process.stderr.write("[approval:denied] interactive terminal required\n");
      return false;
    }
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await readline.question("Approve? [y/N] ");
      return /^(?:y|yes)$/i.test(answer.trim());
    } finally {
      readline.close();
    }
  },
};

export async function runCli(
  args: string[],
  io: CliIo = processIo,
  dependencies: CliDependencies = productionDependencies(),
): Promise<number> {
  let parsed;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    io.stderr(`Error: ${sanitizeError(error)}\n${usage()}\n`);
    return 1;
  }

  if (parsed.help) {
    io.stdout(`${usage()}\n`);
    return 0;
  }
  if (!parsed.task) {
    io.stderr(`Error: task text is required\n${usage()}\n`);
    return 1;
  }

  let model: SelectedModel;
  try {
    model = resolveDeepSeekModel(dependencies.modelRegistry, parsed.modelId);
  } catch (error) {
    io.stderr(`Error: ${sanitizeError(error)}\n`);
    return 1;
  }

  let session: SessionView | undefined;
  let wroteText = false;
  let mutatingToolSucceeded = false;
  try {
    const toolPolicy = createToolPolicy({
      cwd: dependencies.cwd,
      mode: parsed.approvalMode,
      approve: io.approve ?? (async () => false),
    });
    const tools = activeToolsForMode(parsed.approvalMode);
    io.stderr(`[policy] mode=${parsed.approvalMode} workspace=${dependencies.cwd}\n`);
    const created = await dependencies.createSession({
      authStorage: dependencies.authStorage,
      modelRegistry: dependencies.modelRegistry,
      model,
      toolPolicy,
      tools,
    });
    session = created.session;
    session.subscribe((event) => {
      if (
        event.type === "tool_execution_end" &&
        !event.isError &&
        (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash")
      ) {
        mutatingToolSucceeded = true;
      }
      for (const record of formatAgentEvent(event)) {
        if (record.channel === "stdout") {
          wroteText = wroteText || record.text.length > 0;
          io.stdout(record.text);
        } else {
          io.stderr(record.text);
        }
      }
    });
    await session.prompt(parsed.task);
    if (wroteText) io.stdout("\n");
    if (mutatingToolSucceeded) {
      const git = await dependencies.getGitStatus(dependencies.cwd);
      io.stderr(git.available ? `[git:status]\n${git.status || "clean"}\n` : "[git:status] unavailable\n");
    }
    return 0;
  } catch (error) {
    io.stderr(`[error] ${sanitizeError(error)}\n`);
    return 1;
  } finally {
    session?.dispose();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exitCode = await runCli(process.argv.slice(2));
}
