import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadFleetConfig } from "../src/fleet/config.js";
import { validReviewerArgv, validWorkerArgv } from "./fakes.js";

test("Fleet Observer emits only Supervisor and process transitions with durable dedupe", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-observer-"));
  try {
    const fleetStateDir = join(root, "fleet-state");
    const observerState = join(root, "fleet-observer-state.json");
    const captureScript = join(root, "capture.mjs");
    const captureFile = join(root, "delivered.jsonl");
    mkdirSync(fleetStateDir, { recursive: true });
    writeFileSync(captureScript, [
      'import { appendFileSync } from "node:fs";',
      'let value = "";',
      'for await (const chunk of process.stdin) value += chunk;',
      'appendFileSync(process.argv[2], `${value.trim()}\\n`);',
    ].join("\n"));
    const declarations = [["Exposure-Agent", "exposure"], ["CloudAtlas.v2", "atlas"]] as const;
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
      writeFileSync(join(stateDir, "state.json"), JSON.stringify({ version: 1, activeJob: null, terminalJobs: [] }));
      return { id: projectId, config };
    });
    const fleetConfig = join(root, "fleet.json");
    writeFileSync(fleetConfig, JSON.stringify({ version: 1, name: "engineering-fleet", stateDir: fleetStateDir, projects }));
    let loaded = loadFleetConfig(fleetConfig);
    const now = new Date().toISOString();
    writeFleetHealth(fleetStateDir, now);
    writeFleetState(loaded, { "Exposure-Agent": "running", "CloudAtlas.v2": "adopted" });
    for (const project of loaded.projects) writeControllerHealth(project.config.stateDir, now);
    const observerConfig = join(root, "fleet-observer.json");
    writeFileSync(observerConfig, JSON.stringify({
      transportVersion: 2,
      routeId: "fleet",
      fleetConfig,
      routes: Object.fromEntries(declarations.map(([projectId, routeId]) => [projectId, routeId])),
      deliveryCommand: [process.execPath, captureScript, captureFile],
      observerState,
      pollMs: 1_000,
      heartbeatTimeoutMs: 30_000,
    }), { mode: 0o600 });

    assert.equal(runObserver(observerConfig).status, 0);
    assert.equal(exists(captureFile), false, "Fleet baseline replayed current phases");

    writeFleetState(loaded, { "Exposure-Agent": "backoff", "CloudAtlas.v2": "adopted" });
    assert.equal(runObserver(observerConfig).status, 0);
    writeFleetState(loaded, { "Exposure-Agent": "tripped", "CloudAtlas.v2": "adopted" });
    assert.equal(runObserver(observerConfig).status, 0);
    assert.equal(runObserver(observerConfig).status, 0);
    let events = readDelivered(captureFile);
    assert.deepEqual(events.map((event) => event.category), ["project.backoff", "project.tripped"]);

    writeFleetState(loaded, { "Exposure-Agent": "tripped", "CloudAtlas.v2": "running" });
    assert.equal(runObserver(observerConfig).status, 0);
    writeFleetState(loaded, { "Exposure-Agent": "tripped", "CloudAtlas.v2": "adopted" });
    assert.equal(runObserver(observerConfig).status, 0);
    events = readDelivered(captureFile);
    const adopted = events.find((event) => event.category === "project.adopted");
    assert.ok(adopted);
    assert.equal(adopted.severity, "info");
    assert.match(adopted.summary, /existing live Controller/i);
    assert.equal(/failure|crash/i.test(adopted.title), false);

    writeFileSync(join(fleetStateDir, "fleet-supervisor-heartbeat.json"), JSON.stringify({ version: 1, parentPid: process.pid, updatedAt: "2026-08-21T00:00:00.000Z" }));
    assert.equal(runObserver(observerConfig).status, 0);
    writeFleetHealth(fleetStateDir, new Date().toISOString());
    assert.equal(runObserver(observerConfig).status, 0);
    events = readDelivered(captureFile);
    assert.ok(events.some((event) => event.category === "fleet.down"));
    assert.ok(events.some((event) => event.category === "fleet.up"));

    const changed = JSON.parse(readFileSync(fleetConfig, "utf8"));
    changed.defaultPollMs = 20_000;
    writeFileSync(fleetConfig, JSON.stringify(changed));
    loaded = loadFleetConfig(fleetConfig);
    assert.equal(runObserver(observerConfig).status, 0);
    events = readDelivered(captureFile);
    assert.equal(events.at(-1).category, "fleet.config-drift");
    assert.equal(events.at(-1).severity, "critical");

    const persisted = JSON.parse(readFileSync(observerState, "utf8"));
    assert.equal(persisted.version, 1);
    assert.equal(persisted.outbox.length, 0);
    assert.match(persisted.lastProjectionDigest, /^[0-9a-f]{64}$/);
    for (const secret of [root, "SECRET_CHILD_ERROR", "configPath", "stateDir"]) {
      assert.equal(JSON.stringify(events).includes(secret), false, secret);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runObserver(config: string) {
  return spawnSync(process.execPath, [resolve("dist/src/fleet-observer.js"), "run", "--config", config, "--once"], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

function writeFleetState(config: ReturnType<typeof loadFleetConfig>, phases: Record<string, string>): void {
  const now = new Date().toISOString();
  writeFileSync(join(config.stateDir, "fleet-state.json"), JSON.stringify({
    version: 1,
    fleetName: config.name,
    configDigest: config.digest,
    supervisorPid: process.pid,
    startedAt: now,
    updatedAt: now,
    stopping: false,
    projects: Object.fromEntries(config.projects.map((project) => [project.id, {
      id: project.id,
      configDigest: project.configDigest,
      phase: phases[project.id],
      pid: ["running", "adopted"].includes(phases[project.id] ?? "") ? process.pid : null,
      owned: phases[project.id] === "running",
      startedAt: now,
      nextStartAt: phases[project.id] === "backoff" ? new Date(Date.now() + 60_000).toISOString() : null,
      restartTimestamps: phases[project.id] === "tripped" ? [now, now, now, now] : phases[project.id] === "backoff" ? [now] : [],
      lastExit: ["backoff", "tripped"].includes(phases[project.id] ?? "") ? { code: 1, signal: null, exitedAt: now, runtimeMs: 1000 } : null,
      lastError: ["backoff", "tripped"].includes(phases[project.id] ?? "") ? "SECRET_CHILD_ERROR" : null,
    }])),
  }));
}

function writeFleetHealth(stateDir: string, updatedAt: string): void {
  writeFileSync(join(stateDir, "fleet-supervisor-lease.json"), JSON.stringify({ version: 1, instanceId: "fleet-fixture", pid: process.pid, acquiredAt: updatedAt }), { mode: 0o600 });
  writeFileSync(join(stateDir, "fleet-supervisor-heartbeat.json"), JSON.stringify({ version: 1, parentPid: process.pid, updatedAt }), { mode: 0o600 });
}

function writeControllerHealth(stateDir: string, updatedAt: string): void {
  writeFileSync(join(stateDir, "controller-lease.json"), JSON.stringify({ version: 1, instanceId: `controller-${stateDir.length}`, pid: process.pid, acquiredAt: updatedAt }), { mode: 0o600 });
  writeFileSync(join(stateDir, "controller-heartbeat.json"), JSON.stringify({ version: 1, parentPid: process.pid, updatedAt }), { mode: 0o600 });
}

function exists(path: string): boolean {
  try { readFileSync(path); return true; } catch { return false; }
}

function readDelivered(path: string): any[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
