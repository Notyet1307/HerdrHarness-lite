import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const modules = [
  "src/controller/context.ts",
  "src/controller/task-lifecycle.ts",
  "src/controller/attempt-preparation.ts",
  "src/controller/attempt-driver.ts",
  "src/controller/attempt-settlement.ts",
  "src/controller/runtime-preflight.ts",
  "src/controller/attempt-integrity.ts",
  "src/controller/attempt-reconciliation.ts",
  "src/controller/automatic-recovery.ts",
  "src/controller/delivery.ts",
  "src/controller/recovery-flow.ts",
  "src/controller/config-validation.ts",
];

test("Controller facade remains thin and responsibilities stay in focused modules", () => {
  const facade = readFileSync("src/controller.ts", "utf8");
  assert.ok(facade.split("\n").length <= 100, "src/controller.ts must remain a thin state dispatcher");
  assert.equal(facade.includes("prepareWorkerResult"), false);
  assert.equal(facade.includes("observePullRequest"), false);
  assert.equal(facade.includes("runDiagnosis"), false);

  for (const path of modules) {
    assert.equal(existsSync(path), true, path);
    const lines = readFileSync(path, "utf8").split("\n").length;
    assert.ok(lines <= 450, `${path} grew into another monolith (${lines} lines)`);
  }
});
