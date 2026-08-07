import test from "node:test";
import assert from "node:assert/strict";
import { HarnessController } from "../src/controller.js";
import { approveRecovery } from "../src/recovery.js";
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

const oldHead = "b".repeat(40);
const newHead = "c".repeat(40);
const failedCheck = {
  name: "test-backend",
  state: "FAILURE",
  bucket: "fail" as const,
  workflow: "Backend",
  link: "https://github.com/owner/repo/actions/runs/123/job/456",
  completedAt: "2026-08-06T00:00:00Z",
  diagnostic: "assertion failed",
};

const config: HarnessConfig = {
  repo: "owner/repo",
  localPath: "/repo",
  stateDir: "/state",
  baseRef: "main",
  autoMerge: true,
  readyLabel: "ready-for-agent",
  claimLabel: "agent:claimed",
  worktreeRoot: "/worktrees",
  maxReviewRounds: 3,
  maxAnalystTurns: 3,
  reviewerValidationArgv: ["npm", "run", "verify"],
  workerArgv: validWorkerArgv,
  reviewerArgv: validReviewerArgv,
};

test("failed required CI blocks, then permits one human-approved fresh Worker cycle on the same PR", async () => {
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new SequenceIds();
  const github = new FakeGitHub([issue({ number: 39, title: "CI feedback" })]);
  const git = new FakeGit();
  const herdr = new FakeHerdr([
    { lane: "worker", status: "completed", headSha: oldHead },
    { lane: "reviewer", status: "pass", reviewedHeadSha: oldHead },
    { lane: "worker", status: "completed", headSha: newHead },
    { lane: "reviewer", status: "pass", reviewedHeadSha: newHead },
  ]);
  const analyst = new FakeAnalyst([{
    kind: "advice",
    action: "retry_fresh_worker",
    summary: "The required backend check found a bounded implementation defect",
    resolutionBrief: "Fix the backend assertion from required CI, commit, and rerun focused validation.",
    evidenceRefs: ["task", "ci-checks"],
    unknowns: [],
  }]);
  const controller = new HarnessController({
    config,
    store,
    github,
    git,
    herdr,
    analyst,
    evidence: new FakeEvidence(),
    clock,
    ids,
    preflight: new FakeRuntimePreflight(),
  });

  await driveUntil(controller, store, "awaiting_merge");
  github.autoMergeEnabled = true;
  github.requiredChecks = [failedCheck];
  github.suspendFailure = new Error("GitHub mutation unavailable");

  const unsafe = await controller.tick();
  assert.equal(unsafe.action, "waiting_for_merge");
  assert.equal(unsafe.ok, false);
  assert.equal(store.state.activeJob?.state, "awaiting_merge");
  assert.equal(store.state.activeJob?.ciFailure, null);
  github.suspendFailure = null;

  const failed = await controller.tick();
  assert.equal(failed.action, "blocked");
  assert.equal(store.state.activeJob?.incident?.class, "ci_failure");
  assert.deepEqual(store.state.activeJob?.incident?.allowedActions, ["retry_fresh_worker", "hold"]);
  assert.equal(store.state.activeJob?.pullRequest?.headSha, oldHead);
  assert.deepEqual(store.state.activeJob?.ciFailure?.checks, [failedCheck]);
  assert.deepEqual(github.suspended, [42]);

  assert.equal((await controller.tick()).action, "analysis_recorded");
  const blocked = store.state.activeJob!;
  assert.equal(blocked.analysis?.action, "retry_fresh_worker");
  await approveRecovery(store, {
    expectedRevision: blocked.revision,
    incidentId: blocked.incident!.id,
    analysisId: blocked.analysis!.id,
    actor: "human@example.test",
    reason: "CI evidence is bounded to the reviewed PR head",
  }, { clock, ids });

  assert.equal((await controller.tick()).action, "recovery_applied");
  assert.equal(store.state.activeJob?.ciReworkCount, 1);
  assert.equal((await controller.tick()).action, "attempt_prepared");
  assert.equal(store.state.activeJob?.activeAttempt?.expectedRemoteHeadSha, oldHead);

  await driveUntil(controller, store, "awaiting_merge");
  assert.equal(store.state.activeJob?.pullRequest?.number, 42);
  assert.equal(store.state.activeJob?.pullRequest?.headSha, newHead);
  assert.equal(store.state.activeJob?.ciFailure, null);
  assert.equal(github.published.length, 2);
  assert.equal(git.workerVerifications.at(-1)?.expectedRemoteHeadSha, oldHead);

  github.autoMergeEnabled = true;
  github.requiredChecks = [failedCheck];
  assert.equal((await controller.tick()).action, "blocked");
  assert.equal(store.state.activeJob?.incident?.class, "ci_rework_exhausted");
  assert.deepEqual(store.state.activeJob?.incident?.allowedActions, ["hold"]);
  assert.equal(store.state.activeJob?.ciReworkCount, 1);
});

async function driveUntil(
  controller: HarnessController,
  store: MemoryStore,
  state: "awaiting_merge",
): Promise<void> {
  for (let tick = 0; tick < 40; tick += 1) {
    if (store.state.activeJob?.state === state) return;
    await controller.tick();
  }
  throw new Error(`controller did not reach ${state}`);
}
