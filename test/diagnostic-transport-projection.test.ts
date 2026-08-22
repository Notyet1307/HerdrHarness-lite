import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { makeSafeRuntimeDiagnostic } from "../src/pi-rpc-diagnostics.js";

test("diagnostic Transport v2 exposes only bounded project aggregates", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-transport-diagnostic-"));
  try {
    const stateDir = join(root, "state");
    const attemptRoot = join(stateDir, "worker-attempts", "job-001", "worker-001");
    const corruptRoot = join(stateDir, "worker-attempts", "job-corrupt", "worker-corrupt", "runtime");
    mkdirSync(join(attemptRoot, "runtime"), { recursive: true });
    mkdirSync(corruptRoot, { recursive: true });
    const diagnostic = makeSafeRuntimeDiagnostic({
      domain: "observation",
      code: "runtime_stall",
      stage: "agent-run",
      failureDomain: "runtime",
      failureCode: "runtime_stall",
      retryable: false,
    });
    const attempt = {
      id: "worker-001",
      lane: "worker",
      phase: "settled",
      round: 1,
      baseSha: "a".repeat(40),
      expectedHeadSha: null,
      resultPath: join(attemptRoot, "result.json"),
      promptDigest: "b".repeat(64),
      executionSnapshot: {
        version: 1,
        adapter: "pi-rpc",
        executable: "/private/pi",
        runtimeVersion: "0.84.2",
        argv: [],
        provider: "SECRET_PROVIDER",
        model: "SECRET_MODEL",
        thinking: "high",
        tools: [],
        sessionMode: "ephemeral",
        retryMode: "disabled",
        compactionMode: "disabled",
        credentialMode: "canonical-oauth",
        dockerHost: null,
        resources: [],
      },
      planDigest: "c".repeat(64),
      handle: null,
      result: {
        version: 1,
        jobId: "job-001",
        attemptId: "worker-001",
        lane: "worker",
        status: "failed",
        summary: "SECRET_RESULT",
        headSha: null,
        failedCommands: [],
      },
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: new Date().toISOString(),
    };
    const incident = {
      id: "incident-001",
      class: "infrastructure_exhausted",
      lane: "worker",
      attemptId: attempt.id,
      summary: "SECRET_INCIDENT",
      evidenceDigest: "d".repeat(64),
      allowedActions: ["retry_fresh_worker", "hold"],
      runtimeDiagnostic: diagnostic,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(stateDir, "state.json"), JSON.stringify({
      version: 1,
      activeJob: {
        id: "job-001",
        revision: 4,
        state: "blocked",
        task: { repo: "owner/repo", issueNumber: 48, mapNumber: null, title: "diagnose", objective: "SECRET_TASK_BODY", labels: [], issueUpdatedAt: new Date().toISOString(), digest: "e".repeat(64) },
        baseSha: "a".repeat(40),
        claimConfirmed: true,
        headSha: null,
        branch: "agent/issue-48",
        worktree: null,
        analyst: null,
        activeAttempt: attempt,
        attempts: [],
        reviewRound: 0,
        maxReviewRounds: 3,
        pendingHandoff: null,
        incident,
        analysis: null,
        approval: null,
        automaticRecoveries: [{
          id: "approval-001",
          jobRevision: 3,
          incidentId: incident.id,
          analysisId: "analysis-001",
          action: "retry_fresh_worker",
          basis: "policy_rule",
          policyRule: "worker_pre_dispatch_infrastructure",
          fingerprint: "f".repeat(64),
          attemptId: attempt.id,
          actor: "harness:auto-recovery",
          reason: "worker_pre_dispatch_infrastructure",
          createdAt: new Date().toISOString(),
          consumedAt: new Date().toISOString(),
        }],
        pullRequest: null,
        ciFailure: null,
        ciReworkCount: 0,
        lastError: "SECRET_STACK",
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        updatedAt: new Date().toISOString(),
      },
      terminalJobs: [],
    }));
    writeFileSync(join(stateDir, "events.jsonl"), "");
    writeFileSync(join(attemptRoot, "runtime", "runtime-progress.json"), JSON.stringify({
      version: 1,
      attemptId: attempt.id,
      lastProgressAt: new Date().toISOString(),
      lastProgressType: "durable_result",
      elapsedMs: 60_000,
      resultPresent: true,
    }));
    const corrupt = join(corruptRoot, "terminal.json");
    writeFileSync(corrupt, "{broken SECRET_TRANSCRIPT");
    utimesSync(corrupt, new Date(), new Date());
    const harnessConfig = join(root, "harness.json");
    const observerConfig = join(root, "observer.json");
    writeFileSync(harnessConfig, JSON.stringify({
      repo: "owner/repo",
      stateDir,
      workerArgv: [],
      reviewerArgv: [],
      diagnostics: { projectId: "Exposure-Agent", redactRepo: true, redactIssue: true },
    }));
    writeFileSync(observerConfig, JSON.stringify({
      transportVersion: 2,
      routeId: "exposure",
      projectId: "Exposure-Agent",
      fleetId: "engineering-fleet",
      harnessConfig,
    }), { mode: 0o600 });

    const result = spawnSync(process.execPath, [
      resolve("dist/src/transport-cli.js"), "project", "diagnose", "--config", observerConfig, "--days", "7", "--json", "v2",
    ], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.kind, "diagnostic-view");
    assert.equal(envelope.diagnostic.days, 7);
    assert.equal(envelope.diagnostic.partial, true);
    assert.equal(envelope.diagnostic.totalAttempts, 2);
    assert.equal(envelope.diagnostic.unknownAttempts, 1);
    assert.equal(envelope.diagnostic.resultPresentButTerminalMissing, 1);
    assert.equal(envelope.diagnostic.runtimeStallsAndDeadlines, 1);
    assert.equal(envelope.diagnostic.automaticRecoveryCount, 1);
    assert.equal("attempts" in envelope.diagnostic, false);
    for (const secret of [root, "SECRET_PROVIDER", "SECRET_MODEL", "SECRET_RESULT", "SECRET_INCIDENT", "SECRET_TASK_BODY", "SECRET_TRANSCRIPT", "SECRET_STACK"]) {
      assert.equal(result.stdout.includes(secret), false, secret);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
