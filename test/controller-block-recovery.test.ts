import test from "node:test";
import assert from "node:assert/strict";
import { HarnessController } from "../src/controller.js";
import { LocalEvidence } from "../src/adapters/local-evidence.js";
import { assertJobInvariant } from "../src/model.js";
import { classifyProviderFailure, PiRpcRuntimeFailure } from "../src/pi-rpc-diagnostics.js";
import { automaticRecoveryFor, operatorActionsFor, projectOperatorState } from "../src/policy.js";
import { approveRecovery, cancelHeldJob, reassessIncident, resolveDecision } from "../src/recovery.js";
import type { HarnessConfig } from "../src/ports.js";
import {
  FakeAnalyst,
  FakeClock,
  FakeEvidence,
  FakeGit,
  FakeGitHub,
  FakeHerdr,
  FakeRuntimePreflight,
  MemoryStore,
  SequenceIds,
  issue,
  validReviewerArgv,
  validWorkerArgv,
} from "./fakes.js";

const config: HarnessConfig = {
  repo: "owner/repo",
  localPath: "/repo",
  stateDir: "/state",
  baseRef: "main",
  readyLabel: "ready-for-agent",
  claimLabel: "agent:claimed",
  worktreeRoot: "/worktrees",
  maxReviewRounds: 3,
  maxAnalystTurns: 3,
  reviewerValidationArgv: ["npm", "run", "verify"],
  workerArgv: validWorkerArgv,
  reviewerArgv: validReviewerArgv,
};

test("structured runtime diagnostics survive blocking and reach Analyst evidence", async () => {
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const herdr = new FakeHerdr([]);
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 96, title: "Diagnose Provider failure" })]),
    git: new FakeGit(),
    herdr,
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock,
    ids,
    preflight: new FakeRuntimePreflight(),
  });
  for (let index = 0; index < 10 && store.state.activeJob?.activeAttempt?.phase !== "running"; index += 1) {
    await controller.tick();
  }
  assert.equal(store.state.activeJob?.activeAttempt?.phase, "running");

  const diagnostic = classifyProviderFailure("error", "HTTP 529 overloaded_error access_token_SECRET", {
    providerApi: "anthropic-messages",
    phase: "tool_continuation",
    turnCount: 2,
    assistantMessageCount: 3,
    toolExecutionCount: 1,
    toolErrorCount: 0,
    transcriptBytes: 70_000,
  });
  herdr.waitFailure = new PiRpcRuntimeFailure("safe runtime failure", diagnostic);
  assert.equal((await controller.tick()).action, "attempt_reconciling");
  herdr.waitFailure = new PiRpcRuntimeFailure("safe runtime failure", diagnostic);
  assert.equal((await controller.tick()).action, "blocked");

  const job = store.state.activeJob!;
  assert.deepEqual(job.incident?.runtimeDiagnostic, diagnostic);
  assertJobInvariant(job);
  const evidence = await new LocalEvidence().initial(job);
  const runtimeEvidence = evidence.items.find((entry) => entry.ref === "runtime-diagnostic");
  assert.ok(runtimeEvidence);
  assert.match(runtimeEvidence.summary, /provider_overloaded/);
  assert.equal(runtimeEvidence.summary.includes("access_token_SECRET"), false);
});

test("an exact held pre-PR job can be cancelled, archived, and selected again", async () => {
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const github = new FakeGitHub([issue({ number: 73, title: "Requeue held integrity work" })]);
  const herdr = new FakeHerdr([{ lane: "worker", status: "blocked", summary: "old runtime cannot publish a trusted result" }]);
  const controller = new HarnessController({
    config,
    store,
    github,
    git: new FakeGit(),
    herdr,
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock,
    ids,
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 9; index += 1) await controller.tick();
  const held = store.state.activeJob!;
  assert.equal(held.state, "blocked");
  assert.equal(held.analysis?.action, "hold");
  assert.deepEqual(operatorActionsFor(held).map((action) => action.kind), ["cancel"]);

  await cancelHeldJob(store, {
    expectedRevision: held.revision,
    incidentId: held.incident!.id,
    analysisId: held.analysis!.id,
    actor: "human@example.test",
    reason: "Retire the fail-closed run and let the corrected runtime claim a new job.",
  }, { clock, ids });
  assert.equal(store.state.activeJob?.state, "cancelled");

  assert.equal((await controller.tick()).action, "archived");
  assert.equal(store.state.terminalJobs[0]?.state, "cancelled");
  assert.ok(github.graph[0]?.labels.includes("ready-for-agent"));
  assert.ok(!github.graph[0]?.labels.includes("agent:claimed"));
  assert.equal(herdr.closed.length, 1);

  assert.equal((await controller.tick()).action, "selected");
  assert.equal(store.state.activeJob?.task.issueNumber, 73);
  assert.ok(store.state.activeJob?.id !== held.id);
});

test("blocked work cannot resume before exact human approval and recovery always uses a fresh worker", async () => {
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const github = new FakeGitHub([issue({ number: 31, title: "Needs a decision" })]);
  const herdr = new FakeHerdr([
    { lane: "worker", status: "blocked", summary: "Need an explicit compatibility choice" },
    { lane: "worker", status: "completed", headSha: "b".repeat(40) },
  ]);
  const analyst = new FakeAnalyst([
    {
      kind: "need_evidence",
      requests: [{ kind: "git_diff", path: null, reason: "confirm the current change boundary" }],
    },
    {
      kind: "advice",
      action: "retry_fresh_worker",
      summary: "Use the existing public interface and avoid a schema migration",
      resolutionBrief: "Keep the public interface unchanged; implement the compatibility adapter and rerun focused tests.",
      evidenceRefs: ["task", "git_diff-0"],
      unknowns: [],
    },
  ]);
  const controller = new HarnessController({
    config,
    store,
    github,
    git: new FakeGit(),
    herdr,
    analyst,
    evidence: new FakeEvidence(),
    clock,
    ids,
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 8; index += 1) await controller.tick();
  assert.equal(store.state.activeJob?.state, "blocked");
  const blockedAttemptId = store.state.activeJob?.activeAttempt?.id;
  assert.ok(blockedAttemptId);
  assert.equal(store.state.activeJob?.analysis, null);

  const diagnosis = await controller.tick();
  assert.equal(diagnosis.action, "analysis_recorded");
  const blocked = store.state.activeJob!;
  assert.equal(blocked.analysis?.action, "retry_fresh_worker");
  const retryOption = operatorActionsFor(blocked).find((action) => action.kind === "approve_retry");
  assert.ok(retryOption);
  assert.equal(projectOperatorState(store.state).mode, "needs_decision");
  assert.ok(
    operatorActionsFor({ ...blocked, revision: blocked.revision + 1 }).find((action) => action.kind === "approve_retry")?.id
      !== retryOption.id,
  );

  await assert.rejects(
    () => approveRecovery(
      store,
      {
        expectedRevision: blocked.revision - 1,
        incidentId: blocked.incident!.id,
        analysisId: blocked.analysis!.id,
        actor: "human@example.test",
        reason: "reviewed",
      },
      { clock, ids },
    ),
    /stale job revision/,
  );
  assert.equal(store.state.activeJob?.state, "blocked");

  await approveRecovery(
    store,
    {
      expectedRevision: blocked.revision,
      incidentId: blocked.incident!.id,
      analysisId: blocked.analysis!.id,
      actor: "human@example.test",
      reason: "Evidence supports the bounded retry",
    },
    { clock, ids },
  );
  assert.equal(store.state.activeJob?.state, "recovery_approved");

  const applied = await controller.tick();
  assert.equal(applied.action, "recovery_applied");
  assert.equal(store.state.activeJob?.state, "worker_ready");
  assert.equal(herdr.closed.length, 1);
  const handoff = store.state.activeJob?.pendingHandoff;
  assert.equal(handoff?.kind, "approved_recovery");
  assert.equal(handoff?.source.incidentId, blocked.incident?.id);
  assert.equal(handoff?.source.approvalId, store.state.activeJob?.approval?.id);
  assert.equal(handoff?.target.lane, "worker");
  assert.deepEqual(handoff?.evidenceRefs, ["task", "git_diff-0"]);
  assert.match(handoff?.obligations[0]?.summary ?? "", /Keep the public interface unchanged/);

  await controller.tick();
  assert.equal(store.state.activeJob?.pendingHandoff, null);
  assert.deepEqual(store.state.activeJob?.activeAttempt?.contextEnvelope?.handoff?.value, handoff);
  const freshAttemptId = store.state.activeJob?.activeAttempt?.id;
  assert.ok(freshAttemptId);
  assert.ok(freshAttemptId !== blockedAttemptId);
  for (let index = 0; index < 3; index += 1) await controller.tick();
  const recoveryPrompt = herdr.prompts.at(-1)?.text ?? "";
  assert.match(recoveryPrompt, /Typed handoff: approved_recovery/);
  assert.match(recoveryPrompt, /Keep the public interface unchanged/);
  assert.equal(recoveryPrompt.includes(freshAttemptId), true);
});

test("a transiently late Worker result is accepted on one same-attempt reconciliation", async () => {
  const headSha = "b".repeat(40);
  const store = new MemoryStore();
  const herdr = new FakeHerdr([{ lane: "worker", status: "completed", headSha }]);
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 32, title: "Observe a transiently late Worker result" })]),
    git: new FakeGit(),
    herdr,
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 7; index += 1) await controller.tick();
  const attemptId = store.state.activeJob!.activeAttempt!.id;
  herdr.settleWithoutResult = { agentStatus: "idle", diagnostic: "result file is still flushing" };
  assert.equal((await controller.tick()).action, "attempt_reconciling");
  assert.equal(store.state.activeJob?.incident, null);
  assert.equal(store.state.activeJob?.activeAttempt?.id, attemptId);
  herdr.lateResultAttemptId = attemptId;

  assert.equal((await controller.tick()).action, "attempt_completed");
  assert.equal(store.state.activeJob?.state, "reviewer_ready");
  assert.equal(store.state.activeJob?.incident, null);
});

test("an approved retry rechecks and accepts a late exact Worker result before starting fresh work", async () => {
  const headSha = "b".repeat(40);
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const git = new FakeGit();
  const herdr = new FakeHerdr([{ lane: "worker", status: "completed", headSha }]);
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 32, title: "Reconcile a late Worker result" })]),
    git,
    herdr,
    analyst: new FakeAnalyst([{
      kind: "advice",
      action: "retry_fresh_worker",
      summary: "The original Worker result did not arrive in time",
      resolutionBrief: "Start a fresh Worker only if the original result is still absent.",
      evidenceRefs: ["task"],
      unknowns: [],
    }]),
    evidence: new FakeEvidence(),
    clock,
    ids,
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 7; index += 1) await controller.tick();
  herdr.settleWithoutResult = { agentStatus: "idle", diagnostic: "Pi is auto-compacting" };
  assert.equal((await controller.tick()).action, "attempt_reconciling");
  assert.equal((await controller.tick()).action, "blocked");
  assert.deepEqual(store.state.activeJob?.incident?.runtimeDiagnostic && {
    domain: store.state.activeJob.incident.runtimeDiagnostic.domain,
    code: store.state.activeJob.incident.runtimeDiagnostic.code,
    stage: store.state.activeJob.incident.runtimeDiagnostic.stage,
    retryable: store.state.activeJob.incident.runtimeDiagnostic.retryable,
  }, {
    domain: "acceptance",
    code: "result_missing",
    stage: "result-validation",
    retryable: false,
  });
  const blockedAttemptId = store.state.activeJob!.activeAttempt!.id;
  assert.equal((await controller.tick()).action, "analysis_recorded");
  const blocked = store.state.activeJob!;
  await approveRecovery(store, {
    expectedRevision: blocked.revision,
    incidentId: blocked.incident!.id,
    analysisId: blocked.analysis!.id,
    actor: "human@example.test",
    reason: "Permit a fresh Worker only after one final exact-attempt observation.",
  }, { clock, ids });
  herdr.lateResultAttemptId = blockedAttemptId;

  assert.equal((await controller.tick()).action, "attempt_completed");
  assert.equal(store.state.activeJob?.state, "reviewer_ready");
  assert.equal(store.state.activeJob?.attempts.at(-1)?.id, blockedAttemptId);
  assert.equal(store.state.activeJob?.headSha, headSha);
  assert.equal(store.state.activeJob?.incident, null);
  assert.equal(store.state.activeJob?.analysis, null);
  assert.equal(store.state.activeJob?.approval, null);
  assert.equal(herdr.prepared.filter((entry) => entry.lane === "worker").length, 1);
  assert.deepEqual(git.workerVerifications.at(-1), {
    reportedHeadSha: headSha,
    expectedRemoteHeadSha: null,
  });
});

test("Reviewer infrastructure failure automatically retries once despite unknown review outcomes", async () => {
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const herdr = new FakeHerdr([
    { lane: "worker", status: "completed", headSha: "b".repeat(40) },
    { lane: "reviewer", status: "pass", reviewedHeadSha: "b".repeat(40) },
  ]);
  const analyst = new FakeAnalyst([{
    kind: "advice",
    action: "retry_fresh_reviewer",
    summary: "The Reviewer provider failed before producing a durable result",
    resolutionBrief: "Retry the independent review against the unchanged implementation HEAD.",
    evidenceRefs: ["task"],
    unknowns: [
      "the fixed validation result is unknown until a fresh Reviewer runs",
      "the unchanged HEAD has not yet received an independent verdict",
    ],
  }]);
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 33, title: "Retry failed review infrastructure" })]),
    git: new FakeGit(),
    herdr,
    analyst,
    evidence: new FakeEvidence(),
    clock,
    ids,
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 13; index += 1) await controller.tick();
  const failedReviewerId = store.state.activeJob?.activeAttempt?.id;
  herdr.settleWithoutResult = {
    agentStatus: "idle",
    diagnostic: "provider sessions are full",
  };
  assert.equal((await controller.tick()).action, "attempt_reconciling");
  await controller.tick();

  assert.equal(store.state.activeJob?.state, "blocked");
  assert.equal(store.state.activeJob?.incident?.class, "infrastructure_exhausted");
  assert.equal(store.state.activeJob?.incident?.lane, "reviewer");
  assert.deepEqual(store.state.activeJob?.incident?.allowedActions, ["retry_fresh_reviewer", "hold"]);
  assert.match(store.state.activeJob?.incident?.summary ?? "", /provider sessions are full/);

  const authorization = await controller.tick();
  assert.equal(authorization.action, "auto_recovery_authorized");
  const approved = store.state.activeJob!;
  assert.equal(approved.state, "recovery_approved");
  assert.equal(approved.analysis?.action, "retry_fresh_reviewer");
  assert.equal(approved.approval?.basis, "policy_rule");
  assert.equal(approved.approval?.action, "retry_fresh_reviewer");
  assert.equal(approved.automaticRecoveries?.length, 1);
  assert.equal(approved.automaticRecoveries?.[0]?.policyRule, "reviewer_same_head_infrastructure");
  assert.deepEqual(operatorActionsFor(approved), []);
  assert.throws(
    () => assertJobInvariant({
      ...approved,
      approval: { ...approved.approval!, action: "hold" as never },
    }),
    /recovery action/,
  );
  assert.throws(
    () => assertJobInvariant({
      ...approved,
      analysis: { ...approved.analysis!, action: "retry_fresh_reviewer_typo" as never },
    }),
    /recovery action/,
  );
  assert.throws(
    () => assertJobInvariant({
      ...approved,
      automaticRecoveries: [{ ...approved.automaticRecoveries![0]!, action: "retry_fresh_worker" }],
    }),
    /automatic recovery history/,
  );

  const recovery = await controller.tick();
  assert.match(recovery.message, /fresh Reviewer/);
  assert.equal(store.state.activeJob?.state, "reviewer_ready");
  assert.equal(store.state.activeJob?.headSha, "b".repeat(40));
  assert.equal(store.state.activeJob?.reviewRound, 0);
  assert.equal(herdr.closed.length, 2);

  for (let index = 0; index < 6; index += 1) await controller.tick();
  assert.equal(store.state.activeJob?.state, "publish_ready");
  assert.equal(herdr.prepared.filter((entry) => entry.lane === "worker").length, 1);
  assert.equal(herdr.prepared.filter((entry) => entry.lane === "reviewer").length, 2);
  assert.ok(herdr.prepared.at(-1)?.attemptId !== failedReviewerId);
});

test("Worker pre-dispatch infrastructure failure automatically retries once per base", async () => {
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const herdr = new FakeHerdr([]);
  const advice = {
    kind: "advice" as const,
    action: "retry_fresh_worker" as const,
    summary: "The Worker runtime failed before prompt dispatch",
    resolutionBrief: "Start one fresh Worker against the unchanged base.",
    evidenceRefs: ["task"],
    unknowns: [],
  };
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 36, title: "Retry pre-dispatch Worker infrastructure" })]),
    git: new FakeGit(),
    herdr,
    analyst: new FakeAnalyst([advice, advice]),
    evidence: new FakeEvidence(),
    clock,
    ids,
    preflight: new FakeRuntimePreflight(),
  });

  for (let tick = 0; tick < 12 && store.state.activeJob?.activeAttempt?.phase !== "pane_ready"; tick += 1) {
    await controller.tick();
  }
  assert.equal(store.state.activeJob?.activeAttempt?.phase, "pane_ready");
  herdr.startFailure = new Error("Worker provider startup failed");
  assert.equal((await controller.tick()).action, "attempt_reconciling");
  herdr.startFailure = new Error("Worker provider startup failed");
  assert.equal((await controller.tick()).action, "blocked");
  assert.equal(store.state.activeJob?.incident?.automaticRecovery?.rule, "worker_pre_dispatch_infrastructure");
  assert.equal(automaticRecoveryFor(store.state.activeJob!, {
    ...advice,
    id: "analysis-with-unknown",
    incidentId: store.state.activeJob!.incident!.id,
    evidenceDigest: "a".repeat(64),
    createdAt: "2026-08-10T00:00:00.000Z",
    unknowns: ["whether the Worker received the prompt"],
  }), null);

  assert.equal((await controller.tick()).action, "auto_recovery_authorized");
  const first = store.state.activeJob!;
  assert.equal(first.approval?.basis, "policy_rule");
  assert.equal(first.automaticRecoveries?.length, 1);
  const fingerprint = first.automaticRecoveries?.[0]?.fingerprint;
  assert.ok(fingerprint);
  assert.equal((await controller.tick()).action, "recovery_applied");

  for (let tick = 0; tick < 4 && store.state.activeJob?.activeAttempt?.phase !== "pane_ready"; tick += 1) {
    await controller.tick();
  }
  assert.equal(store.state.activeJob?.activeAttempt?.phase, "pane_ready");
  herdr.startFailure = new Error("Worker provider startup failed");
  assert.equal((await controller.tick()).action, "attempt_reconciling");
  herdr.startFailure = new Error("Worker provider startup failed");
  assert.equal((await controller.tick()).action, "blocked");
  assert.equal(store.state.activeJob?.incident?.automaticRecovery?.fingerprint, fingerprint);

  assert.equal((await controller.tick()).action, "analysis_recorded");
  const repeated = store.state.activeJob!;
  assert.equal(repeated.state, "blocked");
  assert.equal(repeated.approval, null);
  assert.equal(repeated.automaticRecoveries?.length, 1);
  assert.ok(operatorActionsFor(repeated).some((action) => action.kind === "approve_retry"));
});

test("held Reviewer infrastructure incident can be reassessed without granting retry authority", async () => {
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const herdr = new FakeHerdr([
    { lane: "worker", status: "completed", headSha: "b".repeat(40) },
    { lane: "reviewer", status: "pass" },
  ]);
  const github = new FakeGitHub([issue({ number: 34, title: "Reassess held review infrastructure" })]);
  const analyst = new FakeAnalyst([
    {
      kind: "advice",
      action: "hold",
      summary: "Wait until Reviewer provider capacity changes",
      resolutionBrief: "",
      evidenceRefs: ["task"],
      unknowns: ["Reviewer provider health"],
    },
    {
      kind: "advice",
      action: "retry_fresh_reviewer",
      summary: "A different Reviewer provider passed a bounded health probe",
      resolutionBrief: "Retry independent review against the unchanged HEAD.",
      evidenceRefs: ["task"],
      unknowns: [],
    },
  ]);
  const controller = new HarnessController({
    config,
    store,
    github,
    git: new FakeGit(),
    herdr,
    analyst,
    evidence: new FakeEvidence(),
    clock,
    ids,
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 13; index += 1) await controller.tick();
  herdr.settleWithoutResult = { agentStatus: "idle", diagnostic: "provider sessions are full" };
  await controller.tick();
  await controller.tick();
  await controller.tick();
  const held = store.state.activeJob!;
  const oldIncidentId = held.incident!.id;
  const oldAnalysisId = held.analysis!.id;
  const oldAttemptId = held.activeAttempt!.id;
  assert.equal(held.analysis?.action, "hold");
  assert.deepEqual(operatorActionsFor(held).map((action) => action.kind), ["reassess", "cancel"]);

  await assert.rejects(
    () => reassessIncident(
      store,
      {
        expectedRevision: held.revision - 1,
        incidentId: oldIncidentId,
        analysisId: oldAnalysisId,
        actor: "human@example.test",
        reason: "Reviewer switched to baizhi-chat/deepseek-v4-flash; bounded read-tool probe passed.",
      },
      { clock, ids },
    ),
    /stale job revision/,
  );

  const reassessment = await reassessIncident(
    store,
    {
      expectedRevision: held.revision,
      incidentId: oldIncidentId,
      analysisId: oldAnalysisId,
      actor: "human@example.test",
      reason: "Reviewer switched to baizhi-chat/deepseek-v4-flash; bounded read-tool probe passed.",
    },
    { clock, ids },
  );
  const reassessed = store.state.activeJob!;
  assert.equal(reassessment.incidentId, oldIncidentId);
  assert.equal(reassessment.analysisId, oldAnalysisId);
  assert.equal(reassessed.state, "blocked");
  assert.equal(reassessed.analysis, null);
  assert.ok(reassessed.incident?.id !== oldIncidentId);
  assert.equal(reassessed.activeAttempt?.id, oldAttemptId);
  assert.match(reassessed.incident?.summary ?? "", /baizhi-chat\/deepseek-v4-flash/);
  assert.equal(reassessed.reassessments?.length, 1);
  assert.equal(herdr.closed.length, 1);

  const diagnosis = await controller.tick();
  assert.equal(diagnosis.action, "analysis_recorded");
  assert.equal(store.state.activeJob?.analysis?.action, "retry_fresh_reviewer");
  assert.equal(store.state.activeJob?.state, "blocked");
  assert.equal(herdr.prepared.filter((entry) => entry.lane === "reviewer").length, 1);

  await approveRecovery(
    store,
    {
      expectedRevision: store.state.activeJob!.revision,
      incidentId: store.state.activeJob!.incident!.id,
      analysisId: store.state.activeJob!.analysis!.id,
      actor: "human@example.test",
      reason: "approve the newly assessed Reviewer retry",
    },
    { clock, ids },
  );
  assert.equal((await controller.tick()).action, "recovery_applied");
  assert.equal((await controller.tick()).action, "attempt_prepared");
  assert.equal((await controller.tick()).action, "reviewer_validation_ready");
  assert.equal((await controller.tick()).action, "attempt_pane_ready");
  assert.equal((await controller.tick()).action, "attempt_agent_ready");
  assert.equal((await controller.tick()).action, "attempt_dispatched");
  assert.equal((await controller.tick()).action, "attempt_completed");
  assert.equal((await controller.tick()).action, "published");
  github.mergeStatus = "merged";
  assert.equal((await controller.tick()).action, "merged");
  assert.equal((await controller.tick()).action, "archived");
  assert.deepEqual(store.state.terminalJobs[0]?.reassessments, [reassessment]);
});

test("held Reviewer validation block can be reassessed and retried on the same HEAD", async () => {
  const headSha = "b".repeat(40);
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const herdr = new FakeHerdr([
    { lane: "worker", status: "completed", headSha },
    {
      lane: "reviewer",
      status: "blocked",
      reviewedHeadSha: headSha,
      summary: "Required validation could not start because Docker Compose was unavailable",
    },
    { lane: "reviewer", status: "pass", reviewedHeadSha: headSha },
  ]);
  const analyst = new FakeAnalyst([
    {
      kind: "advice",
      action: "hold",
      summary: "Repair the Reviewer validation environment before retrying",
      resolutionBrief: "",
      evidenceRefs: ["task"],
      unknowns: ["Reviewer validation environment"],
    },
    {
      kind: "advice",
      action: "retry_fresh_reviewer",
      summary: "The repaired validation environment passed a bounded probe",
      resolutionBrief: "Retry independent review against the unchanged HEAD.",
      evidenceRefs: ["task"],
      unknowns: [],
    },
  ]);
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 37, title: "Reassess blocked Reviewer validation" })]),
    git: new FakeGit(),
    herdr,
    analyst,
    evidence: new FakeEvidence(),
    clock,
    ids,
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 14; index += 1) await controller.tick();
  assert.equal(store.state.activeJob?.state, "blocked");
  assert.equal(store.state.activeJob?.incident?.class, "review_uncertain");
  assert.equal(store.state.activeJob?.activeAttempt?.result?.lane, "reviewer");
  assert.equal(store.state.activeJob?.activeAttempt?.result?.status, "blocked");
  const blockedAttemptId = store.state.activeJob!.activeAttempt!.id;

  assert.equal((await controller.tick()).action, "analysis_recorded");
  const held = store.state.activeJob!;
  assert.equal(held.analysis?.action, "hold");

  await reassessIncident(
    store,
    {
      expectedRevision: held.revision,
      incidentId: held.incident!.id,
      analysisId: held.analysis!.id,
      actor: "human@example.test",
      reason: "A credential-free Docker Compose config passed the isolated Reviewer probe.",
    },
    { clock, ids },
  );
  assert.equal(store.state.activeJob?.analysis, null);
  assert.equal(store.state.activeJob?.approval, null);

  assert.equal((await controller.tick()).action, "analysis_recorded");
  assert.equal(store.state.activeJob?.analysis?.action, "retry_fresh_reviewer");
  await approveRecovery(
    store,
    {
      expectedRevision: store.state.activeJob!.revision,
      incidentId: store.state.activeJob!.incident!.id,
      analysisId: store.state.activeJob!.analysis!.id,
      actor: "human@example.test",
      reason: "Approve one bounded fresh review against the unchanged HEAD.",
    },
    { clock, ids },
  );

  assert.equal((await controller.tick()).action, "recovery_applied");
  assert.equal(store.state.activeJob?.state, "reviewer_ready");
  assert.equal(store.state.activeJob?.headSha, headSha);
  assert.equal((await controller.tick()).action, "attempt_prepared");
  const freshAttemptId = store.state.activeJob!.activeAttempt!.id;
  assert.ok(freshAttemptId !== blockedAttemptId);
  assert.equal((await controller.tick()).action, "reviewer_validation_ready");
  assert.equal((await controller.tick()).action, "attempt_pane_ready");
  assert.equal((await controller.tick()).action, "attempt_agent_ready");
  assert.equal((await controller.tick()).action, "attempt_dispatched");
  assert.equal((await controller.tick()).action, "attempt_completed");
  assert.equal(store.state.activeJob?.state, "publish_ready");
});

test("legacy pre-start Reviewer residue is reassessed through an auditable compatibility migration", async () => {
  const headSha = "b".repeat(40);
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const git = new FakeGit();
  const herdr = new FakeHerdr([
    { lane: "worker", status: "completed", headSha },
    { lane: "reviewer", status: "pass", reviewedHeadSha: headSha },
  ]);
  const analyst = new FakeAnalyst([
    {
      kind: "advice",
      action: "hold",
      summary: "Preserve and remove the pre-existing cache before review",
      resolutionBrief: "",
      evidenceRefs: ["task"],
      unknowns: ["worktree cleanliness"],
    },
    {
      kind: "advice",
      action: "retry_fresh_reviewer",
      summary: "The cache was preserved and the unchanged HEAD is clean",
      resolutionBrief: "Review the unchanged implementation HEAD in a fresh isolated Reviewer.",
      evidenceRefs: ["task"],
      unknowns: [],
    },
  ]);
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 38, title: "Migrate pre-start Reviewer residue" })]),
    git,
    herdr,
    analyst,
    evidence: new FakeEvidence(),
    clock,
    ids,
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 9; index += 1) await controller.tick();
  git.reviewerFailure = "worktree has changes outside Harness result files:\n?? generated.pyc";
  await controller.tick();
  const legacy = store.state.activeJob!;
  legacy.incident!.class = "integrity_violation";
  legacy.incident!.allowedActions = ["hold"];
  legacy.incident!.summary = "reviewer modified the worktree outside Harness result files:\n?? generated.pyc";
  assert.equal(legacy.activeAttempt?.handle, null);

  await controller.tick();
  const held = store.state.activeJob!;
  assert.equal(held.analysis?.action, "hold");
  git.reviewerFailure = null;

  const reassessment = await reassessIncident(
    store,
    {
      expectedRevision: held.revision,
      incidentId: held.incident!.id,
      analysisId: held.analysis!.id,
      actor: "human@example.test",
      reason: "Preserved generated.pyc, verified its digest, removed it from the task worktree, and kept the exact HEAD unchanged.",
    },
    { clock, ids },
  );
  assert.equal(store.state.activeJob?.incident?.class, "reviewer_preflight_dirty");
  assert.equal(store.state.activeJob?.analysis, null);
  assert.deepEqual(store.state.activeJob?.reassessments?.at(-1), reassessment);

  assert.equal((await controller.tick()).action, "analysis_recorded");
  await approveRecovery(
    store,
    {
      expectedRevision: store.state.activeJob!.revision,
      incidentId: store.state.activeJob!.incident!.id,
      analysisId: store.state.activeJob!.analysis!.id,
      actor: "human@example.test",
      reason: "Approve one fresh Reviewer against the unchanged clean HEAD.",
    },
    { clock, ids },
  );
  assert.equal((await controller.tick()).action, "recovery_applied");
  assert.equal(store.state.activeJob?.state, "reviewer_ready");
  assert.equal(store.state.activeJob?.headSha, headSha);
});

test("held Worker infrastructure incident can be reassessed without granting retry authority", async () => {
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const herdr = new FakeHerdr([{ lane: "worker", status: "completed", headSha: "b".repeat(40) }]);
  const analyst = new FakeAnalyst([
    {
      kind: "advice",
      action: "hold",
      summary: "Wait until Worker provider capacity changes",
      resolutionBrief: "",
      evidenceRefs: ["task"],
      unknowns: ["Worker provider health"],
    },
    {
      kind: "advice",
      action: "retry_fresh_worker",
      summary: "A different Worker provider passed a bounded health probe",
      resolutionBrief: "Retry implementation against the unchanged worktree and review findings.",
      evidenceRefs: ["task"],
      unknowns: [],
    },
  ]);
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 35, title: "Reassess held Worker infrastructure" })]),
    git: new FakeGit(),
    herdr,
    analyst,
    evidence: new FakeEvidence(),
    clock,
    ids,
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 7; index += 1) await controller.tick();
  herdr.settleWithoutResult = { agentStatus: "idle", diagnostic: "Worker provider overloaded" };
  await controller.tick();
  await controller.tick();
  await controller.tick();
  const held = store.state.activeJob!;
  assert.equal(held.incident?.lane, "worker");
  assert.equal(held.analysis?.action, "hold");

  const reassessment = await reassessIncident(
    store,
    {
      expectedRevision: held.revision,
      incidentId: held.incident!.id,
      analysisId: held.analysis!.id,
      actor: "human@example.test",
      reason: "Worker switched to openai-codex/gpt-5.6-luna; bounded read-tool probe passed.",
    },
    { clock, ids },
  );
  const reassessed = store.state.activeJob!;
  assert.equal(reassessment.analysisId, held.analysis!.id);
  assert.equal(reassessed.state, "blocked");
  assert.equal(reassessed.analysis, null);
  assert.equal(reassessed.approval, null);
  assert.equal(reassessed.incident?.lane, "worker");
  assert.ok(reassessed.incident?.id !== held.incident?.id);
  assert.match(reassessed.incident?.summary ?? "", /openai-codex\/gpt-5\.6-luna/);

  assert.equal((await controller.tick()).action, "analysis_recorded");
  assert.equal(store.state.activeJob?.analysis?.action, "retry_fresh_worker");
  assert.equal(store.state.activeJob?.approval, null);
});

test("a pre-fix Worker result with a fabricated SHA suffix can be reassessed only into a fresh Worker", async () => {
  const actualHead = `8c0c111${"0".repeat(33)}`;
  const reportedHead = `8c0c111${"b".repeat(33)}`;
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const git = new FakeGit();
  git.workerFailure = {
    class: "integrity_violation",
    reason: `worktree HEAD ${actualHead} != worker result ${reportedHead}`,
  };
  const analyst = new FakeAnalyst([
    {
      kind: "advice",
      action: "hold",
      summary: "The old Worker result channel cannot prove the full SHA",
      resolutionBrief: "",
      evidenceRefs: ["task"],
      unknowns: ["trusted Worker result"],
    },
    {
      kind: "advice",
      action: "retry_fresh_worker",
      summary: "The repaired result tool now resolves Git HEAD itself",
      resolutionBrief: "Keep the existing clean commit, rerun validation, and submit through the repaired tool without model-supplied Git provenance.",
      evidenceRefs: ["task"],
      unknowns: [],
    },
  ]);
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 75, title: "Reconcile Worker result SHA" })]),
    git,
    herdr: new FakeHerdr([{ lane: "worker", status: "completed", headSha: reportedHead }]),
    analyst,
    evidence: new FakeEvidence(),
    clock,
    ids,
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 8; index += 1) await controller.tick();
  await controller.tick();
  const held = store.state.activeJob!;
  assert.equal(held.incident?.class, "integrity_violation");
  assert.equal(held.incident?.runtimeDiagnostic?.code, "git_integrity");
  assert.equal(held.analysis?.action, "hold");
  assert.deepEqual(operatorActionsFor(held).map((action) => action.kind), ["reassess", "cancel"]);

  await reassessIncident(store, {
    expectedRevision: held.revision,
    incidentId: held.incident!.id,
    analysisId: held.analysis!.id,
    actor: "human@example.test",
    reason: "Deployed the Harness-owned HEAD resolver and its regression test passed.",
  }, { clock, ids });
  assert.equal(store.state.activeJob?.incident?.class, "infrastructure_exhausted");
  assert.deepEqual(store.state.activeJob?.incident?.allowedActions, ["retry_fresh_worker", "hold"]);
  assert.equal(store.state.activeJob?.analysis, null);

  assert.equal((await controller.tick()).action, "analysis_recorded");
  const reassessed = store.state.activeJob!;
  assert.equal(reassessed.analysis?.action, "retry_fresh_worker");
  await approveRecovery(store, {
    expectedRevision: reassessed.revision,
    incidentId: reassessed.incident!.id,
    analysisId: reassessed.analysis!.id,
    actor: "human@example.test",
    reason: "Approve one fresh Worker to revalidate and resubmit the unchanged commit.",
  }, { clock, ids });
  assert.equal((await controller.tick()).action, "recovery_applied");
  assert.equal(store.state.activeJob?.state, "worker_ready");
  assert.equal(store.state.activeJob?.headSha, null);
});

test("controller-recorded Analyst execution failure can be reassessed without granting retry authority", async () => {
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const analyst = new FakeAnalyst([]);
  const controller = new HarnessController({
    config: { ...config, maxReviewRounds: 1 },
    store,
    github: new FakeGitHub([issue({ number: 36, title: "Reassess failed Analyst execution" })]),
    git: new FakeGit(),
    herdr: new FakeHerdr([
      { lane: "worker", status: "completed", headSha: "b".repeat(40) },
      {
        lane: "reviewer",
        status: "changes",
        findings: [{ severity: "major", summary: "Fix the boundary", evidence: "src/boundary.ts:1" }],
      },
    ]),
    analyst,
    evidence: new FakeEvidence(),
    clock,
    ids,
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 15; index += 1) await controller.tick();
  const held = store.state.activeJob!;
  assert.equal(held.incident?.class, "review_uncertain");
  assert.equal(held.activeAttempt?.phase, "settled");
  assert.ok(held.activeAttempt?.result);
  assert.match(held.analysis?.summary ?? "", /Analyst diagnosis failed closed/);

  const controllerFailureDigest = held.analysis!.evidenceDigest;
  store.state.activeJob!.analysis!.evidenceDigest = "c".repeat(64);
  await assert.rejects(
    () => reassessIncident(
      store,
      {
        expectedRevision: held.revision,
        incidentId: held.incident!.id,
        analysisId: held.analysis!.id,
        actor: "human@example.test",
        reason: "A lookalike Analyst hold must not unlock reassessment.",
      },
      { clock, ids },
    ),
    /controller-recorded Analyst execution failure/,
  );
  store.state.activeJob!.analysis!.evidenceDigest = controllerFailureDigest;

  analyst.turns.push({
    kind: "advice",
    action: "retry_fresh_worker",
    summary: "The Analyst runtime is available again",
    resolutionBrief: "Apply the exact Reviewer finding, then rerun the full independent review.",
    evidenceRefs: ["task"],
    unknowns: [],
  });
  await reassessIncident(
    store,
    {
      expectedRevision: held.revision,
      incidentId: held.incident!.id,
      analysisId: held.analysis!.id,
      actor: "human@example.test",
      reason: "Codex executable is now pinned to an absolute path.",
    },
    { clock, ids },
  );
  assert.equal(store.state.activeJob?.state, "blocked");
  assert.equal(store.state.activeJob?.analysis, null);
  assert.equal(store.state.activeJob?.approval, null);
  assert.equal(store.state.activeJob?.incident?.class, "review_uncertain");
  assert.ok(store.state.activeJob?.activeAttempt?.result);

  assert.equal((await controller.tick()).action, "analysis_recorded");
  assert.equal(store.state.activeJob?.analysis?.action, "retry_fresh_worker");
  assert.equal(store.state.activeJob?.approval, null);
});

test("an exact human decision can recover an exhausted major Reviewer change into a fresh Worker", async () => {
  const headSha = "b".repeat(40);
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const herdr = new FakeHerdr([
    { lane: "worker", status: "completed", headSha },
    {
      lane: "reviewer",
      status: "changes",
      reviewedHeadSha: headSha,
      summary: "The implementation conflicts with an accepted architecture decision",
      findings: [{
        severity: "major",
        summary: "Align ADR-0003 with the approved Rerun-only behavior",
        evidence: "docs/architecture/ADR-0003.md:42",
      }],
    },
  ]);
  const controller = new HarnessController({
    config: { ...config, maxReviewRounds: 1 },
    store,
    github: new FakeGitHub([issue({ number: 39, title: "Resolve an architectural decision" })]),
    git: new FakeGit(),
    herdr,
    analyst: new FakeAnalyst([{
      kind: "advice",
      action: "hold",
      summary: "Maintainer intent is required before changing the accepted ADR",
      resolutionBrief: "",
      evidenceRefs: ["task"],
      unknowns: ["Whether Rerun-only supersedes ADR-0003"],
    }]),
    evidence: new FakeEvidence(),
    clock,
    ids,
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 15; index += 1) await controller.tick();
  const held = store.state.activeJob!;
  const oldAttemptId = held.activeAttempt!.id;
  assert.equal(held.state, "blocked");
  assert.equal(held.activeAttempt?.round, 1);
  assert.equal(held.analysis?.action, "hold");
  assert.deepEqual(operatorActionsFor(held).map((action) => action.kind), ["resolve_decision", "cancel"]);

  await assert.rejects(
    () => approveRecovery(
      store,
      {
        expectedRevision: held.revision,
        incidentId: held.incident!.id,
        analysisId: held.analysis!.id,
        actor: "maintainer@example.test",
        reason: "Rerun-only is authoritative",
      },
      { clock, ids },
    ),
    /did not recommend retry/,
  );
  await assert.rejects(
    () => resolveDecision(
      store,
      {
        expectedRevision: held.revision - 1,
        incidentId: held.incident!.id,
        analysisId: held.analysis!.id,
        actor: "maintainer@example.test",
        reason: "Rerun-only supersedes ADR-0003; update the decision record and architecture.",
      },
      { clock, ids },
    ),
    /stale job revision/,
  );

  const reviewerResult = store.state.activeJob!.activeAttempt!.result;
  if (!reviewerResult || reviewerResult.lane !== "reviewer") throw new Error("expected Reviewer result");
  reviewerResult.findings[0]!.severity = "minor";
  await assert.rejects(
    () => resolveDecision(
      store,
      {
        expectedRevision: held.revision,
        incidentId: held.incident!.id,
        analysisId: held.analysis!.id,
        actor: "maintainer@example.test",
        reason: "Rerun-only supersedes ADR-0003; update the decision record and architecture.",
      },
      { clock, ids },
    ),
    /not eligible for decision resolution/,
  );
  reviewerResult.findings[0]!.severity = "major";

  const approval = await resolveDecision(
    store,
    {
      expectedRevision: held.revision,
      incidentId: held.incident!.id,
      analysisId: held.analysis!.id,
      actor: "maintainer@example.test",
      reason: "Rerun-only supersedes ADR-0003; update the decision record and architecture.",
    },
    { clock, ids },
  );
  assert.equal(approval.basis, "human_decision");
  assert.equal(approval.action, "retry_fresh_worker");
  assert.equal(store.state.activeJob?.state, "recovery_approved");

  assert.equal((await controller.tick()).action, "recovery_applied");
  assert.equal(store.state.activeJob?.state, "worker_ready");
  assert.equal((await controller.tick()).action, "attempt_prepared");
  const freshAttemptId = store.state.activeJob!.activeAttempt!.id;
  assert.ok(freshAttemptId !== oldAttemptId);
  assert.equal((await controller.tick()).action, "attempt_pane_ready");
  assert.equal((await controller.tick()).action, "attempt_agent_ready");
  assert.equal((await controller.tick()).action, "attempt_dispatched");
  assert.match(herdr.prompts.at(-1)?.text ?? "", /Rerun-only supersedes ADR-0003/);
  assert.match(herdr.prompts.at(-1)?.text ?? "", /Align ADR-0003 with the approved Rerun-only behavior/);
});

test("integrity incidents cannot be converted into retry authority by the Analyst", async () => {
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const git = new FakeGit();
  git.workerFailure = { class: "integrity_violation", reason: "worker pushed before review" };
  const analyst = new FakeAnalyst([
    {
      kind: "advice",
      action: "retry_fresh_worker",
      summary: "try again",
      resolutionBrief: "retry",
      evidenceRefs: ["task"],
      unknowns: [],
    },
  ]);
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 32, title: "Integrity test" })]),
    git,
    herdr: new FakeHerdr([{ lane: "worker", status: "completed", headSha: "b".repeat(40) }]),
    analyst,
    evidence: new FakeEvidence(),
    clock,
    ids,
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 8; index += 1) await controller.tick();
  assert.equal(store.state.activeJob?.incident?.class, "integrity_violation");
  await controller.tick();
  const job = store.state.activeJob!;
  assert.equal(job.analysis?.action, "hold");
  await assert.rejects(
    () => reassessIncident(
      store,
      {
        expectedRevision: job.revision,
        incidentId: job.incident!.id,
        analysisId: job.analysis!.id,
        actor: "human@example.test",
        reason: "attempted reassessment outside Reviewer infrastructure",
      },
      { clock, ids },
    ),
    /HEAD-bound CI incident within the rework limit/,
  );
  await assert.rejects(
    () => approveRecovery(
      store,
      {
        expectedRevision: job.revision,
        incidentId: job.incident!.id,
        analysisId: job.analysis!.id,
        actor: "human@example.test",
        reason: "attempted override",
      },
      { clock, ids },
    ),
    /did not recommend retry/,
  );
});
