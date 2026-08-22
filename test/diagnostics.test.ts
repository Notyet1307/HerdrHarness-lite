import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JsonStateStore } from "../src/adapters/json-store.js";
import {
  aggregateDiagnosticOutput,
  diagnoseProjects,
  diagnosticAuditProjection,
} from "../src/diagnostics.js";
import { digest, type Job } from "../src/model.js";
import { classifyProviderFailure } from "../src/pi-rpc-diagnostics.js";
import { validReviewerArgv, validWorkerArgv } from "./fakes.js";

const NOW = "2026-08-22T12:00:00.000Z";

test("diagnostics aggregate safe failure receipts and isolate corrupt Attempts", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-diagnostics-"));
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify({
      version: 1,
      activeJob: null,
      terminalJobs: [
        terminalJob("job-provider", 101, "done", "2026-08-22T10:30:00.000Z"),
        terminalJob("job-validation", 102, "done", "2026-08-22T11:00:00.000Z"),
        terminalJob("job-corrupt", 103, "cancelled", "2026-08-22T11:30:00.000Z"),
      ],
      objective: "OBJECTIVE_MUST_NOT_LEAK",
    }));

    const providerDiagnostic = classifyProviderFailure("error", "HTTP 503 access_token_MUST_NOT_LEAK", {
      providerApi: "openai-codex-responses",
      phase: "tool_error_recovery",
      turnCount: 4,
      assistantMessageCount: 3,
      toolExecutionCount: 3,
      toolErrorCount: 1,
      transcriptBytes: 70_000,
    });
    const events = [
      auditEvent("2026-08-22T10:00:00.000Z", auditAttempt({
        jobId: "job-provider", attemptId: "worker-1", issueNumber: 101, lane: "worker",
        provider: "openai-codex", model: "gpt-test", incident: providerDiagnostic,
      }), 0),
      auditEvent("2026-08-22T10:20:00.000Z", null, 1, "job-provider", "recovery_approved"),
      auditEvent("2026-08-22T10:40:00.000Z", auditAttempt({
        jobId: "job-validation", attemptId: "reviewer-1", issueNumber: 102, lane: "reviewer",
        provider: "openai-codex", model: "gpt-review", incident: null,
      }), 0),
    ];
    writeFileSync(join(stateDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

    const providerRoot = attemptRoot(stateDir, "worker", "job-provider", "worker-1");
    writeReceipt(providerRoot, "terminal.json", {
      version: 1,
      attemptId: "worker-1",
      generation: "generation",
      planDigest: "a".repeat(64),
      ok: false,
      error: "RAW_PROVIDER_RESPONSE_MUST_NOT_LEAK",
      ...providerDiagnostic,
      agentSettled: false,
      controlledCompaction: {
        count: 1,
        reason: "threshold",
        triggerPercent: 75,
        contextTokens: 80_000,
        contextWindow: 100_000,
        payloadByteEstimate: 4096,
        attemptCount: 1,
        summaryRequestDurationMs: 12,
        usedRetry: false,
        outcome: "completed",
        tokensBefore: 80_000,
        estimatedTokensAfter: 12_000,
        summaryDigest: "b".repeat(64),
        willRetry: false,
      },
      providerResponse: "RAW_PROVIDER_RESPONSE_MUST_NOT_LEAK",
    });
    writeReceipt(providerRoot, "runtime-progress.json", progress("worker-1", "tool_execution_end", 240_000, false));
    writeFileSync(join(providerRoot, "runtime", "runtime-events.jsonl"), "PRIVATE_TRANSCRIPT_MUST_NOT_LEAK\n");

    const reviewerRoot = attemptRoot(stateDir, "reviewer", "job-validation", "reviewer-1");
    writeReceipt(reviewerRoot, "terminal.json", {
      version: 1,
      attemptId: "reviewer-1",
      generation: "generation",
      planDigest: "c".repeat(64),
      ok: true,
      agentSettled: true,
    });
    writeReceipt(reviewerRoot, "runtime-progress.json", progress("reviewer-1", "terminal_receipt", 600_000, true));
    writeCheckpoint(reviewerRoot, "validation-receipt.json", validationCheckpoint("job-validation", "reviewer-1"));
    writeCheckpoint(reviewerRoot, "standards-axis.json", axisCheckpoint("job-validation", "reviewer-1", "standards-axis", 300_000));

    const corruptRoot = attemptRoot(stateDir, "worker", "job-corrupt", "worker-corrupt");
    mkdirSync(join(corruptRoot, "runtime"), { recursive: true });
    const corruptTerminal = join(corruptRoot, "runtime", "terminal.json");
    writeFileSync(corruptTerminal, "{broken-receipt");
    utimesSync(corruptTerminal, new Date("2026-08-22T11:20:00.000Z"), new Date("2026-08-22T11:20:00.000Z"));

    const report = diagnoseProjects([{
      id: "api",
      repo: "owner/private-repo",
      stateDir,
      redactRepo: true,
      redactIssue: true,
    }], { days: 7, now: NOW });

    assert.equal(report.totals.failedAttempts, 3);
    assert.deepEqual(report.views.byFailureCode, { provider_unavailable: 1, unknown: 1, validation_failed: 1 });
    assert.deepEqual(report.views.byLane, { reviewer: 1, worker: 2 });
    assert.deepEqual(report.views.byRuntimeAdapter, { "pi-rpc": 2, unknown: 1 });
    assert.deepEqual(report.views.byDurableResult, { missing: 1, present: 1, unknown: 1 });
    assert.deepEqual(report.views.byCompaction, { completed: 1, none: 1, unknown: 1 });
    assert.deepEqual(report.views.byContextOutputSize, {
      transcript: { "64k_256k": 1, unknown: 2 },
      validation: { "64k_256k": 1, unknown: 2 },
      axis: { "256k_1m": 1, unknown: 2 },
    });
    assert.equal(report.corrupt.projects, 1);
    assert.equal(report.corrupt.attempts, 1);
    const corrupt = report.attempts.find((attempt) => attempt.attemptId === "worker-corrupt");
    assert.ok(corrupt);
    assert.equal(corrupt.partial, true);
    assert.equal(corrupt.corrupt, true);
    assert.deepEqual(corrupt.corruptArtifacts, ["terminal.json"]);
    const provider = report.attempts.find((attempt) => attempt.attemptId === "worker-1");
    assert.ok(provider);
    assert.equal(provider.failureDomain, "provider");
    assert.equal(provider.toolCount, 3);
    assert.equal(provider.toolErrorCount, 1);
    assert.equal(provider.automaticRecoveryCount, 1);
    assert.equal(provider.compactionCount, 1);
    assert.equal(provider.jobOutcome, "done");
    assert.equal(provider.repo, null);
    assert.equal(provider.issueNumber, null);
    const validation = report.attempts.find((attempt) => attempt.attemptId === "reviewer-1");
    assert.ok(validation);
    assert.equal(validation.validationDurationMs, 120_000);
    assert.equal(validation.validationDurationBucket, "1m_5m");
    assert.equal(validation.validationOutputSizeBucket, "64k_256k");
    assert.equal(validation.axisOutputSizeBucket, "256k_1m");

    const serialized = JSON.stringify(report);
    for (const secret of [
      "OBJECTIVE_MUST_NOT_LEAK",
      "access_token_MUST_NOT_LEAK",
      "RAW_PROVIDER_RESPONSE_MUST_NOT_LEAK",
      "PRIVATE_TRANSCRIPT_MUST_NOT_LEAK",
      "owner/private-repo",
    ]) assert.equal(serialized.includes(secret), false, secret);
    assert.equal(Object.hasOwn(aggregateDiagnosticOutput(report), "attempts"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit projection persists only bounded Attempt diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-diagnostics-audit-"));
  try {
    const job = blockedJob();
    const projection = diagnosticAuditProjection(job);
    assert.ok(projection);
    const store = new JsonStateStore(root);
    await store.save({ version: 1, activeJob: job, terminalJobs: [] }, null);
    const audit = readFileSync(join(root, "events.jsonl"), "utf8");
    for (const secret of [
      "SECRET_OBJECTIVE",
      "SECRET_RESULT_SUMMARY",
      "SECRET_INCIDENT_SUMMARY",
      "/private/auth.json",
      "SECRET_STACK",
      "access_token_PROVIDER_SECRET",
      "SECRET_MODEL",
    ]) assert.equal(audit.includes(secret), false, secret);
    assert.match(audit, /"attemptDiagnostic"/);
    assert.match(audit, /"provider_network"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("single-project and Fleet diagnose commands keep Attempt rows behind --json", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-diagnostics-cli-"));
  try {
    const source = join(root, "source");
    const stateDir = join(root, "state");
    const worktreeRoot = join(root, "worktrees");
    const fleetState = join(root, "fleet-state");
    for (const path of [source, stateDir, worktreeRoot, fleetState]) mkdirSync(path, { recursive: true });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify({ version: 1, activeJob: null, terminalJobs: [] }));
    writeFileSync(join(stateDir, "events.jsonl"), "");
    const harnessPath = join(root, "harness.json");
    writeFileSync(harnessPath, JSON.stringify({
      repo: "owner/repo",
      localPath: source,
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
      diagnostics: { projectId: "single", redactRepo: true, redactIssue: true },
      herdr: { session: "diagnostics-test" },
      analyst: { command: process.execPath },
    }));
    const single = spawnSync(process.execPath, [
      resolve("dist/src/cli.js"), "diagnose", "--config", harnessPath, "--days", "7",
    ], { encoding: "utf8" });
    assert.equal(single.status, 0, single.stderr);
    const aggregate = JSON.parse(single.stdout) as Record<string, unknown>;
    assert.equal(Object.hasOwn(aggregate, "attempts"), false);

    const fleetPath = join(root, "fleet.json");
    writeFileSync(fleetPath, JSON.stringify({
      version: 1,
      stateDir: fleetState,
      projects: [{ id: "api", config: harnessPath }],
    }));
    const fleet = spawnSync(process.execPath, [
      resolve("dist/src/fleet-cli.js"), "diagnose", "--config", fleetPath, "--days", "30", "--json",
    ], { encoding: "utf8" });
    assert.equal(fleet.status, 0, fleet.stderr);
    const detailed = JSON.parse(fleet.stdout) as { totals: { projects: number }; attempts: unknown[] };
    assert.equal(detailed.totals.projects, 1);
    assert.deepEqual(detailed.attempts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function terminalJob(id: string, issueNumber: number, state: "done" | "cancelled", finishedAt: string) {
  return { id, repo: "owner/private-repo", issueNumber, state, finishedAt };
}

function auditEvent(
  savedAt: string,
  attemptDiagnostic: Record<string, unknown> | null,
  automaticRecoveryCount: number,
  activeJobId = String(attemptDiagnostic?.jobId ?? ""),
  activeState = String(attemptDiagnostic?.jobState ?? "blocked"),
) {
  return {
    savedAt,
    expectedActiveRevision: 1,
    activeJobId,
    activeRevision: 2,
    activeState,
    automaticRecoveryCount,
    ...(attemptDiagnostic ? { attemptDiagnostic } : {}),
  };
}

function auditAttempt(input: {
  jobId: string;
  attemptId: string;
  issueNumber: number;
  lane: "worker" | "reviewer";
  provider: string;
  model: string;
  incident: ReturnType<typeof classifyProviderFailure> | null;
}) {
  return {
    version: 1,
    jobId: input.jobId,
    issueNumber: input.issueNumber,
    jobState: "blocked",
    automaticRecoveryCount: 0,
    attempt: {
      id: input.attemptId,
      lane: input.lane,
      phase: "settled",
      startedAt: "2026-08-22T09:00:00.000Z",
      completedAt: null,
      resultPresent: false,
      resultStatus: null,
      runtimeAdapter: "pi-rpc",
      piVersion: "0.84.2",
      providerId: `sha256:${digest({ kind: "provider", value: input.provider })}`,
      modelId: `sha256:${digest({ kind: "model", value: input.model })}`,
    },
    incident: input.incident ? {
      class: "infrastructure_exhausted",
      lane: input.lane,
      runtimeDiagnostic: input.incident,
    } : null,
  };
}

function attemptRoot(stateDir: string, lane: "worker" | "reviewer", jobId: string, attemptId: string): string {
  const root = join(stateDir, `${lane}-attempts`, jobId, attemptId);
  mkdirSync(join(root, "runtime"), { recursive: true });
  return root;
}

function writeReceipt(root: string, name: string, value: unknown): void {
  writeFileSync(join(root, "runtime", name), JSON.stringify(value));
}

function writeCheckpoint(root: string, name: string, value: unknown): void {
  writeFileSync(join(root, name), JSON.stringify(value));
}

function progress(attemptId: string, lastProgressType: string, elapsedMs: number, resultPresent: boolean) {
  return {
    version: 1,
    attemptId,
    generation: "generation",
    planDigest: "d".repeat(64),
    lastProgressAt: "2026-08-22T10:00:00.000Z",
    lastProgressType,
    eventCount: 4,
    elapsedMs,
    resultPresent,
    runnerPid: 123,
    childPid: null,
    digest: "e".repeat(64),
    accessToken: "PROGRESS_SECRET_MUST_NOT_LEAK",
  };
}

function validationCheckpoint(jobId: string, attemptId: string) {
  const output = {
    text: "[redacted validation output]",
    truncated: true,
    redacted: true,
    byteCount: 40_000,
    sha256: "f".repeat(64),
  };
  const result = {
    status: "failed-checks",
    validationArgv: ["npm", "run", "verify"],
    validationArgvDigest: digest(["npm", "run", "verify"]),
    startedAt: "2026-08-22T09:00:00.000Z",
    completedAt: "2026-08-22T09:02:00.000Z",
    durationMs: 120_000,
    exitCode: 1,
    signal: null,
    timeout: false,
    error: null,
    stdout: output,
    stderr: { ...output },
    dockerHost: null,
    relevantEnvironmentDigest: "1".repeat(64),
    sourceSnapshotDigest: "2".repeat(64),
  };
  return checkpoint(jobId, attemptId, "validation", 2, result);
}

function axisCheckpoint(jobId: string, attemptId: string, stage: "standards-axis" | "spec-axis", outputByteCount: number) {
  const result = {
    status: "pass",
    summary: "axis passed",
    findings: [],
    evidenceRefs: [],
    outputByteCount,
    outputDigest: "3".repeat(64),
    truncated: true,
  };
  return checkpoint(jobId, attemptId, stage, 1, result);
}

function checkpoint(jobId: string, attemptId: string, stage: string, version: number, result: unknown) {
  return {
    version,
    jobId,
    sourceAttemptId: attemptId,
    jobRevision: 7,
    taskDigest: "4".repeat(64),
    baseSha: "a".repeat(40),
    reviewedHeadSha: "b".repeat(40),
    runtimeDigest: "5".repeat(64),
    providerDigest: "6".repeat(64),
    modelDigest: "7".repeat(64),
    resourceDigest: "8".repeat(64),
    repositoryContextBundleDigest: "9".repeat(64),
    stage,
    createdAt: "2026-08-22T09:02:00.000Z",
    result,
    resultDigest: digest(result),
  };
}

function blockedJob(): Job {
  const diagnostic = classifyProviderFailure("error", "ECONNRESET SECRET_STACK", {
    providerApi: "openai-codex-responses",
    phase: "initial_generation",
    turnCount: 1,
    assistantMessageCount: 1,
    toolExecutionCount: 0,
    toolErrorCount: 0,
    transcriptBytes: 10,
  });
  const attempt = {
    id: "worker-1",
    lane: "worker" as const,
    phase: "settled" as const,
    round: 1,
    baseSha: "a".repeat(40),
    expectedHeadSha: null,
    resultPath: "/private/result.json",
    promptDigest: "b".repeat(64),
    executionSnapshot: {
      version: 1 as const,
      adapter: "pi-rpc" as const,
      executable: "/private/pi",
      runtimeVersion: "0.84.2",
      argv: ["--auth", "/private/auth.json"],
      provider: "access_token_PROVIDER_SECRET",
      model: "SECRET_MODEL",
      thinking: "high",
      tools: [],
      sessionMode: "ephemeral" as const,
      retryMode: "disabled" as const,
      compactionMode: "disabled" as const,
      credentialMode: "canonical-oauth" as const,
      dockerHost: null,
      resources: [],
    },
    planDigest: "c".repeat(64),
    handle: null,
    result: {
      version: 1 as const,
      jobId: "job-1",
      attemptId: "worker-1",
      lane: "worker" as const,
      status: "failed" as const,
      summary: "SECRET_RESULT_SUMMARY",
      headSha: null,
      failedCommands: [],
    },
    startedAt: "2026-08-22T10:00:00.000Z",
    completedAt: "2026-08-22T10:01:00.000Z",
  };
  return {
    id: "job-1",
    revision: 1,
    state: "blocked",
    task: {
      repo: "owner/repo",
      issueNumber: 1,
      mapNumber: null,
      title: "title",
      objective: "SECRET_OBJECTIVE",
      labels: [],
      issueUpdatedAt: "2026-08-22T09:00:00.000Z",
      digest: "d".repeat(64),
    },
    baseSha: "a".repeat(40),
    claimConfirmed: true,
    headSha: null,
    branch: "agent/issue-1",
    worktree: null,
    analyst: null,
    activeAttempt: attempt,
    attempts: [],
    reviewRound: 0,
    maxReviewRounds: 3,
    pendingHandoff: null,
    incident: {
      id: "incident-1",
      class: "infrastructure_exhausted",
      lane: "worker",
      attemptId: "worker-1",
      summary: "SECRET_INCIDENT_SUMMARY",
      evidenceDigest: "e".repeat(64),
      allowedActions: ["retry_fresh_worker", "hold"],
      runtimeDiagnostic: diagnostic,
      createdAt: "2026-08-22T10:01:00.000Z",
    },
    analysis: null,
    approval: null,
    automaticRecoveries: [],
    cancellation: null,
    reassessments: [],
    pullRequest: null,
    ciFailure: null,
    ciReworkCount: 0,
    lastError: "SECRET_STACK",
    createdAt: "2026-08-22T09:00:00.000Z",
    updatedAt: "2026-08-22T10:01:00.000Z",
  };
}
