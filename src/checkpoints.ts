import {
  generateUnifiedPatch,
  type InlineExtension,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type TurnCheckpointStatus = "empty" | "recording" | "ready" | "undone";

export interface TurnCheckpointSnapshot {
  status: TurnCheckpointStatus;
  files: string[];
  bashObserved: boolean;
  warnings: string[];
}

export interface TurnDiff {
  files: string[];
  patch: string;
  bashObserved: boolean;
  warnings: string[];
}

export interface UndoResult {
  restoredFiles: string[];
}

export interface TurnCheckpointControls {
  snapshot(): TurnCheckpointSnapshot;
  diff(): TurnDiff;
  undo(): Promise<UndoResult>;
}

interface FileState {
  exists: boolean;
  content?: Buffer;
  mode?: number;
  realPath?: string;
}

interface FileCheckpoint {
  path: string;
  displayPath: string;
  before: FileState;
  after: FileState;
}

interface RecordingTurn {
  before: Map<string, { displayPath: string; state: FileState }>;
  bashObserved: boolean;
  warnings: string[];
}

interface CompletedTurn {
  status: "ready" | "undone";
  files: FileCheckpoint[];
  bashObserved: boolean;
  warnings: string[];
}

interface StoredFileState {
  exists: boolean;
  content?: string;
  mode?: number;
  realPath?: string;
}

interface StoredCheckpoint {
  version: 1;
  cwd: string;
  files: Array<{
    path: string;
    before: StoredFileState;
    after: StoredFileState;
  }>;
  bashObserved: boolean;
  warnings: string[];
}

function statesEqual(left: FileState, right: FileState): boolean {
  if (left.exists !== right.exists || left.mode !== right.mode || left.realPath !== right.realPath) return false;
  if (!left.exists) return true;
  return left.content?.equals(right.content ?? Buffer.alloc(0)) ?? false;
}

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function assertInsideWorkspace(cwd: string, inputPath: string): { path: string; displayPath: string } {
  const path = resolve(cwd, inputPath);
  const displayPath = relative(cwd, path);
  if (displayPath === "" || displayPath.startsWith("..") || isAbsolute(displayPath)) {
    throw new Error(`Checkpoint path is outside the workspace: ${inputPath}`);
  }
  return { path, displayPath };
}

async function readState(path: string): Promise<FileState> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`Checkpoint target is not a regular file: ${path}`);
    return {
      exists: true,
      content: await readFile(path),
      mode: metadata.mode & 0o777,
      realPath: await realpath(path),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { exists: false };
    throw error;
  }
}

function encodeState(state: FileState): StoredFileState {
  return {
    exists: state.exists,
    content: state.content?.toString("base64"),
    mode: state.mode,
    realPath: state.realPath,
  };
}

function decodeState(state: StoredFileState): FileState {
  if (!state.exists) return { exists: false };
  if (typeof state.content !== "string" || typeof state.mode !== "number" || typeof state.realPath !== "string") {
    throw new Error("Stored file state is incomplete");
  }
  return { exists: true, content: Buffer.from(state.content, "base64"), mode: state.mode, realPath: state.realPath };
}

export class TurnCheckpointManager implements TurnCheckpointControls {
  private readonly cwd: string;
  private readonly storageFile: string | undefined;
  private recording: RecordingTurn | undefined;
  private completed: CompletedTurn | undefined;

  constructor(cwd: string, storageFile?: string) {
    this.cwd = realpathSync(resolve(cwd));
    this.storageFile = storageFile;
  }

  async load(): Promise<void> {
    if (!this.storageFile) return;
    try {
      const stored = JSON.parse(await readFile(this.storageFile, "utf8")) as StoredCheckpoint;
      if (stored.version !== 1 || resolve(stored.cwd) !== this.cwd || !Array.isArray(stored.files)) {
        throw new Error("Checkpoint metadata does not match this workspace");
      }
      const files = stored.files.map((file) => {
        if (typeof file.path !== "string") throw new Error("Checkpoint file path is invalid");
        const target = assertInsideWorkspace(this.cwd, file.path);
        const before = decodeState(file.before);
        const after = decodeState(file.after);
        if (
          (before.realPath !== undefined && !isInside(this.cwd, before.realPath)) ||
          (after.realPath !== undefined && !isInside(this.cwd, after.realPath))
        ) {
          throw new Error(`Checkpoint target resolves outside the workspace: ${file.path}`);
        }
        return {
          path: target.path,
          displayPath: target.displayPath,
          before,
          after,
        };
      });
      this.completed = {
        status: "ready",
        files,
        bashObserved: stored.bashObserved === true,
        warnings: Array.isArray(stored.warnings) ? stored.warnings.filter((warning) => typeof warning === "string") : [],
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      this.completed = {
        status: "ready",
        files: [],
        bashObserved: false,
        warnings: [`Stored checkpoint could not be loaded: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }

  beginTurn(): void {
    this.recording = { before: new Map(), bashObserved: false, warnings: [] };
  }

  async captureFileBefore(inputPath: string): Promise<void> {
    const recording: RecordingTurn = this.recording ?? { before: new Map(), bashObserved: false, warnings: [] };
    this.recording = recording;
    const target = assertInsideWorkspace(this.cwd, inputPath);
    if (recording.before.has(target.path)) return;
    try {
      const state = await readState(target.path);
      if (state.realPath !== undefined && !isInside(this.cwd, state.realPath)) {
        throw new Error(`Checkpoint target resolves outside the workspace: ${inputPath}`);
      }
      recording.before.set(target.path, { displayPath: target.displayPath, state });
    } catch (error) {
      recording.warnings.push(
        `Could not snapshot ${target.displayPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  observeBash(): void {
    const recording: RecordingTurn = this.recording ?? { before: new Map(), bashObserved: false, warnings: [] };
    this.recording = recording;
    recording.bashObserved = true;
  }

  async finishTurn(): Promise<void> {
    const recording = this.recording;
    this.recording = undefined;
    if (!recording || (recording.before.size === 0 && !recording.bashObserved && recording.warnings.length === 0)) return;

    const files: FileCheckpoint[] = [];
    for (const [path, before] of recording.before) {
      try {
        const after = await readState(path);
        if (after.realPath !== undefined && !isInside(this.cwd, after.realPath)) {
          throw new Error(`Checkpoint target resolves outside the workspace: ${before.displayPath}`);
        }
        if (!statesEqual(before.state, after)) {
          files.push({ path, displayPath: before.displayPath, before: before.state, after });
        }
      } catch (error) {
        recording.warnings.push(
          `Could not finalize ${before.displayPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    files.sort((left, right) => left.displayPath.localeCompare(right.displayPath));
    this.completed = { status: "ready", files, bashObserved: recording.bashObserved, warnings: recording.warnings };
    await this.persist();
  }

  snapshot(): TurnCheckpointSnapshot {
    if (this.recording) {
      return {
        status: "recording",
        files: [...this.recording.before.values()].map((entry) => entry.displayPath).sort(),
        bashObserved: this.recording.bashObserved,
        warnings: [...this.recording.warnings],
      };
    }
    if (!this.completed) return { status: "empty", files: [], bashObserved: false, warnings: [] };
    return {
      status: this.completed.status,
      files: this.completed.files.map((file) => file.displayPath),
      bashObserved: this.completed.bashObserved,
      warnings: [...this.completed.warnings],
    };
  }

  diff(): TurnDiff {
    const completed = this.completed;
    if (!completed || completed.status === "undone") {
      return { files: [], patch: "", bashObserved: false, warnings: [] };
    }
    const patch = completed.files
      .map((file) => generateUnifiedPatch(
        file.displayPath,
        file.before.exists ? file.before.content?.toString("utf8") ?? "" : "",
        file.after.exists ? file.after.content?.toString("utf8") ?? "" : "",
      ).trimEnd())
      .filter(Boolean)
      .join("\n\n");
    return {
      files: completed.files.map((file) => file.displayPath),
      patch,
      bashObserved: completed.bashObserved,
      warnings: [...completed.warnings],
    };
  }

  async undo(): Promise<UndoResult> {
    const completed = this.completed;
    if (!completed || completed.status !== "ready" || completed.files.length === 0) {
      throw new Error("No undoable write/edit changes are available for the latest mutating turn");
    }
    if (completed.warnings.length > 0) {
      throw new Error(`Undo is unavailable because the checkpoint is incomplete: ${completed.warnings.join("; ")}`);
    }

    const conflicts: string[] = [];
    for (const file of completed.files) {
      const current = await readState(file.path);
      if (!statesEqual(current, file.after)) conflicts.push(file.displayPath);
    }
    if (conflicts.length > 0) {
      throw new Error(`Undo refused because files changed after the agent turn: ${conflicts.join(", ")}`);
    }

    for (const file of completed.files) {
      if (!file.before.exists) {
        await rm(file.path, { force: true });
        continue;
      }
      await writeFile(file.path, file.before.content ?? Buffer.alloc(0));
      if (file.before.mode !== undefined) await chmod(file.path, file.before.mode);
    }
    completed.status = "undone";
    if (this.storageFile) await rm(this.storageFile, { force: true });
    return { restoredFiles: completed.files.map((file) => file.displayPath) };
  }

  private async persist(): Promise<void> {
    if (!this.storageFile || !this.completed || this.completed.status !== "ready") return;
    const stored: StoredCheckpoint = {
      version: 1,
      cwd: this.cwd,
      files: this.completed.files.map((file) => ({
        path: file.displayPath,
        before: encodeState(file.before),
        after: encodeState(file.after),
      })),
      bashObserved: this.completed.bashObserved,
      warnings: this.completed.warnings,
    };
    const directory = dirname(this.storageFile);
    const temporary = `${this.storageFile}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.storageFile);
  }
}

export function createTurnCheckpointExtension(manager: TurnCheckpointManager): InlineExtension {
  return {
    name: "deepseek-turn-checkpoint",
    factory: (pi) => {
      pi.on("agent_start", async () => manager.beginTurn());
      pi.on("tool_call", async (event: ToolCallEvent) => {
        if ((event.toolName === "write" || event.toolName === "edit") && typeof event.input.path === "string") {
          await manager.captureFileBefore(event.input.path);
        } else if (event.toolName === "bash") {
          manager.observeBash();
        }
      });
      pi.on("agent_settled", async () => manager.finishTurn());
    },
  };
}
