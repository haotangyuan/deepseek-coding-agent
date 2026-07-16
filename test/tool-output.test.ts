import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseToolOutputCommand,
  readToolOutputPage,
  searchToolOutput,
} from "../src/tool-output.ts";

test("parses toggle, page, and find commands with optional tool ids", () => {
  assert.deepEqual(parseToolOutputCommand(""), { action: "toggle" });
  assert.deepEqual(parseToolOutputCommand("bash-1"), { action: "toggle", target: "bash-1" });
  assert.deepEqual(parseToolOutputCommand("page"), { action: "page", page: 1 });
  assert.deepEqual(parseToolOutputCommand("page 3"), { action: "page", page: 3 });
  assert.deepEqual(parseToolOutputCommand("bash-1 page 2"), { action: "page", target: "bash-1", page: 2 });
  assert.deepEqual(parseToolOutputCommand("find type error"), { action: "find", query: "type error" });
  assert.deepEqual(parseToolOutputCommand("bash-1 find type error"), { action: "find", target: "bash-1", query: "type error" });
  assert.throws(() => parseToolOutputCommand("page 0"), /positive integer/);
  assert.throws(() => parseToolOutputCommand("find"), /search text/);
  assert.throws(() => parseToolOutputCommand("bash-1 unknown"), /usage/);
});

test("pages and searches bounded inline output with stable line numbers", async () => {
  const inline = Array.from({ length: 27 }, (_, index) => index === 16 ? "17 Type ERROR here" : `${index + 1} ok`).join("\n");
  const page = await readToolOutputPage({ inline }, 2);
  assert.equal(page.page, 2);
  assert.equal(page.totalPages, 3);
  assert.deepEqual(page.lines.map((line) => line.number), [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  assert.equal(page.source, "inline");

  const search = await searchToolOutput({ inline }, "type error");
  assert.equal(search.totalMatches, 1);
  assert.deepEqual(search.matches, [{ number: 17, text: "17 Type ERROR here" }]);
  assert.equal(search.source, "inline");
  await assert.rejects(readToolOutputPage({ inline }, 4), /page 4 exceeds 3/);
});

test("streams trusted Pi Bash temp output and rejects non-Pi paths", async () => {
  const fullOutputPath = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
  const symlinkPath = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
  const outside = await mkdtemp(join(tmpdir(), "deepseek-code-output-"));
  try {
    const output = Array.from({ length: 30 }, (_, index) => index === 24 ? "failure on line 25" : `line ${index + 1}`).join("\n");
    await writeFile(fullOutputPath, output);
    const source = { inline: "tail", fullOutputPath, totalLines: 30 };
    const page = await readToolOutputPage(source, 3);
    assert.deepEqual(page.lines.map((line) => line.number), [25, 26, 27, 28, 29, 30]);
    assert.equal(page.source, "pi-bash-temp");
    const search = await searchToolOutput(source, "FAILURE");
    assert.deepEqual(search.matches, [{ number: 25, text: "failure on line 25" }]);

    const fakePath = join(outside, `pi-bash-${randomBytes(8).toString("hex")}.log`);
    await writeFile(fakePath, "must not be read");
    await assert.rejects(readToolOutputPage({ inline: "tail", fullOutputPath: fakePath, totalLines: 2 }, 1), /system temporary directory/);
    await symlink(fullOutputPath, symlinkPath);
    await assert.rejects(readToolOutputPage({ inline: "tail", fullOutputPath: symlinkPath, totalLines: 30 }, 1), /cannot be a symbolic link/);
  } finally {
    await rm(fullOutputPath, { force: true });
    await rm(symlinkPath, { force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("caps visible search matches without losing the total match count", async () => {
  const inline = Array.from({ length: 25 }, (_, index) => `error ${index + 1}`).join("\n");
  const result = await searchToolOutput({ inline }, "error");
  assert.equal(result.totalMatches, 25);
  assert.equal(result.matches.length, 10);
  assert.equal(result.limited, true);
});

test("honors cancellation without returning partial search results", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    searchToolOutput({ inline: "first\nsecond" }, "second", abort.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});
