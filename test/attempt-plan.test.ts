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
