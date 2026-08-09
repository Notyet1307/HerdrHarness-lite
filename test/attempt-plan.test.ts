import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExecutionSnapshot } from "../src/attempt-plan.js";

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
