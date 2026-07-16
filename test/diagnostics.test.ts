import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  collectTypeScriptDiagnostics,
  createTypeScriptDiagnosticsTool,
} from "../src/diagnostics.ts";

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "deepseek-diagnostics-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("typescript diagnostics reports workspace errors without emitting files", async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "ESNext" },
      include: ["src/**/*.ts"],
    }));
    await writeFile(join(workspace, "src", "value.ts"), "export const value: string = 42;\n");

    const report = collectTypeScriptDiagnostics(workspace);
    assert.equal(report.available, true);
    assert.equal(report.errorCount, 1);
    assert.equal(report.truncated, false);
    assert.equal(report.diagnostics[0]?.code, 2322);
    assert.equal(report.diagnostics[0]?.path, "src/value.ts");
    assert.equal(report.diagnostics[0]?.line, 1);
    await assert.rejects(() => import("node:fs/promises").then(({ access }) => access(join(workspace, "src", "value.js"))));
  });
});

test("typescript diagnostics handles clean and unsupported workspaces", async () => {
  await withWorkspace(async (workspace) => {
    assert.deepEqual(collectTypeScriptDiagnostics(workspace), {
      available: false,
      configPath: "tsconfig.json",
      errorCount: 0,
      warningCount: 0,
      outsideWorkspaceCount: 0,
      truncated: false,
      diagnostics: [],
      message: "No workspace-root tsconfig.json was found.",
    });

    await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({ files: ["ok.ts"] }));
    await writeFile(join(workspace, "ok.ts"), "export const ok: number = 1;\n");
    const clean = collectTypeScriptDiagnostics(workspace);
    assert.equal(clean.available, true);
    assert.equal(clean.errorCount, 0);
    assert.equal(clean.warningCount, 0);
    assert.deepEqual(clean.diagnostics, []);
  });
});

test("typescript diagnostics rejects a root config symlink that escapes the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-diagnostics-link-"));
  const workspace = join(root, "workspace");
  try {
    await mkdir(workspace);
    await writeFile(join(root, "outside.json"), "{\"files\":[]}");
    await symlink(join(root, "outside.json"), join(workspace, "tsconfig.json"));
    const report = collectTypeScriptDiagnostics(workspace);
    assert.equal(report.available, false);
    assert.match(report.message ?? "", /does not resolve.*inside the workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnostics tool returns a bounded model-facing summary", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "tsconfig.json"), "{\"files\":[\"broken.ts\"]}");
    await writeFile(join(workspace, "broken.ts"), "const count: number = 'bad';\n");
    const result = await createTypeScriptDiagnosticsTool(workspace).execute(
      "diagnostics-1",
      {},
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const text = result.content[0];
    assert.equal(text?.type, "text");
    assert.match(text?.type === "text" ? text.text : "", /TypeScript diagnostics: 1 error/);
    assert.match(text?.type === "text" ? text.text : "", /broken\.ts:1:7 TS2322/);
  });
});
