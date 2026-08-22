import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("Project Observer v2 migrates state, suppresses replay, and dedupes Controller down/up", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-project-observer-v2-"));
  try {
    const stateDir = join(root, "harness-state");
    const observerState = join(root, "observer-state.json");
    const harnessConfig = join(root, "harness.json");
    const observerConfig = join(root, "observer.json");
    const controllerLog = join(root, "controller.log");
    const captureScript = join(root, "capture.mjs");
    const captureFile = join(root, "delivered.jsonl");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(controllerLog, "", { mode: 0o600 });
    writeFileSync(captureScript, [
      'import { appendFileSync } from "node:fs";',
      'let value = "";',
      'for await (const chunk of process.stdin) value += chunk;',
      'appendFileSync(process.argv[2], `${value.trim()}\\n`);',
    ].join("\n"), { mode: 0o600 });
    writeFileSync(harnessConfig, JSON.stringify({
      repo: "owner/repo",
      stateDir,
      workerArgv: [],
      reviewerArgv: [],
      diagnostics: { projectId: "Exposure-Agent" },
    }), { mode: 0o600 });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(activeState()), { mode: 0o600 });
    writeControllerHealth(stateDir, new Date().toISOString());
    writeFileSync(observerState, JSON.stringify({
      version: 2,
      initialized: true,
      ledgerInitialized: true,
      ledgerHealthy: true,
      logInitialized: true,
      logHealthy: true,
      controllerDown: false,
      controllerDownLogMtimeMs: 0,
      controllerLogOffset: 0,
      lastControllerAlertKey: null,
      lastJobId: "job-001",
      lastJobRevision: 4,
      lastJobState: "worker_ready",
      lastIncidentId: null,
      lastAnalysisId: null,
      lastAutomaticRecoveryCount: 0,
      terminalCount: 0,
      outbox: [],
    }), { mode: 0o600 });
    writeFileSync(observerConfig, JSON.stringify({
      transportVersion: 2,
      routeId: "exposure",
      projectId: "Exposure-Agent",
      fleetId: "engineering-fleet",
      harnessConfig,
      nodeBin: process.execPath,
      statusScript: resolve("dist/src/transport-cli.js"),
      harnessCliScript: resolve("dist/src/cli.js"),
      approvalScript: resolve("dist/src/hermes-approval.js"),
      approvalState: join(root, "approval-state.json"),
      telegramAllowedUser: "123456789",
      deliveryCommand: [process.execPath, captureScript, captureFile],
      observerState,
      controllerLog,
      pollMs: 1_000,
      heartbeatTimeoutMs: 60_000,
    }), { mode: 0o600 });

    assert.equal(runObserver(observerConfig).status, 0);
    assert.equal(exists(captureFile), false, "migration replayed current normal progress");
    let migrated = JSON.parse(readFileSync(observerState, "utf8"));
    assert.equal(migrated.version, 3);
    assert.match(migrated.lastProjectionDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(migrated.lastEventByCategory, {});
    assert.equal(migrated.controllerHealth, "healthy");

    writeControllerHealth(stateDir, "2026-08-21T00:00:00.000Z");
    assert.equal(runObserver(observerConfig).status, 0);
    let delivered = readDelivered(captureFile);
    assert.deepEqual(delivered.map((event) => event.category), ["controller.down"]);
    assert.equal(runObserver(observerConfig).status, 0);
    assert.equal(readDelivered(captureFile).length, 1, "unchanged down state replayed");

    writeControllerHealth(stateDir, new Date().toISOString());
    assert.equal(runObserver(observerConfig).status, 0);
    delivered = readDelivered(captureFile);
    assert.deepEqual(delivered.map((event) => event.category), ["controller.down", "controller.up"]);

    appendFileSync(controllerLog, `${JSON.stringify({
      ok: false,
      action: "preflight_failed",
      jobId: "job-001",
      message: "SECRET_AUTH_PATH /private/auth.json",
    })}\n`);
    assert.equal(runObserver(observerConfig).status, 0);
    delivered = readDelivered(captureFile);
    const legacy = delivered.at(-1);
    assert.equal(legacy.category, "preflight.failed");
    assert.match(legacy.summary, /reevaluated on the next Controller cycle/i);
    assert.equal(JSON.stringify(legacy).includes("SECRET_AUTH_PATH"), false);
    assert.equal(JSON.stringify(legacy).includes("/private/auth.json"), false);
    assert.equal(runObserver(observerConfig).status, 0);
    assert.equal(readDelivered(captureFile).length, 3, "legacy preflight replayed");

    migrated = JSON.parse(readFileSync(observerState, "utf8"));
    assert.equal(migrated.outbox.length, 0);
    migrated.outbox.push({
      kind: "payload",
      key: "rollback-pending-v2",
      payload: {
        version: 2,
        kind: "event",
        generatedAt: new Date().toISOString(),
        routeId: "exposure",
        projectId: "Exposure-Agent",
        fleetId: "engineering-fleet",
        eventId: "event-rollback-pending",
        dedupeKey: "rollback-pending-v2",
        occurredAt: new Date().toISOString(),
        severity: "info",
        category: "state.restored",
        title: "Pending before rollback",
        summary: "Pending v2 delivery survives transport rollback.",
        facts: [],
        actionRequired: false,
        operatorActionKinds: [],
      },
      attempts: 0,
      nextAttemptAt: 0,
    });
    writeFileSync(observerState, JSON.stringify(migrated), { mode: 0o600 });

    const rollback = JSON.parse(readFileSync(observerConfig, "utf8"));
    delete rollback.transportVersion;
    delete rollback.routeId;
    delete rollback.projectId;
    delete rollback.fleetId;
    rollback.laneId = "exposure";
    writeFileSync(observerConfig, JSON.stringify(rollback), { mode: 0o600 });
    assert.equal(runObserver(observerConfig).status, 0, "v1 rollback rejected migrated v3 state");
    const rolledBack = JSON.parse(readFileSync(observerState, "utf8"));
    assert.equal(rolledBack.version, 2);
    assert.equal(rolledBack.outbox.length, 0);
    const rollbackDelivered = readDelivered(captureFile);
    assert.equal(rollbackDelivered.length, 4, "v1 rollback replayed or dropped a v2 transition");
    assert.equal(rollbackDelivered.at(-1).dedupeKey, "rollback-pending-v2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runObserver(config: string) {
  return spawnSync(process.execPath, [resolve("dist/src/hermes-observer.js"), "run", "--config", config, "--once"], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

function writeControllerHealth(stateDir: string, updatedAt: string): void {
  writeFileSync(join(stateDir, "controller-lease.json"), JSON.stringify({
    version: 1,
    instanceId: "controller-fixture",
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  }), { mode: 0o600 });
  writeFileSync(join(stateDir, "controller-heartbeat.json"), JSON.stringify({ version: 1, parentPid: process.pid, updatedAt }), { mode: 0o600 });
}

function activeState() {
  return {
    version: 1,
    activeJob: {
      id: "job-001",
      revision: 4,
      state: "worker_ready",
      task: { repo: "owner/repo", issueNumber: 48, mapNumber: null, title: "title", objective: "SECRET_TASK_BODY", labels: [], issueUpdatedAt: "2026-08-22T00:00:00.000Z", digest: "a".repeat(64) },
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
      incident: null,
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

function exists(path: string): boolean {
  try { readFileSync(path); return true; } catch { return false; }
}

function readDelivered(path: string): any[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
