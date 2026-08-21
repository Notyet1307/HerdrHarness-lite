import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireFleetLease,
  controllerLeasePathForProject,
  observeProjectControllerLease,
} from "../src/fleet/lease.js";

test("Fleet lease excludes a second Supervisor and observes an existing project Controller", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-lease-"));
  try {
    const first = acquireFleetLease(root);
    assert.throws(() => acquireFleetLease(root), new RegExp(`pid ${process.pid}`));
    first.stop();

    writeFileSync(controllerLeasePathForProject(root), `${JSON.stringify({
      version: 1,
      instanceId: "existing-controller",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    const observed = observeProjectControllerLease(root);
    assert.equal(observed.status, "alive");
    if (observed.status === "alive") assert.equal(observed.pid, process.pid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
