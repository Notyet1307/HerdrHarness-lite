import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controllerHeartbeatPath, startControllerHeartbeat } from "../src/controller-heartbeat.js";

test("Controller heartbeat advances while the parent event loop is blocked", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-controller-heartbeat-"));
  try {
    const heartbeat = startControllerHeartbeat(root, 20);
    const path = controllerHeartbeatPath(root);
    const first = statSync(path).mtimeMs;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
    assert.ok(statSync(path).mtimeMs > first);
    heartbeat.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
