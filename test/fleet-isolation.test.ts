import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFleetIsolation } from "../src/fleet/isolation.js";
import type { LoadedFleetConfig, LoadedFleetProject, ProjectFileConfig } from "../src/fleet/types.js";

test("Fleet rejects shared repositories, sessions, and filesystem authority", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-isolation-"));
  try {
    const fleetState = join(root, "fleet-state");
    mkdirSync(fleetState, { recursive: true });
    const first = project(root, "alpha", "owner/alpha", "session-alpha");
    const second = project(root, "beta", "owner/beta", "session-beta");
    const config = fleet(root, fleetState, [first, second]);
    validateFleetIsolation(config);

    const duplicateRepo = fleet(root, fleetState, [first, { ...second, config: { ...second.config, repo: "OWNER/ALPHA" } }]);
    assert.throws(() => validateFleetIsolation(duplicateRepo), /duplicate GitHub repository/);

    const duplicateSession = fleet(root, fleetState, [first, { ...second, config: { ...second.config, herdr: { session: "session-alpha" } } }]);
    assert.throws(() => validateFleetIsolation(duplicateSession), /duplicate Herdr session/);

    const overlapping = fleet(root, fleetState, [
      first,
      { ...second, config: { ...second.config, stateDir: join(first.config.localPath, "nested-state") } },
    ]);
    assert.throws(() => validateFleetIsolation(overlapping), /path isolation violation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(root: string, id: string, repo: string, session: string): LoadedFleetProject {
  const localPath = join(root, `${id}-source`);
  const stateDir = join(root, `${id}-state`);
  const worktreeRoot = join(root, `${id}-worktrees`);
  for (const path of [localPath, stateDir, worktreeRoot]) mkdirSync(path, { recursive: true });
  const config = {
    repo,
    localPath,
    stateDir,
    worktreeRoot,
    herdr: { session },
  } as ProjectFileConfig;
  return { id, configPath: join(root, `${id}.json`), configDigest: `digest-${id}`, enabled: true, pollMs: 1_000, config };
}

function fleet(root: string, stateDir: string, projects: LoadedFleetProject[]): LoadedFleetConfig {
  return {
    version: 1,
    sourcePath: join(root, "fleet.json"),
    name: "test-fleet",
    stateDir,
    defaultPollMs: 1_000,
    tickConcurrency: 2,
    tickTimeoutMs: 10_000,
    shutdownGraceMs: 1_000,
    maxLogBytes: 4_096,
    restartPolicy: { initialBackoffMs: 100, maxBackoffMs: 1_000, maxRestarts: 3, windowMs: 10_000, stableAfterMs: 1_000 },
    projects,
    digest: "digest",
  };
}
