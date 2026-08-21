import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFleetTick } from "../src/fleet/tick.js";
import type { LoadedFleetConfig, LoadedFleetProject, ProjectFileConfig, ProjectTickResult } from "../src/fleet/types.js";

test("Fleet tick bounds concurrency and does not cancel sibling projects after one failure", async () => {
  const projects = ["alpha", "beta", "gamma", "delta"].map((id) => ({ id })) as LoadedFleetProject[];
  const config = {
    name: "test-fleet",
    tickConcurrency: 2,
  } as LoadedFleetConfig;
  let active = 0;
  let maximumActive = 0;
  const visited: string[] = [];

  const report = await runFleetTick({
    config,
    projects,
    concurrency: 2,
    runner: async (project): Promise<ProjectTickResult> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      visited.push(project.id);
      await delay(project.id === "beta" ? 5 : 15);
      active -= 1;
      const now = new Date().toISOString();
      return {
        projectId: project.id,
        ok: project.id !== "beta",
        code: project.id === "beta" ? 1 : 0,
        signal: null,
        startedAt: now,
        completedAt: now,
        stdout: "",
        stderr: "",
        error: null,
      };
    },
  });

  assert.equal(maximumActive, 2);
  assert.equal(report.ok, false);
  assert.equal(report.projects.length, 4);
  assert.deepEqual([...visited].sort(), ["alpha", "beta", "delta", "gamma"]);
  assert.equal(report.projects.filter((project) => !project.ok).length, 1);
});

test("Fleet tick rejects a project config changed after Fleet validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-config-drift-"));
  try {
    const configPath = join(root, "project.json");
    writeFileSync(configPath, JSON.stringify({
      stateDir: join(root, "state"),
      herdr: { session: "fixture" },
      analyst: { command: process.execPath },
    }));
    const project = {
      id: "alpha",
      configPath,
      configDigest: "stale-digest",
      enabled: true,
      pollMs: 100,
      config: {} as ProjectFileConfig,
    } as LoadedFleetProject;
    const config = {
      name: "test-fleet",
      tickConcurrency: 1,
      tickTimeoutMs: 5_000,
      maxLogBytes: 4_096,
    } as LoadedFleetConfig;

    const report = await runFleetTick({ config, projects: [project] });
    assert.equal(report.ok, false);
    assert.match(report.projects[0]?.stderr ?? "", /project config changed after Fleet validation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, milliseconds); });
}
