import test from "node:test";
import assert from "node:assert/strict";
import {
  automaticRecoveryEvent,
  preflightFailureEvent,
  recoveryQuotaExhaustedEvent,
} from "../src/transport/event-projection.js";
import type { AutomaticRecovery, Job } from "../src/model.js";

const identity = { routeId: "exposure", projectId: "Exposure-Agent", fleetId: "engineering-fleet" };
const now = "2026-08-22T00:00:10.000Z";

test("automatic recovery events preserve lane, boundary, checkpoint, and quota facts", () => {
  for (const lane of ["worker", "reviewer"] as const) {
    const job = fixtureJob(lane);
    const recovery: AutomaticRecovery = {
      id: `approval-provider-${lane}`,
      jobRevision: job.revision,
      incidentId: job.incident!.id,
      analysisId: null,
      action: lane === "worker" ? "retry_fresh_worker" : "retry_fresh_reviewer",
      basis: "policy_rule",
      policyRule: "provider_pre_side_effect_transient",
      fingerprint: "a".repeat(64),
      attemptId: job.activeAttempt!.id,
      scopeFingerprint: "b".repeat(64),
      lane,
      headSha: "c".repeat(40),
      provider: "SECRET_PROVIDER_SELECTOR",
      failureCode: "provider_timeout",
      notBefore: "2026-08-22T00:00:05.000Z",
      actor: "harness:auto-recovery",
      reason: "provider_pre_side_effect_transient",
      createdAt: now,
      consumedAt: null,
    };
    const event = automaticRecoveryEvent(job, recovery, identity, now);
    assert.equal(event.category, "recovery.automatic");
    assert.equal(fact(event, "Lane"), lane);
    assert.match(fact(event, "Provider"), /^sha256:[0-9a-f]{64}$/);
    assert.equal(fact(event, "Failure"), "provider_timeout");
    assert.equal(fact(event, "Not before"), recovery.notBefore);
    assert.equal(fact(event, "Attempt"), "fresh");
    assert.equal(fact(event, "Boundary"), "pre-side-effect verified");
    assert.equal(fact(event, "Quota"), "consumed for job/lane/HEAD");
    assert.equal(JSON.stringify(event).includes("SECRET_PROVIDER_SELECTOR"), false);
  }

  const reviewerJob = fixtureJob("reviewer");
  const sameHead = {
    ...fixtureRecovery(reviewerJob, "reviewer_same_head_infrastructure", "retry_fresh_reviewer"),
  } as AutomaticRecovery;
  const reviewerEvent = automaticRecoveryEvent(reviewerJob, sameHead, identity, now);
  assert.equal(fact(reviewerEvent, "HEAD"), "unchanged exact HEAD");
  assert.equal(fact(reviewerEvent, "Attempt"), "fresh Reviewer");
  assert.equal(fact(reviewerEvent, "Checkpoint reuse"), "standards-axis");

  const workerJob = fixtureJob("worker");
  const predispatch = fixtureRecovery(workerJob, "worker_pre_dispatch_infrastructure", "retry_fresh_worker");
  const workerEvent = automaticRecoveryEvent(workerJob, predispatch, identity, now);
  assert.equal(fact(workerEvent, "Dispatch"), "old Attempt not dispatched");
  assert.equal(fact(workerEvent, "Side effects"), "no tool or Git side effects");
  assert.equal(fact(workerEvent, "Attempt"), "fresh Worker");
});

test("preflight/runtime event classification is structured and legacy fallback stays neutral", () => {
  const cases = [
    ["credential_lock_timeout", "warning", false, /policy.*reevaluat/i],
    ["credential_lock_stale", "critical", true, /credential.*operator/i],
    ["oauth_refresh_timeout", "warning", false, /policy.*reevaluat/i],
    ["oauth_missing", "critical", true, /login|credential/i],
    ["oauth_probe_failed", "warning", false, /policy.*reevaluat/i],
    ["runtime_stall", "warning", true, /fresh Attempt/i],
    ["attempt_deadline", "warning", true, /fresh Attempt/i],
    ["validation_infrastructure", "critical", true, /not candidate-code failed checks/i],
    ["integrity_violation", "critical", true, /no automatic retry/i],
    ["version_drift", "critical", true, /operator/i],
    ["resource_drift", "critical", true, /operator/i],
    ["config_drift", "critical", true, /operator/i],
  ] as const;
  for (const [code, severity, actionRequired, summary] of cases) {
    const event = preflightFailureEvent({ ...identity, position: `p-${code}`, failureCode: code, retryable: code === "oauth_probe_failed" }, now);
    assert.ok(event, code);
    assert.equal(event.severity, severity, code);
    assert.equal(event.actionRequired, actionRequired, code);
    assert.match(event.summary, summary, code);
  }
  assert.equal(preflightFailureEvent({ ...identity, position: "failed-checks", failureCode: "validation_failed", retryable: false }, now), null);

  const legacy = preflightFailureEvent({ ...identity, position: "legacy", failureCode: null, retryable: null }, now)!;
  assert.equal(legacy.category, "preflight.failed");
  assert.match(legacy.summary, /reevaluated on the next Controller cycle/i);
  assert.equal(/will retry|automatic retry|success/i.test(legacy.summary), false);
});

test("a repeated automatic recovery scope becomes an attention-required quota event", () => {
  const job = fixtureJob("worker");
  job.state = "blocked";
  const consumed = fixtureRecovery(job, "worker_pre_dispatch_infrastructure", "retry_fresh_worker");
  job.automaticRecoveries = [consumed];
  job.incident!.automaticRecovery = { rule: "worker_pre_dispatch_infrastructure", fingerprint: consumed.fingerprint };
  const event = recoveryQuotaExhaustedEvent(job, identity, now);
  assert.ok(event);
  assert.equal(event.category, "recovery.exhausted");
  assert.equal(event.actionRequired, true);
  assert.equal(fact(event, "Rule"), "worker_pre_dispatch_infrastructure");
  assert.equal(fact(event, "Quota"), "exhausted or repeated failure");
});

function fixtureJob(lane: "worker" | "reviewer"): Job {
  const attempt = {
    id: `${lane}-001`,
    lane,
    phase: "settled" as const,
    round: 1,
    baseSha: "c".repeat(40),
    expectedHeadSha: lane === "reviewer" ? "c".repeat(40) : null,
    resultPath: `/private/${lane}-result.json`,
    promptDigest: "d".repeat(64),
    ...(lane === "reviewer" ? { reviewerCheckpointInputs: [{ stage: "standards-axis" as const, path: "/private/standards-axis.json", digest: "e".repeat(64), sourceAttemptId: "reviewer-000" }] } : {}),
    handle: null,
    result: null,
    startedAt: now,
    completedAt: now,
  };
  return {
    id: "job-001",
    revision: 8,
    state: "recovery_approved",
    task: { repo: "owner/repo", issueNumber: 48, mapNumber: null, title: "title", objective: "SECRET_TASK_BODY", labels: [], issueUpdatedAt: now, digest: "f".repeat(64) },
    baseSha: "c".repeat(40),
    claimConfirmed: true,
    headSha: "c".repeat(40),
    branch: "agent/issue-48",
    worktree: null,
    analyst: null,
    activeAttempt: attempt,
    attempts: [],
    reviewRound: 1,
    maxReviewRounds: 3,
    pendingHandoff: null,
    incident: { id: "incident-001", class: "infrastructure_exhausted", lane, attemptId: attempt.id, summary: "SECRET_INCIDENT", evidenceDigest: "1".repeat(64), allowedActions: [lane === "worker" ? "retry_fresh_worker" : "retry_fresh_reviewer", "hold"], createdAt: now },
    analysis: null,
    approval: null,
    automaticRecoveries: [],
    pullRequest: null,
    ciFailure: null,
    ciReworkCount: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

function fixtureRecovery(job: Job, policyRule: AutomaticRecovery["policyRule"], action: AutomaticRecovery["action"]): AutomaticRecovery {
  return {
    id: `approval-${policyRule}`,
    jobRevision: job.revision,
    incidentId: job.incident!.id,
    analysisId: "analysis-001",
    action,
    basis: "policy_rule",
    policyRule,
    fingerprint: "a".repeat(64),
    attemptId: job.activeAttempt!.id,
    actor: "harness:auto-recovery",
    reason: policyRule,
    createdAt: now,
    consumedAt: null,
  };
}

function fact(event: { facts: Array<{ label: string; value: string }> }, label: string): string {
  const value = event.facts.find((entry) => entry.label === label)?.value;
  assert.ok(value, label);
  return value;
}
