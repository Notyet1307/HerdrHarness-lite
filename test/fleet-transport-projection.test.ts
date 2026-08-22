import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadFleetConfig } from "../src/fleet/config.js";
import { validReviewerArgv, validWorkerArgv } from "./fakes.js";

test("fleet Transport v2 projects real Supervisor phases without path leakage", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-transport-fleet-"));
  try {
    const fleetStateDir = join(root, "fleet-state");
    mkdirSync(fleetStateDir, { recursive: true });
    const declarations = [
      ["Exposure-Agent", "exposure"],
      ["CloudAtlas.v2", "atlas"],
      ["Governance_Run", "governance"],
      ["Canary", "canary"],
    ] as const;
    const projects = declarations.map(([projectId], index) => {
      const localPath = join(root, `${projectId}-source`);
      const stateDir = join(root, `${projectId}-state`);
      const worktreeRoot = join(root, `${projectId}-worktrees`);
      for (const path of [localPath, stateDir, worktreeRoot]) mkdirSync(path, { recursive: true });
      const config = join(root, `${projectId}.json`);
      writeFileSync(config, JSON.stringify({
        repo: `owner/repo-${index}`,
        localPath,
        stateDir,
        baseRef: "main",
        readyLabel: "ready-for-agent",
        claimLabel: "agent:claimed",
        worktreeRoot,
        maxReviewRounds: 3,
        maxAnalystTurns: 3,
        reviewerValidationArgv: [process.execPath, "--version"],
        workerArgv: validWorkerArgv,
        reviewerArgv: validReviewerArgv,
        diagnostics: { projectId },
        herdr: { session: `session-${index}` },
        analyst: { command: process.execPath },
      }));
      writeFileSync(join(stateDir, "state.json"), JSON.stringify(index === 0 ? blockedState() : {
        version: 1,
        activeJob: null,
        terminalJobs: [],
      }));
      return { id: projectId, config };
    });
    const fleetConfig = join(root, "fleet.json");
    writeFileSync(fleetConfig, JSON.stringify({
      version: 1,
      name: "engineering-fleet",
      stateDir: fleetStateDir,
      restartPolicy: { initialBackoffMs: 1000, maxBackoffMs: 60000, maxRestarts: 3, windowMs: 300000, stableAfterMs: 120000 },
      projects,
    }));
    const loaded = loadFleetConfig(fleetConfig);
    const now = new Date().toISOString();
    const phases = ["running", "adopted", "backoff", "tripped"] as const;
    writeFileSync(join(fleetStateDir, "fleet-state.json"), JSON.stringify({
      version: 1,
      fleetName: loaded.name,
      configDigest: loaded.digest,
      supervisorPid: process.pid,
      startedAt: now,
      updatedAt: now,
      stopping: false,
      projects: Object.fromEntries(loaded.projects.map((project, index) => [project.id, {
        id: project.id,
        configDigest: project.configDigest,
        phase: phases[index],
        pid: index < 2 ? process.pid : null,
        owned: index === 0,
        startedAt: index < 2 ? now : null,
        nextStartAt: index === 2 ? new Date(Date.now() + 60_000).toISOString() : null,
        restartTimestamps: Array.from({ length: index }, () => now),
        lastExit: index < 2 ? null : { code: 1, signal: null, exitedAt: now, runtimeMs: 1000 },
        lastError: index < 2 ? null : "SECRET_CHILD_ERROR",
      }])),
    }));
    writeFileSync(join(fleetStateDir, "fleet-supervisor-lease.json"), JSON.stringify({
      version: 1,
      instanceId: "fleet-fixture",
      pid: process.pid,
      acquiredAt: now,
    }), { mode: 0o600 });
    writeFileSync(join(fleetStateDir, "fleet-supervisor-heartbeat.json"), JSON.stringify({ version: 1, parentPid: process.pid, updatedAt: now }), { mode: 0o600 });
    for (const project of loaded.projects.slice(0, 2)) {
      writeFileSync(join(project.config.stateDir, "controller-lease.json"), JSON.stringify({
        version: 1,
        instanceId: `controller-${project.id}`,
        pid: process.pid,
        acquiredAt: now,
      }), { mode: 0o600 });
      writeFileSync(join(project.config.stateDir, "controller-heartbeat.json"), JSON.stringify({ version: 1, parentPid: process.pid, updatedAt: now }), { mode: 0o600 });
    }
    const observerConfig = join(root, "fleet-observer.json");
    writeFileSync(observerConfig, JSON.stringify({
      transportVersion: 2,
      routeId: "fleet",
      fleetConfig,
      routes: Object.fromEntries(declarations.map(([projectId, routeId]) => [projectId, routeId])),
    }), { mode: 0o600 });

    const result = spawnSync(process.execPath, [
      resolve("dist/src/transport-cli.js"), "fleet", "status", "--config", observerConfig, "--json", "v2",
    ], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.kind, "fleet-view");
    assert.equal(envelope.fleetId, "engineering-fleet");
    assert.equal(envelope.fleet.health, "degraded");
    assert.deepEqual(envelope.projects.map((project: { routeId: string; projectId: string; phase: string }) => (
      [project.routeId, project.projectId, project.phase]
    )), [
      ["exposure", "Exposure-Agent", "running"],
      ["atlas", "CloudAtlas.v2", "adopted"],
      ["governance", "Governance_Run", "backoff"],
      ["canary", "Canary", "tripped"],
    ]);
    assert.equal(envelope.projects[0].workflow.state, "blocked");
    assert.equal(envelope.projects[0].controller.health, "healthy");
    assert.equal(envelope.projects[1].owned, false);
    assert.equal(envelope.projects[2].nextStartAt !== null, true);
    for (const secret of [root, "SECRET_CHILD_ERROR", "configPath", "stateDir", "instanceId"]) {
      assert.equal(result.stdout.includes(secret), false, secret);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function blockedState() {
  return {
    version: 1,
    activeJob: {
      id: "job-001",
      revision: 4,
      state: "blocked",
      task: {
        repo: "owner/repo-0",
        issueNumber: 48,
        mapNumber: null,
        title: "blocked is workflow state",
        objective: "SECRET_TASK_BODY",
        labels: [],
        issueUpdatedAt: "2026-08-22T00:00:00.000Z",
        digest: "a".repeat(64),
      },
      baseSha: "b".repeat(40),
      claimConfirmed: true,
      headSha: null,
      branch: "agent/issue-48",
      worktree: null,
      analyst: null,
      activeAttempt: null,
      attempts: [],
      reviewRound: 0,
      maxReviewRounds: 3,
      pendingHandoff: null,
      incident: {
        id: "incident-001",
        class: "stale_task",
        lane: "controller",
        attemptId: null,
        summary: "SECRET_INCIDENT",
        evidenceDigest: "c".repeat(64),
        allowedActions: ["hold"],
        createdAt: "2026-08-22T00:00:00.000Z",
      },
      analysis: null,
      approval: null,
      automaticRecoveries: [],
      pullRequest: null,
      ciFailure: null,
      ciReworkCount: 0,
      lastError: null,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    },
    terminalJobs: [],
  };
}
