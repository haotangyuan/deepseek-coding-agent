import {
  type CompactionResult,
  type SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export type SessionSelection =
  | { type: "new" }
  | { type: "continue" }
  | { type: "resume"; target: string };

export interface SessionSummary {
  id: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  cwd: string;
  model?: string;
  path: string;
}

export interface SessionTreeItem {
  id: string;
  parentId: string | null;
  depth: number;
  type: string;
  preview: string;
  isLeaf: boolean;
}

export interface SessionSnapshot {
  id: string;
  name?: string;
  file?: string;
  persisted: boolean;
  autoCompaction: boolean;
  compacting: boolean;
}

export interface SessionControls {
  snapshot(): SessionSnapshot;
  list(): Promise<SessionSummary[]>;
  setName(name: string): void;
  compact(instructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;
  tree(): SessionTreeItem[];
  navigate(entryId: string): Promise<{ cancelled: boolean; editorText?: string }>;
  fork(entryId: string): { id: string; file: string };
  clone(): { id: string; file: string };
}

interface ControllableSession {
  readonly sessionId: string;
  readonly sessionName: string | undefined;
  readonly sessionFile: string | undefined;
  readonly autoCompactionEnabled: boolean;
  readonly isCompacting: boolean;
  readonly sessionManager: SessionManager;
  setSessionName(name: string): void;
  compact(instructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;
  navigateTree(entryId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean; editorText?: string }>;
}

export function getDeepSeekSessionDir(agentDir: string): string {
  return join(agentDir, "deepseek-code-sessions");
}

function isPathTarget(target: string): boolean {
  return isAbsolute(target) || target.includes("/") || target.includes("\\") || target.endsWith(".jsonl");
}

export async function createPersistentSessionManager(options: {
  cwd: string;
  sessionDir: string;
  selection: SessionSelection;
}): Promise<SessionManager> {
  if (options.selection.type === "new") return SessionManager.create(options.cwd, options.sessionDir);
  if (options.selection.type === "continue") return SessionManager.continueRecent(options.cwd, options.sessionDir);

  const target = options.selection.target;
  let sessionPath: string;
  if (isPathTarget(target)) {
    sessionPath = resolve(options.cwd, target);
  } else {
    const sessions = await SessionManager.list(options.cwd, options.sessionDir);
    const exact = sessions.find((session) => session.id === target);
    const prefixMatches = sessions.filter((session) => session.id.startsWith(target));
    if (!exact && prefixMatches.length > 1) {
      throw new Error(`Session ID prefix is ambiguous: ${target}`);
    }
    const match = exact ?? prefixMatches[0];
    if (!match) throw new Error(`No session found in this workspace: ${target}`);
    sessionPath = match.path;
  }

  const manager = SessionManager.open(sessionPath, options.sessionDir);
  const pathFromCwd = relative(resolve(options.cwd), resolve(manager.getCwd()));
  if (pathFromCwd !== "") {
    throw new Error(`Session belongs to a different workspace: ${manager.getCwd()}`);
  }
  return manager;
}

function messagePreview(entry: ReturnType<SessionManager["getEntries"]>[number]): string {
  if (entry.type !== "message") return entry.type;
  if (!("content" in entry.message)) return entry.message.role;
  const content = entry.message.content;
  const text = typeof content === "string"
    ? content
    : content.flatMap((part) => part.type === "text" && "text" in part ? [part.text] : []).join(" ");
  const compact = text.replace(/\s+/g, " ").trim();
  return `${entry.message.role}: ${compact || "(empty)"}`.slice(0, 100);
}

function resolveEntryId(manager: SessionManager, target: string): string {
  if (manager.getEntry(target)) return target;
  const matches = manager.getEntries().filter((entry) => entry.id.startsWith(target));
  if (matches.length === 0) throw new Error(`Unknown session entry: ${target}`);
  if (matches.length > 1) throw new Error(`Session entry prefix is ambiguous: ${target}`);
  return matches[0]!.id;
}

export function createSessionControls(session: ControllableSession, cwd: string): SessionControls {
  const manager = session.sessionManager;
  return {
    snapshot: () => ({
      id: session.sessionId,
      name: session.sessionName,
      file: session.sessionFile,
      persisted: manager.isPersisted(),
      autoCompaction: session.autoCompactionEnabled,
      compacting: session.isCompacting,
    }),
    list: async () => {
      const sessions = await SessionManager.list(cwd, manager.getSessionDir());
      return sessions.map((info) => {
        const model = SessionManager.open(info.path, manager.getSessionDir()).buildSessionContext().model;
        return { ...info, model: model ? `${model.provider}/${model.modelId}` : undefined };
      });
    },
    setName: (name) => session.setSessionName(name),
    compact: (instructions) => session.compact(instructions),
    abortCompaction: () => session.abortCompaction(),
    tree: () => {
      const leafId = manager.getLeafId();
      const items: SessionTreeItem[] = [];
      const visit = (nodes: ReturnType<SessionManager["getTree"]>, depth: number): void => {
        for (const node of nodes) {
          items.push({
            id: node.entry.id,
            parentId: node.entry.parentId,
            depth,
            type: node.entry.type,
            preview: node.label ?? messagePreview(node.entry),
            isLeaf: node.entry.id === leafId,
          });
          visit(node.children, depth + 1);
        }
      };
      visit(manager.getTree(), 0);
      return items;
    },
    navigate: (entryId) => session.navigateTree(resolveEntryId(manager, entryId), { summarize: false }),
    fork: (entryId) => {
      const source = manager.getSessionFile();
      if (!source) throw new Error("Current session is not persisted");
      const forked = SessionManager.open(source, manager.getSessionDir());
      const file = forked.createBranchedSession(resolveEntryId(forked, entryId));
      if (!file || !existsSync(file)) {
        throw new Error("Fork point must include a completed assistant response");
      }
      return { id: forked.getSessionId(), file };
    },
    clone: () => {
      const source = manager.getSessionFile();
      if (!source) throw new Error("Current session is not persisted");
      const cloned = SessionManager.forkFrom(source, cwd, manager.getSessionDir());
      const file = cloned.getSessionFile();
      if (!file) throw new Error("Failed to persist cloned session");
      return { id: cloned.getSessionId(), file };
    },
  };
}

export function sessionDisplayName(session: Pick<SessionInfo, "name" | "firstMessage" | "id">): string {
  return session.name?.trim() || session.firstMessage.trim().slice(0, 60) || session.id;
}

export function sessionFileName(path: string | undefined): string {
  return path ? basename(path) : "memory";
}
