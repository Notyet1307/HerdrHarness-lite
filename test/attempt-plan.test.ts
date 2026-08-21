import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExecutionSnapshot, executionResource } from "../src/attempt-plan.js";

test("execution snapshot binds an extension's local module closure", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-extension-"));
  try {
    const extension = join(root, "extension", "index.js");
    mkdirSync(join(root, "extension"));
    writeFileSync(extension, 'import "./helper.js";\n');
    writeFileSync(join(root, "extension", "helper.js"), "export const value = 1;\n");
    const argv = ["--extension", extension, "--tools", "read", "--thinking", "high", "--no-session"];
    const first = buildExecutionSnapshot({ adapter: "herdr-pi-cli", executable: "/pi", runtimeVersion: "0.84.0", argv });
    writeFileSync(join(root, "extension", "helper.js"), "export const value = 2;\n");
    const second = buildExecutionSnapshot({ adapter: "herdr-pi-cli", executable: "/pi", runtimeVersion: "0.84.0", argv });
    assert.equal(first.resources[0]?.digest === second.resources[0]?.digest, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("execution snapshot binds a declared Pi package extension's sibling hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-package-extension-"));
  try {
    const extension = join(root, "pi-extension", "index.js");
    const hook = join(root, "hooks", "rules.js");
    mkdirSync(join(root, "pi-extension"));
    mkdirSync(join(root, "hooks"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ pi: { extensions: ["./pi-extension/index.js"] } }));
    writeFileSync(extension, 'import "../hooks/rules.js";\n');
    writeFileSync(hook, "export const rules = 1;\n");
    const argv = ["--extension", extension, "--tools", "read", "--thinking", "high", "--no-session"];
    const first = buildExecutionSnapshot({ adapter: "herdr-pi-cli", executable: "/pi", runtimeVersion: "0.84.0", argv });
    writeFileSync(hook, "export const rules = 2;\n");
    const second = buildExecutionSnapshot({ adapter: "herdr-pi-cli", executable: "/pi", runtimeVersion: "0.84.0", argv });
    assert.equal(first.resources[0]?.digest === second.resources[0]?.digest, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controlled compaction snapshot requires the exact qualified policy", () => {
  const argv = [
    "--provider", "test", "--model", "model", "--thinking", "high", "--tools", "read",
  ];
  assert.throws(() => buildExecutionSnapshot({
    adapter: "pi-rpc",
    executable: "/pi",
    runtimeVersion: "0.84.2",
    argv,
    compactionMode: "controlled-threshold",
  }), /exact qualified policy/);
  assert.throws(() => buildExecutionSnapshot({
    adapter: "pi-rpc",
    executable: "/pi",
    runtimeVersion: "0.84.2",
    argv,
    compactionPolicy: { triggerPercent: 75, maxCompactions: 1, keepRecentTokens: 20_000, overflowContinuation: false },
  }), /exact qualified policy/);
});

test("credential domain cannot be downgraded to runtime-default", () => {
  const input = {
    adapter: "herdr-pi-cli" as const,
    executable: "/pi",
    runtimeVersion: "0.84.2",
    argv: ["--thinking", "high", "--tools", "read"],
    credentialDomainId: "a".repeat(64),
  };
  assert.throws(() => buildExecutionSnapshot({
    ...input,
    credentialMode: "runtime-default",
  }), /requires canonical-oauth/);
  assert.equal(buildExecutionSnapshot({
    ...input,
    credentialMode: "canonical-oauth",
  }).credentialMode, "canonical-oauth");
});

test("model config execution resources require one private regular file", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-model-config-"));
  try {
    const path = join(root, "models.json");
    writeFileSync(path, '{"providers":{}}\n');
    assert.throws(() => executionResource("model-config", path), /private regular single-link/);
    chmodSync(path, 0o600);
    assert.equal(executionResource("model-config", path).kind, "model-config");
    linkSync(path, join(root, "models-copy.json"));
    assert.throws(() => executionResource("model-config", path), /private regular single-link/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
