import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStateStore } from "../src/fleet/store.js";
import { resetFleetProject } from "../src/fleet/reset.js";
import type { FleetRuntimeState, LoadedFleetConfig } from "../src/fleet/types.js";

test("Fleet state remains committed when Fleet audit append degrades", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-store-"));
  try {
    mkdirSync(join(root, "fleet-events.jsonl"), { recursive: true });
    const now = new Date().toISOString();
    const state: FleetRuntimeState = {
      version: 1,
      fleetName: "test",
      configDigest: "digest",
      supervisorPid: process.pid,
      startedAt: now,
      updatedAt: now,
      stopping: false,
      projects: {},
    };
    const store = new FleetStateStore(root);
    store.save(state, { type: "test" });
    assert.deepEqual(store.load(), state);
    assert.equal(existsSync(join(root, "fleet-events.degraded.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset stays scoped to the selected project when a sibling changed the Fleet digest", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-reset-"));
  try {
    const now = new Date().toISOString();
    const store = new FleetStateStore(root);
    store.save({
      version: 1,
      fleetName: "test",
      configDigest: "old-global-digest",
      supervisorPid: process.pid,
      startedAt: now,
      updatedAt: now,
      stopping: false,
      projects: {
        alpha: {
          id: "alpha",
          configDigest: "alpha-config-digest",
          phase: "tripped",
          pid: null,
          owned: false,
          startedAt: null,
          nextStartAt: null,
          restartTimestamps: [now],
          lastExit: null,
          lastError: "failed",
        },
      },
    }, { type: "fixture" });
    const config = {
      name: "test",
      stateDir: root,
      digest: "new-global-digest",
      projects: [{ id: "alpha", configDigest: "alpha-config-digest" }],
    } as LoadedFleetConfig;

    assert.deepEqual(resetFleetProject(config, "alpha"), {
      projectId: "alpha",
      phase: "stopped",
      restartTimestamps: [],
    });
    assert.equal(store.load()?.configDigest, "old-global-digest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
