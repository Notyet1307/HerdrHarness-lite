import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { classifyProviderFailure } from "../src/pi-rpc-diagnostics.js";
import { digest } from "../src/model.js";

test("project Transport v2 projects bounded workflow and safe runtime facts", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-transport-project-"));
  try {
    const stateDir = join(root, "state");
    const harnessConfig = join(root, "harness.json");
    const observerConfig = join(root, "observer.json");
    mkdirSync(stateDir, { recursive: true });
    const diagnostic = classifyProviderFailure("error", "HTTP 503 SECRET_PROVIDER_RESPONSE", {
      providerApi: "openai-codex-responses",
      phase: "initial_generation",
      turnCount: 1,
      assistantMessageCount: 0,
      toolExecutionCount: 0,
      toolErrorCount: 0,
      transcriptBytes: 128,
    });
    const attempt = {
      id: "reviewer-001",
      lane: "reviewer",
      phase: "settled",
      round: 2,
      baseSha: "a".repeat(40),
      expectedHeadSha: "b".repeat(40),
      resultPath: join(stateDir, "reviewer-attempts", "job-001", "reviewer-001", "result.json"),
      promptDigest: "c".repeat(64),
      executionSnapshot: {
        version: 1,
        adapter: "pi-rpc",
        executable: "/private/pi",
        runtimeVersion: "0.84.2",
        argv: ["--provider", "SECRET_PROVIDER_SELECTOR"],
        provider: "SECRET_PROVIDER_SELECTOR",
        model: "SECRET_MODEL_SELECTOR",
        thinking: "max",
        tools: ["read"],
        sessionMode: "ephemeral",
        retryMode: "disabled",
        compactionMode: "disabled",
        credentialMode: "canonical-oauth",
        credentialDomainId: "d".repeat(64),
        axisConcurrency: 1,
        runtimeTimeouts: {
          totalTimeoutMs: 2_700_000,
          noProgressTimeoutMs: 600_000,
          sigtermGraceMs: 10_000,
          sigkillGraceMs: 5_000,
        },
        runtimeDeadlineAt: "2026-08-22T06:45:00.000Z",
        dockerHost: null,
        resources: [],
      },
      planDigest: "e".repeat(64),
      reviewerCheckpointInputs: [{
        stage: "standards-axis",
        path: join(stateDir, "private", "standards-axis.json"),
        digest: "f".repeat(64),
        sourceAttemptId: "reviewer-000",
      }],
      handle: null,
      result: null,
      startedAt: "2026-08-22T06:00:00.000Z",
      completedAt: "2026-08-22T06:01:00.000Z",
    };
    const incident = {
      id: "incident-001",
      class: "infrastructure_exhausted",
      lane: "reviewer",
      attemptId: attempt.id,
      summary: "SECRET_INCIDENT_TEXT",
      evidenceDigest: "1".repeat(64),
      allowedActions: ["retry_fresh_reviewer", "hold"],
      runtimeDiagnostic: diagnostic,
      createdAt: "2026-08-22T06:01:00.000Z",
    };
    const attemptRoot = join(stateDir, "reviewer-attempts", "job-001", "reviewer-001");
    mkdirSync(join(attemptRoot, "runtime"), { recursive: true });
    writeFileSync(join(attemptRoot, "runtime", "runtime-progress.json"), JSON.stringify({
      version: 1,
      attemptId: attempt.id,
      lastProgressAt: "2026-08-22T06:00:30.000Z",
      lastProgressType: "assistant_message_end",
      elapsedMs: 30_000,
      resultPresent: false,
      raw: "SECRET_PROGRESS_PAYLOAD",
    }));
    const validationResult = {
      status: "passed",
      validationArgv: ["npm", "run", "verify"],
      validationArgvDigest: digest(["npm", "run", "verify"]),
      startedAt: "2026-08-22T05:59:00.000Z",
      completedAt: "2026-08-22T05:59:12.000Z",
      durationMs: 12_000,
      exitCode: 0,
      signal: null,
      timeout: false,
      error: null,
      stdout: { text: "SECRET_VALIDATION_OUTPUT", truncated: false, redacted: true, byteCount: 70_000, sha256: "6".repeat(64) },
      stderr: { text: "SECRET_VALIDATION_ERROR", truncated: false, redacted: true, byteCount: 1_024, sha256: "7".repeat(64) },
      dockerHost: null,
      relevantEnvironmentDigest: "8".repeat(64),
      sourceSnapshotDigest: "9".repeat(64),
    };
    const validation = {
      version: 2,
      jobId: "job-001",
      sourceAttemptId: attempt.id,
      jobRevision: 7,
      taskDigest: "2".repeat(64),
      baseSha: "a".repeat(40),
      reviewedHeadSha: "b".repeat(40),
      runtimeDigest: "a".repeat(64),
      providerDigest: "b".repeat(64),
      modelDigest: "c".repeat(64),
      resourceDigest: "d".repeat(64),
      repositoryContextBundleDigest: "e".repeat(64),
      stage: "validation",
      createdAt: "2026-08-22T05:59:12.000Z",
      result: validationResult,
      resultDigest: digest(validationResult),
    };
    const validationPath = join(attemptRoot, "validation-receipt.json");
    const validationRaw = JSON.stringify(validation);
    writeFileSync(validationPath, validationRaw);
    Object.assign(attempt, {
      reviewerValidationReceipt: { path: validationPath, digest: sha256(validationRaw), status: "passed" },
    });
    writeFileSync(join(stateDir, "state.json"), `${JSON.stringify({
      version: 1,
      activeJob: {
        id: "job-001",
        revision: 8,
        state: "blocked",
        task: {
          repo: "owner/repo",
          issueNumber: 48,
          mapNumber: null,
          title: "Transport projection",
          objective: "SECRET_TASK_BODY",
          labels: ["ready-for-agent"],
          issueUpdatedAt: "2026-08-22T05:59:00.000Z",
          digest: "2".repeat(64),
        },
        baseSha: "a".repeat(40),
        claimConfirmed: true,
        headSha: "b".repeat(40),
        branch: "agent/issue-48",
        worktree: null,
        analyst: null,
        activeAttempt: attempt,
        attempts: [{ ...attempt, id: "reviewer-000", reviewerCheckpointInputs: undefined }],
        reviewRound: 2,
        maxReviewRounds: 3,
        pendingHandoff: null,
        incident,
        analysis: {
          id: "analysis-001",
          incidentId: incident.id,
          evidenceDigest: incident.evidenceDigest,
          action: "retry_fresh_reviewer",
          summary: "SECRET_ANALYST_SUMMARY",
          resolutionBrief: "Use a fresh Reviewer.",
          evidenceRefs: [],
          unknowns: [],
          createdAt: "2026-08-22T06:02:00.000Z",
        },
        approval: null,
        automaticRecoveries: [],
        pullRequest: { number: 50, url: "https://github.com/owner/repo/pull/50", headSha: "b".repeat(40) },
        ciFailure: null,
        ciReworkCount: 0,
        lastError: "SECRET_STACK",
        createdAt: "2026-08-22T05:59:00.000Z",
        updatedAt: "2026-08-22T06:02:00.000Z",
      },
      terminalJobs: [],
    })}\n`, { mode: 0o600 });
    writeFileSync(join(stateDir, "controller-heartbeat.json"), JSON.stringify({
      version: 1,
      parentPid: process.pid,
      updatedAt: new Date().toISOString(),
    }), { mode: 0o600 });
    writeFileSync(join(stateDir, "controller-lease.json"), JSON.stringify({
      version: 1,
      instanceId: "controller-fixture",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }), { mode: 0o600 });
    writeFileSync(harnessConfig, JSON.stringify({
      repo: "owner/repo",
      stateDir,
      workerArgv: [],
      reviewerArgv: [],
      diagnostics: { projectId: "Exposure-Agent" },
    }), { mode: 0o600 });
    writeFileSync(observerConfig, JSON.stringify({
      transportVersion: 2,
      routeId: "exposure",
      projectId: "Exposure-Agent",
      fleetId: "engineering-fleet",
      harnessConfig,
    }), { mode: 0o600 });

    const result = spawnSync(process.execPath, [
      resolve("dist/src/transport-cli.js"), "project", "status", "--config", observerConfig, "--json", "v2",
    ], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.version, 2);
    assert.equal(envelope.kind, "project-view");
    assert.equal(envelope.routeId, "exposure");
    assert.equal(envelope.projectId, "Exposure-Agent");
    assert.equal(envelope.fleetId, "engineering-fleet");
    assert.equal(envelope.project.controller.health, "healthy");
    assert.equal(envelope.workflow.mode, "needs_decision");
    assert.equal(envelope.workflow.state, "blocked");
    assert.equal(envelope.workflow.attemptId, "reviewer-001");
    assert.equal(envelope.runtime.adapter, "pi-rpc");
    assert.match(envelope.runtime.provider, /^sha256:[0-9a-f]{64}$/);
    assert.match(envelope.runtime.model, /^sha256:[0-9a-f]{64}$/);
    assert.equal(envelope.runtime.credentialMode, "canonical-oauth");
    assert.equal(envelope.runtime.axisConcurrency, 1);
    assert.equal(envelope.runtime.lastProgressType, "assistant_message_end");
    assert.equal(envelope.runtime.lastProgressAt, "2026-08-22T06:00:30.000Z");
    assert.equal(envelope.runtime.elapsedMs, 30_000);
    assert.equal(envelope.failure.taxonomyDomain, "execution");
    assert.equal(envelope.failure.failureCode, "provider_unavailable");
    assert.equal(envelope.failure.retryable, true);
    assert.deepEqual(envelope.reviewer.reusedCheckpointStages, ["standards-axis"]);
    assert.deepEqual(envelope.reviewer.missingAxisStages, ["spec-axis"]);
    assert.equal(envelope.reviewer.validationStatus, "passed");
    assert.equal(envelope.reviewer.validationDurationMs, 12_000);
    assert.deepEqual(envelope.reviewer.validationOutputByteBuckets, { stdout: "64k_256k", stderr: "lt64k" });
    assert.deepEqual(envelope.reviewer.validationOutputDigests, { stdout: "6".repeat(64), stderr: "7".repeat(64) });
    assert.deepEqual(envelope.actions.map((action: { kind: string }) => action.kind), ["approve_retry"]);
    assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 32 * 1024);
    for (const secret of [
      "SECRET_PROVIDER_RESPONSE",
      "SECRET_PROVIDER_SELECTOR",
      "SECRET_MODEL_SELECTOR",
      "SECRET_TASK_BODY",
      "SECRET_INCIDENT_TEXT",
      "SECRET_ANALYST_SUMMARY",
      "SECRET_STACK",
      "SECRET_PROGRESS_PAYLOAD",
      "SECRET_VALIDATION_OUTPUT",
      "SECRET_VALIDATION_ERROR",
      root,
    ]) assert.equal(result.stdout.includes(secret), false, secret);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(value: string): string {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}
