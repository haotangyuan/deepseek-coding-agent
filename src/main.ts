#!/usr/bin/env node

import {
  type AgentSessionEvent,
  type AgentSession,
  AuthStorage,
  createAgentSession,
  type CreateAgentSessionOptions,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  type SessionStats,
  type SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DEEPSEEK_PROVIDER,
  type DeepSeekThinkingLevel,
  formatAgentEvent,
  parseCliArgs,
  resolveDeepSeekModel,
  sanitizeError,
  usage,
} from "./cli.ts";
import { CacheInspector, formatCacheReport } from "./cache-inspector.ts";
import {
  captureContextSnapshot,
  createProjectResourceFilter,
  type ProjectResourceFilter,
} from "./context-resources.ts";
import { CompletionEvidenceCollector, summarizeCompletionEvidence } from "./completion-evidence.ts";
import { EvaluationMetricsCollector } from "./evaluation.ts";
import { collectDoctorReport, type DoctorReport, renderDoctorReport } from "./doctor.ts";
import { InteractiveMode } from "./interactive.ts";
import {
  createPersistentSessionManager,
  createSessionControls,
  getDeepSeekSessionDir,
  type SessionSelection,
} from "./sessions.ts";
import {
  activeToolsForAgentMode,
  type AgentMode,
  type ApprovalDecision,
  type ApprovalMode,
  type ApprovalRequest,
  createToolPolicy,
  createToolPolicyExtension,
  type ToolPolicy,
} from "./tool-policy.ts";

type SelectedModel = NonNullable<CreateAgentSessionOptions["model"]>;

interface SessionView {
  readonly sessionFile?: string;
  readonly sessionId?: string;
  readonly thinkingLevel?: string;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  getSessionStats(): SessionStats;
  abort?(): Promise<void>;
  dispose(): void;
}

interface SessionFactoryOptions {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: SelectedModel;
  restoreSavedModel: boolean;
  thinkingLevel?: DeepSeekThinkingLevel;
  toolPolicy: ToolPolicy;
  tools: string[];
  sessionSelection: SessionSelection;
  resourceFilter?: ProjectResourceFilter;
}

export function resolveSessionModel(
  modelRegistry: ModelRegistry,
  requestedModel: SelectedModel,
  sessionManager: Pick<SessionManager, "buildSessionContext">,
  restoreSavedModel: boolean,
): SelectedModel {
  if (!restoreSavedModel) return requestedModel;
  const savedModel = sessionManager.buildSessionContext().model;
  if (!savedModel) return requestedModel;
  if (savedModel.provider !== DEEPSEEK_PROVIDER) {
    throw new Error(`Only the ${DEEPSEEK_PROVIDER} provider is allowed`);
  }
  return resolveDeepSeekModel(modelRegistry, savedModel.modelId);
}

export interface CliDependencies {
  cwd: string;
  interactiveTerminal: boolean;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  createSession(options: SessionFactoryOptions): Promise<{ session: SessionView }>;
  runInteractive(options: {
    model: SelectedModel;
    restoreSavedModel: boolean;
    thinkingLevel?: DeepSeekThinkingLevel;
    approvalMode: ApprovalMode;
    agentMode: AgentMode;
    sessionSelection: SessionSelection;
  }): Promise<void>;
  runDoctor(modelId: string): Promise<DoctorReport>;
  getGitStatus(cwd: string): Promise<{ available: boolean; status: string }>;
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  approve?(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface CliRunOptions {
  signal?: AbortSignal;
}

function productionDependencies(): CliDependencies {
  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const sessionDir = getDeepSeekSessionDir(agentDir);
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const getGitStatus = async (targetCwd: string): Promise<{ available: boolean; status: string }> => {
    try {
      const { stdout } = await promisify(execFile)("git", ["-C", targetCwd, "status", "--short"], {
        maxBuffer: 1024 * 1024,
      });
      return { available: true, status: stdout.trimEnd() };
    } catch {
      return { available: false, status: "" };
    }
  };
  const createProductionSession = async (options: SessionFactoryOptions) => {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const sessionManager = await createPersistentSessionManager({
      cwd,
      sessionDir,
      selection: options.sessionSelection,
    });
    const model = resolveSessionModel(options.modelRegistry, options.model, sessionManager, options.restoreSavedModel);
    const resourceFilter = options.resourceFilter ?? createProjectResourceFilter(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      extensionFactories: [createToolPolicyExtension(options.toolPolicy)],
      skillsOverride: resourceFilter.skillsOverride,
      promptsOverride: resourceFilter.promptsOverride,
      agentsFilesOverride: resourceFilter.agentsFilesOverride,
    });
    await resourceLoader.reload();
    const created = await createAgentSession({
      cwd,
      authStorage: options.authStorage,
      modelRegistry: options.modelRegistry,
      model,
      thinkingLevel: options.thinkingLevel,
      tools: options.tools,
      resourceLoader,
      settingsManager,
      sessionManager,
    });
    return { ...created, resourceLoader, resourceFilter, agentDir };
  };
  return {
    cwd,
    interactiveTerminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
    authStorage,
    modelRegistry,
    runDoctor: (modelId) => collectDoctorReport({
      cwd,
      agentDir,
      sessionDir,
      modelRegistry,
      modelId,
      interactiveTerminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
    }),
    createSession: createProductionSession,
    runInteractive: async ({ model, restoreSavedModel, thinkingLevel, approvalMode, agentMode, sessionSelection }) => {
      let approvalHandler: ((request: ApprovalRequest) => Promise<ApprovalDecision>) | undefined;
      const toolPolicy = createToolPolicy({
        cwd,
        mode: approvalMode,
        agentMode,
        approve: (request) => approvalHandler?.(request) ?? Promise.resolve("deny"),
      });
      const resourceFilter = createProjectResourceFilter(cwd, agentDir);
      const created = await createProductionSession({
        authStorage,
        modelRegistry,
        model,
        restoreSavedModel,
        thinkingLevel,
        toolPolicy,
        tools: activeToolsForAgentMode(approvalMode, agentMode),
        sessionSelection,
        resourceFilter,
      });
      const mode = new InteractiveMode({
        session: created.session,
        modelRegistry,
        cwd,
        approvalMode,
        agentMode,
        sessionControls: createSessionControls(created.session, cwd),
        clearContext: () => {
          created.session.sessionManager.resetLeaf();
          created.session.agent.reset();
        },
        getContextSnapshot: () => captureContextSnapshot({
          loader: created.resourceLoader,
          cwd,
          agentDir: created.agentDir,
          projectResourcesEnabled: resourceFilter.isEnabled(),
          effectiveSystemPrompt: created.session.systemPrompt,
          activeTools: created.session.getActiveToolNames(),
        }),
        setProjectResourcesEnabled: async (enabled) => {
          resourceFilter.setEnabled(enabled);
          try {
            await created.session.reload();
          } catch (error) {
            resourceFilter.setEnabled(!enabled);
            await created.session.reload();
            throw error;
          }
        },
        setAgentMode: (nextMode) => {
          created.session.setActiveToolsByName(activeToolsForAgentMode(approvalMode, nextMode));
          toolPolicy.setAgentMode(nextMode);
        },
        getGitStatus,
      });
      approvalHandler = (request) => mode.requestApproval(request);
      try {
        await mode.run();
      } finally {
        created.session.dispose();
      }
    },
    getGitStatus,
  };
}

const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  approve: async (request) => {
    process.stderr.write(`\n[approval] ${request.summary}\n${sanitizeError(request.preview)}\n`);
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      process.stderr.write("[approval:denied] interactive terminal required\n");
      return "deny";
    }
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await readline.question(
        request.sessionApprovalKey ? "Approve? [y] once / [a] exact command for this process / [N] " : "Approve? [y/N] ",
      );
      if (/^(?:y|yes)$/i.test(answer.trim())) return "allow-once";
      if (request.sessionApprovalKey && /^(?:a|always)$/i.test(answer.trim())) return "allow-session";
      return "deny";
    } finally {
      readline.close();
    }
  },
};

export async function runCli(
  args: string[],
  io: CliIo = processIo,
  dependencies: CliDependencies = productionDependencies(),
  runOptions: CliRunOptions = {},
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
  if (parsed.doctor) {
    try {
      const report = await dependencies.runDoctor(parsed.modelId);
      const color = dependencies.interactiveTerminal && process.env.NO_COLOR === undefined;
      io.stdout(renderDoctorReport(report, color, process.stdout.columns ?? 80));
      return report.status === "fail" ? 1 : 0;
    } catch (error) {
      io.stderr(`[doctor:error] ${sanitizeError(error)}\n`);
      return 1;
    }
  }
  let model: SelectedModel;
  try {
    model = resolveDeepSeekModel(dependencies.modelRegistry, parsed.modelId);
  } catch (error) {
    io.stderr(`Error: ${sanitizeError(error)}\n`);
    return 1;
  }

  const restoreSession = parsed.session.type === "continue" || parsed.session.type === "resume";
  const thinkingLevel = parsed.thinkingExplicit || !restoreSession ? parsed.thinkingLevel : undefined;

  if (!parsed.task) {
    if (!dependencies.interactiveTerminal) {
      io.stderr(`Error: task text is required outside an interactive terminal\n${usage()}\n`);
      return 1;
    }
    try {
      await dependencies.runInteractive({
        model,
        restoreSavedModel: !parsed.modelExplicit && restoreSession,
        thinkingLevel,
        approvalMode: parsed.approvalMode,
        agentMode: parsed.agentMode,
        sessionSelection: parsed.session,
      });
      return 0;
    } catch (error) {
      io.stderr(`[error] ${sanitizeError(error)}\n`);
      return 1;
    }
  }

  let session: SessionView | undefined;
  let wroteText = false;
  let mutatingToolSucceeded = false;
  let metrics: EvaluationMetricsCollector | undefined;
  const evidence = new CompletionEvidenceCollector(dependencies.cwd);
  const cacheInspector = new CacheInspector();
  let metricsWritten = false;
  let evidenceWritten = false;
  let cacheWritten = false;
  let abortListener: (() => void) | undefined;
  const writeMetrics = (success: boolean): void => {
    if (!parsed.metrics || !metrics || !session || metricsWritten) return;
    const report = metrics.finish(session.getSessionStats(), success);
    io.stderr(`[metrics] ${JSON.stringify(report)}\n`);
    metricsWritten = true;
  };
  const writeEvidence = (): void => {
    if (evidenceWritten || !session) return;
    const summary = summarizeCompletionEvidence(evidence.snapshot());
    io.stderr(`[evidence]\n${sanitizeError(summary.detail)}\n`);
    if (summary.attention.length > 0) io.stderr(`[evidence:attention] ${sanitizeError(summary.attention.join("; "))}\n`);
    evidenceWritten = true;
  };
  const writeCache = (): void => {
    if (cacheWritten || !session) return;
    const report = cacheInspector.finish(session.getSessionStats());
    io.stderr(`[cache]\n${formatCacheReport(report)}\n`);
    if (report.alert) io.stderr(`[cache:alert] ${report.alert}\n`);
    cacheWritten = true;
  };
  try {
    const toolPolicy = createToolPolicy({
      cwd: dependencies.cwd,
      mode: parsed.approvalMode,
      agentMode: parsed.agentMode,
      approve: io.approve ?? (async () => "deny"),
    });
    const tools = activeToolsForAgentMode(parsed.approvalMode, parsed.agentMode);
    io.stderr(`[policy] agent-mode=${parsed.agentMode} approval=${parsed.approvalMode} workspace=${dependencies.cwd}\n`);
    const created = await dependencies.createSession({
      authStorage: dependencies.authStorage,
      modelRegistry: dependencies.modelRegistry,
      model,
      restoreSavedModel: !parsed.modelExplicit && restoreSession,
      thinkingLevel,
      toolPolicy,
      tools,
      sessionSelection: parsed.session,
    });
    session = created.session;
    if (runOptions.signal?.aborted) throw runOptions.signal.reason;
    if (runOptions.signal) {
      abortListener = () => {
        void session?.abort?.();
      };
      runOptions.signal.addEventListener("abort", abortListener, { once: true });
    }
    metrics = new EvaluationMetricsCollector(model.id, session.thinkingLevel ?? parsed.thinkingLevel);
    cacheInspector.begin(session.getSessionStats());
    session.subscribe((event) => {
      metrics?.observe(event);
      evidence.observe(event);
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
    if (runOptions.signal?.aborted) throw runOptions.signal.reason;
    writeEvidence();
    writeCache();
    writeMetrics(true);
    if (session.sessionId) {
      io.stderr(`[session] id=${session.sessionId} persisted=${session.sessionFile ? "yes" : "no"}\n`);
    }
    if (wroteText) io.stdout("\n");
    if (mutatingToolSucceeded) {
      const git = await dependencies.getGitStatus(dependencies.cwd);
      io.stderr(git.available ? `[git:status]\n${git.status || "clean"}\n` : "[git:status] unavailable\n");
    }
    return 0;
  } catch (error) {
    writeEvidence();
    writeCache();
    writeMetrics(false);
    io.stderr(`[error] ${sanitizeError(error)}\n`);
    return 1;
  } finally {
    if (abortListener) runOptions.signal?.removeEventListener("abort", abortListener);
    session?.dispose();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exitCode = await runCli(process.argv.slice(2));
}
