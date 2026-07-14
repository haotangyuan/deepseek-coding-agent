#!/usr/bin/env node

import {
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  type CreateAgentSessionOptions,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import {
  formatAgentEvent,
  parseCliArgs,
  resolveDeepSeekModel,
  sanitizeError,
  usage,
} from "./cli.ts";

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
}

export interface CliDependencies {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  createSession(options: SessionFactoryOptions): Promise<{ session: SessionView }>;
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

function productionDependencies(): CliDependencies {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  return {
    authStorage,
    modelRegistry,
    createSession: async (options) =>
      createAgentSession({
        authStorage: options.authStorage,
        modelRegistry: options.modelRegistry,
        model: options.model,
        sessionManager: SessionManager.inMemory(),
      }),
  };
}

const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
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
  try {
    const created = await dependencies.createSession({
      authStorage: dependencies.authStorage,
      modelRegistry: dependencies.modelRegistry,
      model,
    });
    session = created.session;
    session.subscribe((event) => {
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
