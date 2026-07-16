import assert from "node:assert/strict";
import test from "node:test";
import { buildDoctorReport, type DoctorProbe, renderDoctorReport } from "../src/doctor.ts";

function healthyProbe(): DoctorProbe {
  return {
    productVersion: "0.1.0",
    sdkVersion: "0.80.7",
    cwd: "/work/repo",
    modelId: "deepseek-v4-flash",
    nodeVersion: "22.19.0",
    minimumNodeVersion: "22.19.0",
    modelExists: true,
    authConfigured: true,
    gitAvailable: true,
    gitRepository: true,
    gitDirty: false,
    rgAvailable: true,
    fdAvailable: true,
    sessionWritable: true,
    interactiveTerminal: true,
    resources: { agents: 2, skills: 1, prompts: 3, diagnostics: 0 },
  };
}

test("doctor passes a complete local environment", () => {
  const report = buildDoctorReport(healthyProbe());
  assert.equal(report.status, "pass");
  assert.equal(report.checks.length, 9);
  assert.match(renderDoctorReport(report, false), /Ready · model deepseek-v4-flash/);
});

test("doctor distinguishes optional warnings from blockers", () => {
  const warned = buildDoctorReport({ ...healthyProbe(), fdAvailable: false, gitDirty: true });
  assert.equal(warned.status, "warn");
  assert.match(renderDoctorReport(warned, false), /Ready with 1 warning/);
  assert.match(renderDoctorReport(warned, false), /working tree has changes/);

  const blocked = buildDoctorReport({
    ...healthyProbe(),
    authConfigured: false,
    sessionWritable: false,
  });
  assert.equal(blocked.status, "fail");
  assert.match(renderDoctorReport(blocked, false), /Blocked by 2 failed checks/);
  assert.match(renderDoctorReport(blocked, false), /value hidden|not configured/);

  const missingModel = buildDoctorReport({ ...healthyProbe(), modelExists: false, authConfigured: true });
  assert.equal(missingModel.checks.find((check) => check.id === "model")?.status, "fail");
  assert.equal(missingModel.checks.find((check) => check.id === "auth")?.status, "pass");
});

test("doctor color rendering uses the DeepSeek palette but plain output has no ANSI", () => {
  const report = buildDoctorReport(healthyProbe());
  assert.doesNotMatch(renderDoctorReport(report, false), /\u001b\[/);
  assert.match(renderDoctorReport(report, true), /\u001b\[38;2;54;112;255m/);
  assert.match(renderDoctorReport(report, true), /\u001b\[38;2;91;226;210m/);
  const compact = renderDoctorReport({ ...report, cwd: "/a/very/long/path/to/a/deepseek/coding/agent/workspace" }, false, 36);
  const pathLine = compact.trimEnd().split("\n").at(-1) ?? "";
  assert.ok(pathLine.length <= 36);
  assert.match(pathLine, /…deepseek\/coding\/agent\/workspace/);
});
