import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProductProjectTrust } from "../src/project-trust.ts";

test("uses Pi ProjectTrustStore for session-only and remembered decisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-code-trust-"));
  const agentDir = join(root, "agent-home");
  const cwd = join(root, "workspace");
  try {
    await mkdir(join(cwd, ".pi", "skills"), { recursive: true });
    const initial = new ProductProjectTrust(cwd, agentDir);
    assert.equal(initial.hasPiTrustResources(), true);
    assert.deepEqual(initial.snapshot(), { status: "undecided", remembered: false, savedPath: undefined });

    initial.decide(true, false);
    assert.equal(initial.isTrusted(), true);
    assert.equal(initial.snapshot().remembered, false);
    assert.equal(new ProductProjectTrust(cwd, agentDir).snapshot().status, "undecided");

    initial.decide(false, true);
    const restored = new ProductProjectTrust(cwd, agentDir);
    assert.equal(restored.isTrusted(), false);
    assert.equal(restored.snapshot().status, "untrusted");
    assert.equal(restored.snapshot().remembered, true);
    assert.equal(restored.snapshot().savedPath, await realpath(cwd));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt trust store fails closed without blocking a session-only decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-code-trust-"));
  const agentDir = join(root, "agent-home");
  const cwd = join(root, "workspace");
  try {
    const trustDir = join(agentDir, "deepseek-code");
    await mkdir(trustDir, { recursive: true });
    await writeFile(join(trustDir, "trust.json"), "[]", "utf-8");
    const trust = new ProductProjectTrust(cwd, agentDir);
    assert.equal(trust.isTrusted(), false);
    assert.equal(trust.snapshot().status, "error");
    assert.match(trust.snapshot().error ?? "", /expected an object/);
    trust.decide(true, false);
    assert.equal(trust.isTrusted(), true);
    assert.throws(() => trust.decide(true, true), /read-only until repaired/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
