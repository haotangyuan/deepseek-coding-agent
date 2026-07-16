import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";

export interface ToolOutputSource {
  inline: string;
  fullOutputPath?: string;
  totalLines?: number;
}

export interface ToolOutputLine {
  number: number;
  text: string;
}

export interface ToolOutputPage {
  page: number;
  totalPages: number;
  totalLines: number;
  lines: ToolOutputLine[];
  source: "inline" | "pi-bash-temp";
}

export interface ToolOutputSearch {
  query: string;
  totalMatches: number;
  matches: ToolOutputLine[];
  limited: boolean;
  source: "inline" | "pi-bash-temp";
}

export type ToolOutputCommand =
  | { action: "toggle"; target?: string }
  | { action: "page"; target?: string; page: number }
  | { action: "find"; target?: string; query: string };

const PAGE_SIZE = 12;
const SEARCH_LIMIT = 10;
const MAX_SEARCH_LENGTH = 100;
const MAX_LINE_CHARACTERS = 4000;
const MAX_TEMP_FILE_BYTES = 100 * 1024 * 1024;
const PI_BASH_FILE_NAME = /^pi-bash-[a-f0-9]{16}\.log$/u;

function parsePage(value: string | undefined): number {
  if (value === undefined || value === "") return 1;
  const page = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(page) || page < 1) {
    throw new Error("page must be a positive integer");
  }
  return page;
}

function parseFind(query: string | undefined, target?: string): ToolOutputCommand {
  const normalized = query?.trim() ?? "";
  if (!normalized) throw new Error("find requires search text");
  if (normalized.length > MAX_SEARCH_LENGTH || /[\r\n\0]/u.test(normalized)) {
    throw new Error(`search text must be a single line of at most ${MAX_SEARCH_LENGTH} characters`);
  }
  return target ? { action: "find", target, query: normalized } : { action: "find", query: normalized };
}

export function parseToolOutputCommand(argument: string): ToolOutputCommand {
  const value = argument.trim();
  if (!value) return { action: "toggle" };

  const directPage = value.match(/^page(?:\s+(\S+))?$/u);
  if (directPage) return { action: "page", page: parsePage(directPage[1]) };
  if (value === "find") return parseFind(undefined);
  if (value.startsWith("find ")) return parseFind(value.slice(5));

  const targetOnly = value.match(/^(\S+)$/u);
  if (targetOnly) return { action: "toggle", target: targetOnly[1] };
  const targetPage = value.match(/^(\S+)\s+page(?:\s+(\S+))?$/u);
  if (targetPage) return { action: "page", target: targetPage[1], page: parsePage(targetPage[2]) };
  const targetFind = value.match(/^(\S+)\s+find(?:\s+([\s\S]+))?$/u);
  if (targetFind) return parseFind(targetFind[2], targetFind[1]);
  throw new Error("usage: /tool [id] [page <number>|find <text>]");
}

function inlineLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function boundedLine(text: string): string {
  return text.length <= MAX_LINE_CHARACTERS
    ? text
    : `${text.slice(0, MAX_LINE_CHARACTERS)}...[line truncated]`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("tool output view cancelled");
  error.name = "AbortError";
  throw error;
}

async function openPiBashOutput(path: string): Promise<FileHandle> {
  if (!PI_BASH_FILE_NAME.test(basename(path))) throw new Error("full output is not a recognized Pi Bash log");
  let fileInfo;
  try {
    fileInfo = await lstat(path);
  } catch {
    throw new Error("Pi Bash full output is no longer available");
  }
  if (fileInfo.isSymbolicLink()) throw new Error("Pi Bash full output cannot be a symbolic link");
  if (!fileInfo.isFile()) throw new Error("Pi Bash full output is not a regular file");

  const [resolvedRoot, resolvedPath] = await Promise.all([realpath(tmpdir()), realpath(path)]);
  if (dirname(resolvedPath) !== resolvedRoot || !PI_BASH_FILE_NAME.test(basename(resolvedPath))) {
    throw new Error("Pi Bash full output must stay in the system temporary directory");
  }
  let file: FileHandle | undefined;
  try {
    file = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("Pi Bash full output is not a regular file");
    if (metadata.size > MAX_TEMP_FILE_BYTES) {
      throw new Error(`Pi Bash full output exceeds the ${MAX_TEMP_FILE_BYTES / 1024 / 1024} MiB viewer limit`);
    }
    return file;
  } catch (error) {
    await file?.close();
    throw error;
  }
}

async function *streamLines(source: ToolOutputSource, signal?: AbortSignal): AsyncGenerator<string> {
  throwIfAborted(signal);
  if (!source.fullOutputPath) {
    for (const line of inlineLines(source.inline)) {
      throwIfAborted(signal);
      yield line;
    }
    return;
  }

  const file = await openPiBashOutput(source.fullOutputPath);
  const input = file.createReadStream({ encoding: "utf8", autoClose: false, signal });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      throwIfAborted(signal);
      yield line;
    }
  } finally {
    lines.close();
    input.destroy();
    await file.close();
  }
}

function outputSource(source: ToolOutputSource): "inline" | "pi-bash-temp" {
  return source.fullOutputPath ? "pi-bash-temp" : "inline";
}

function totalOutputLines(source: ToolOutputSource): number {
  if (!source.fullOutputPath) return inlineLines(source.inline).length;
  if (!Number.isSafeInteger(source.totalLines) || (source.totalLines ?? 0) < 1) {
    throw new Error("Pi Bash truncation metadata does not include a valid total line count");
  }
  return source.totalLines!;
}

export async function readToolOutputPage(source: ToolOutputSource, page: number, signal?: AbortSignal): Promise<ToolOutputPage> {
  if (!Number.isInteger(page) || page < 1) throw new Error("page must be a positive integer");
  const totalLines = totalOutputLines(source);
  const totalPages = Math.max(1, Math.ceil(totalLines / PAGE_SIZE));
  if (page > totalPages) throw new Error(`page ${page} exceeds ${totalPages}`);
  const start = (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(start + PAGE_SIZE - 1, totalLines);
  const visible: ToolOutputLine[] = [];
  let lineNumber = 0;
  for await (const line of streamLines(source, signal)) {
    lineNumber += 1;
    if (lineNumber >= start && lineNumber <= end) visible.push({ number: lineNumber, text: boundedLine(line) });
    if (lineNumber >= end) break;
  }
  if (visible.length === 0 && totalLines > 0) throw new Error("full output ended before the requested page");
  return { page, totalPages, totalLines, lines: visible, source: outputSource(source) };
}

export async function searchToolOutput(source: ToolOutputSource, query: string, signal?: AbortSignal): Promise<ToolOutputSearch> {
  const normalized = parseFind(query);
  if (normalized.action !== "find") throw new Error("invalid search query");
  const needle = normalized.query.toLowerCase();
  const matches: ToolOutputLine[] = [];
  let totalMatches = 0;
  let lineNumber = 0;
  for await (const line of streamLines(source, signal)) {
    lineNumber += 1;
    if (!line.toLowerCase().includes(needle)) continue;
    totalMatches += 1;
    if (matches.length < SEARCH_LIMIT) matches.push({ number: lineNumber, text: boundedLine(line) });
  }
  return {
    query: normalized.query,
    totalMatches,
    matches,
    limited: totalMatches > matches.length,
    source: outputSource(source),
  };
}
