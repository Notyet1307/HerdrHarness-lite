import test from "node:test";
import assert from "node:assert/strict";
import { HarnessController } from "../src/controller.js";
import { assertJobInvariant } from "../src/model.js";
import { approveRecovery, reassessIncident } from "../src/recovery.js";
import type { HarnessConfig } from "../src/ports.js";
import {
  FakeAnalyst,
  FakeClock,
  FakeEvidence,
  FakeGit,
  FakeGitHub,
  FakeHerdr,
  MemoryStore,
  SequenceIds,
  issue,
  validReviewerArgv,
  validWorkerArgv,
} from "./fakes.js";

const config: HarnessConfig = {
  repo: "owner/repo",
  localPath: "/repo",
  baseRef: "main",
  readyLabel: "ready-for-agent",
  claimLabel: "agent:claimed",
  worktreeRoot: "/worktrees",
  maxReviewRounds: 3,
  maxAnalystTurns: 3,
  workerArgv: validWorkerArgv,
  reviewerArgv: validReviewerArgv,
};

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

  await controller.tick();
  const freshAttemptId = store.state.activeJob?.activeAttempt?.id;
  assert.ok(freshAttemptId);
  assert.ok(freshAttemptId !== blockedAttemptId);
  for (let index = 0; index < 3; index += 1) await controller.tick();
  const recoveryPrompt = herdr.prompts.at(-1)?.text ?? "";
  assert.match(recoveryPrompt, /Keep the public interface unchanged/);
  assert.match(recoveryPrompt, new RegExp(freshAttemptId));
});

test("Reviewer infrastructure failure resumes with a fresh Reviewer on the same HEAD", async () => {
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
    unknowns: [],
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
  });

  for (let index = 0; index < 12; index += 1) await controller.tick();
  const failedReviewerId = store.state.activeJob?.activeAttempt?.id;
  herdr.settleWithoutResult = {
    agentStatus: "idle",
    diagnostic: "provider sessions are full",
  };
  await controller.tick();

  assert.equal(store.state.activeJob?.state, "blocked");
  assert.equal(store.state.activeJob?.incident?.class, "infrastructure_exhausted");
  assert.equal(store.state.activeJob?.incident?.lane, "reviewer");
  assert.deepEqual(store.state.activeJob?.incident?.allowedActions, ["retry_fresh_reviewer", "hold"]);
  assert.match(store.state.activeJob?.incident?.summary ?? "", /provider sessions are full/);

  await controller.tick();
  const blocked = store.state.activeJob!;
  assert.equal(blocked.analysis?.action, "retry_fresh_reviewer");
  await approveRecovery(
    store,
    {
      expectedRevision: blocked.revision,
      incidentId: blocked.incident!.id,
      analysisId: blocked.analysis!.id,
      actor: "human@example.test",
      reason: "Provider failure is isolated from the unchanged reviewed HEAD",
    },
    { clock, ids },
  );

  const approved = store.state.activeJob!;
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

  const recovery = await controller.tick();
  assert.match(recovery.message, /fresh Reviewer/);
  assert.equal(store.state.activeJob?.state, "reviewer_ready");
  assert.equal(store.state.activeJob?.headSha, "b".repeat(40));
  assert.equal(store.state.activeJob?.reviewRound, 0);
  assert.equal(herdr.closed.length, 2);

  for (let index = 0; index < 5; index += 1) await controller.tick();
  assert.equal(store.state.activeJob?.state, "publish_ready");
  assert.equal(herdr.prepared.filter((entry) => entry.lane === "worker").length, 1);
  assert.equal(herdr.prepared.filter((entry) => entry.lane === "reviewer").length, 2);
  assert.ok(herdr.prepared.at(-1)?.attemptId !== failedReviewerId);
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
  });

  for (let index = 0; index < 12; index += 1) await controller.tick();
  herdr.settleWithoutResult = { agentStatus: "idle", diagnostic: "provider sessions are full" };
  await controller.tick();
  await controller.tick();
  const held = store.state.activeJob!;
  const oldIncidentId = held.incident!.id;
  const oldAnalysisId = held.analysis!.id;
  const oldAttemptId = held.activeAttempt!.id;
  assert.equal(held.analysis?.action, "hold");

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
  });

  for (let index = 0; index < 7; index += 1) await controller.tick();
  herdr.settleWithoutResult = { agentStatus: "idle", diagnostic: "Worker provider overloaded" };
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
    /only an exact held Worker or Reviewer infrastructure incident/,
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
