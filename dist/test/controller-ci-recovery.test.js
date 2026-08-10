import test from "node:test";
import assert from "node:assert/strict";
import { HarnessController } from "../src/controller.js";
import { approveRecovery, reassessIncident } from "../src/recovery.js";
import { FakeAnalyst, FakeClock, FakeEvidence, FakeGit, FakeGitHub, FakeHerdr, FakeRuntimePreflight, MemoryStore, SequenceIds, issue, validReviewerArgv, validWorkerArgv, } from "./fakes.js";
const oldHead = "b".repeat(40);
const newHead = "c".repeat(40);
const newestHead = "d".repeat(40);
const failedCheck = {
    name: "test-backend",
    state: "FAILURE",
    bucket: "fail",
    workflow: "Backend",
    link: "https://github.com/owner/repo/actions/runs/123/job/456",
    completedAt: "2026-08-06T00:00:00Z",
    diagnostic: "assertion failed",
};
const passedCheck = {
    ...failedCheck,
    state: "SUCCESS",
    bucket: "pass",
    diagnostic: null,
};
const failedCoverageCheck = {
    name: "coverage",
    state: "FAILURE",
    bucket: "fail",
    workflow: "Backend",
    link: "https://github.com/owner/repo/actions/runs/124/job/457",
    completedAt: "2026-08-06T00:01:00Z",
    diagnostic: "total coverage is below fail-under=90",
};
const config = {
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
test("failed required CI permits two exact human-approved Worker cycles before exhaustion", async () => {
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
        { lane: "worker", status: "completed", headSha: newestHead },
        { lane: "reviewer", status: "pass", reviewedHeadSha: newestHead },
    ]);
    const analyst = new FakeAnalyst([
        {
            kind: "advice",
            action: "hold",
            summary: "The captured CI diagnostic ends before the failing assertion",
            resolutionBrief: "",
            evidenceRefs: ["ci-checks"],
            unknowns: ["actual failure cause"],
        },
        {
            kind: "advice",
            action: "retry_fresh_worker",
            summary: "The required backend check found a bounded implementation defect",
            resolutionBrief: "Fix the backend assertion from required CI, commit, and rerun focused validation.",
            evidenceRefs: ["task", "ci-checks"],
            unknowns: [],
        },
        {
            kind: "advice",
            action: "hold",
            summary: "The old runtime exhausted CI recovery after one cycle",
            resolutionBrief: "",
            evidenceRefs: ["ci-checks"],
            unknowns: ["whether the newly approved second cycle is available"],
        },
        {
            kind: "advice",
            action: "retry_fresh_worker",
            summary: "The second CI defect is bounded to the exact reviewed head",
            resolutionBrief: "Propagate the remaining CI credentials and repair container-owned cleanup.",
            evidenceRefs: ["task", "ci-checks"],
            unknowns: [],
        },
        {
            kind: "advice",
            action: "hold",
            summary: "Both approved CI rework cycles are exhausted",
            resolutionBrief: "",
            evidenceRefs: ["ci-checks"],
            unknowns: ["maintainer follow-up"],
        },
    ]);
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
    const held = store.state.activeJob;
    assert.equal(held.analysis?.action, "hold");
    await reassessIncident(store, {
        expectedRevision: held.revision,
        incidentId: held.incident.id,
        analysisId: held.analysis.id,
        actor: "human@example.test",
        reason: "The complete failed log shows the Playwright login used credentials that differ from the backend.",
    }, { clock, ids });
    assert.equal(store.state.activeJob?.incident?.class, "ci_failure");
    assert.equal(store.state.activeJob?.analysis, null);
    assert.equal((await controller.tick()).action, "analysis_recorded");
    const blocked = store.state.activeJob;
    assert.equal(blocked.analysis?.action, "retry_fresh_worker");
    await approveRecovery(store, {
        expectedRevision: blocked.revision,
        incidentId: blocked.incident.id,
        analysisId: blocked.analysis.id,
        actor: "human@example.test",
        reason: "CI evidence is bounded to the reviewed PR head",
    }, { clock, ids });
    assert.equal((await controller.tick()).action, "recovery_applied");
    assert.equal(store.state.activeJob?.ciReworkCount, 1);
    const firstHandoff = store.state.activeJob?.pendingHandoff;
    assert.equal(firstHandoff?.kind, "ci_rework");
    assert.equal(firstHandoff?.target.expectedRemoteHeadSha, oldHead);
    assert.deepEqual(firstHandoff?.evidenceRefs, [
        "task",
        "ci-checks",
        failedCheck.link,
    ]);
    assert.match(firstHandoff?.obligations.map((entry) => entry.summary).join("\n") ?? "", /assertion failed/);
    assert.equal((await controller.tick()).action, "attempt_prepared");
    assert.deepEqual(store.state.activeJob?.activeAttempt?.contextEnvelope?.handoff?.value, firstHandoff);
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
    assert.equal(store.state.activeJob?.incident?.class, "ci_failure");
    assert.equal(store.state.activeJob?.ciReworkCount, 1);
    // Simulate a V1 ledger blocked by the old one-cycle runtime before deployment.
    store.state.activeJob.incident.class = "ci_rework_exhausted";
    store.state.activeJob.incident.allowedActions = ["hold"];
    assert.equal((await controller.tick()).action, "analysis_recorded");
    const legacyExhausted = store.state.activeJob;
    assert.equal(legacyExhausted.analysis?.action, "hold");
    await reassessIncident(store, {
        expectedRevision: legacyExhausted.revision,
        incidentId: legacyExhausted.incident.id,
        analysisId: legacyExhausted.analysis.id,
        actor: "human@example.test",
        reason: "A second human-approved CI cycle is now bounded and the exact failure has been diagnosed.",
    }, { clock, ids });
    assert.equal(store.state.activeJob?.incident?.class, "ci_failure");
    assert.deepEqual(store.state.activeJob?.incident?.allowedActions, ["retry_fresh_worker", "hold"]);
    assert.equal(store.state.activeJob?.analysis, null);
    assert.equal((await controller.tick()).action, "analysis_recorded");
    const secondBlocked = store.state.activeJob;
    assert.equal(secondBlocked.analysis?.action, "retry_fresh_worker");
    await approveRecovery(store, {
        expectedRevision: secondBlocked.revision,
        incidentId: secondBlocked.incident.id,
        analysisId: secondBlocked.analysis.id,
        actor: "human@example.test",
        reason: "The exact PR head has one final bounded CI rework available",
    }, { clock, ids });
    assert.equal((await controller.tick()).action, "recovery_applied");
    assert.equal(store.state.activeJob?.ciReworkCount, 2);
    assert.equal((await controller.tick()).action, "attempt_prepared");
    assert.equal(store.state.activeJob?.activeAttempt?.expectedRemoteHeadSha, newHead);
    await driveUntil(controller, store, "awaiting_merge");
    assert.equal(store.state.activeJob?.pullRequest?.headSha, newestHead);
    assert.equal(git.workerVerifications.at(-1)?.expectedRemoteHeadSha, newHead);
    github.autoMergeEnabled = true;
    github.requiredChecks = [failedCheck];
    assert.equal((await controller.tick()).action, "blocked");
    assert.equal(store.state.activeJob?.incident?.class, "ci_rework_exhausted");
    assert.deepEqual(store.state.activeJob?.incident?.allowedActions, ["hold"]);
    assert.equal(store.state.activeJob?.ciReworkCount, 2);
    assert.equal((await controller.tick()).action, "analysis_recorded");
    const exhausted = store.state.activeJob;
    await assert.rejects(() => reassessIncident(store, {
        expectedRevision: exhausted.revision,
        incidentId: exhausted.incident.id,
        analysisId: exhausted.analysis.id,
        actor: "human@example.test",
        reason: "A third cycle must remain forbidden.",
    }, { clock, ids }), /within the rework limit/);
    github.requiredChecks = [passedCheck];
    const recovered = await controller.tick();
    assert.equal(recovered.action, "ci_recovered");
    assert.equal(store.state.activeJob?.state, "publish_ready");
    assert.equal(store.state.activeJob?.incident, null);
    assert.equal(store.state.activeJob?.analysis, null);
    assert.equal(store.state.activeJob?.ciFailure, null);
    assert.equal(store.state.activeJob?.ciReworkCount, 2);
    assert.equal((await controller.tick()).action, "published");
    assert.equal(store.state.activeJob?.pullRequest?.headSha, newestHead);
});
test("blocked CI refreshes its incident when another required check fails on the same HEAD", async () => {
    const store = new MemoryStore();
    const github = new FakeGitHub([issue({ number: 40, title: "Late CI failure" })]);
    const controller = new HarnessController({
        config,
        store,
        github,
        git: new FakeGit(),
        herdr: new FakeHerdr([
            { lane: "worker", status: "completed", headSha: oldHead },
            { lane: "reviewer", status: "pass", reviewedHeadSha: oldHead },
        ]),
        analyst: new FakeAnalyst(),
        evidence: new FakeEvidence(),
        clock: new FakeClock(),
        ids: new SequenceIds(),
        preflight: new FakeRuntimePreflight(),
    });
    await driveUntil(controller, store, "awaiting_merge");
    github.requiredChecks = [failedCheck];
    assert.equal((await controller.tick()).action, "blocked");
    const firstIncidentId = store.state.activeJob?.incident?.id;
    github.requiredChecks = [failedCoverageCheck, failedCheck];
    const refreshed = await controller.tick();
    assert.equal(refreshed.action, "blocked");
    assert.ok(store.state.activeJob?.incident?.id !== firstIncidentId);
    assert.equal(store.state.activeJob?.analysis, null);
    assert.deepEqual(store.state.activeJob?.ciFailure?.checks, [failedCoverageCheck, failedCheck]);
    assert.match(store.state.activeJob?.incident?.summary ?? "", /coverage: FAILURE/);
    assert.equal(store.state.activeJob?.ciReworkCount, 0);
    assert.equal(store.state.activeJob?.headSha, oldHead);
});
test("CI evidence-turn exhaustion records an actionable Simplified-Chinese hold", async () => {
    const store = new MemoryStore();
    const github = new FakeGitHub([issue({ number: 77, title: "Stage 4 results" })]);
    const analyst = new FakeAnalyst(Array.from({ length: config.maxAnalystTurns }, () => ({
        kind: "need_evidence",
        requests: [{ kind: "test_output", path: null, reason: "the failing assertion is still missing" }],
    })));
    const controller = new HarnessController({
        config,
        store,
        github,
        git: new FakeGit(),
        herdr: new FakeHerdr([
            { lane: "worker", status: "completed", headSha: oldHead },
            { lane: "reviewer", status: "pass", reviewedHeadSha: oldHead },
        ]),
        analyst,
        evidence: new FakeEvidence(),
        clock: new FakeClock(),
        ids: new SequenceIds(),
        preflight: new FakeRuntimePreflight(),
    });
    await driveUntil(controller, store, "awaiting_merge");
    github.requiredChecks = [failedCheck];
    assert.equal((await controller.tick()).action, "blocked");
    assert.equal((await controller.tick()).action, "analysis_recorded");
    const analysis = store.state.activeJob?.analysis;
    assert.equal(analysis?.action, "hold");
    assert.equal(analysis?.summary, "自动诊断未完成：在允许的证据轮数内仍缺少关键证据。");
    assert.deepEqual(analysis?.unknowns, ["所需证据超出 Harness 本轮允许的收集范围"]);
});
test("a newer base suspends auto-merge and requires a fresh review of the merged HEAD", async () => {
    const store = new MemoryStore();
    const github = new FakeGitHub([issue({ number: 40, title: "Refresh base" })]);
    const git = new FakeGit();
    const refreshedBase = "e".repeat(40);
    const refreshedHead = "f".repeat(40);
    const controller = new HarnessController({
        config,
        store,
        github,
        git,
        herdr: new FakeHerdr([
            { lane: "worker", status: "completed", headSha: oldHead },
            { lane: "reviewer", status: "pass", reviewedHeadSha: oldHead },
            { lane: "reviewer", status: "pass", reviewedHeadSha: refreshedHead },
        ]),
        analyst: new FakeAnalyst(),
        evidence: new FakeEvidence(),
        clock: new FakeClock(),
        ids: new SequenceIds(),
        preflight: new FakeRuntimePreflight(),
    });
    await driveUntil(controller, store, "awaiting_merge");
    github.autoMergeEnabled = true;
    github.requiredChecks = [passedCheck];
    git.baseSha = refreshedBase;
    git.baseSyncHeadSha = refreshedHead;
    const refreshed = await controller.tick();
    assert.equal(refreshed.action, "base_refreshed");
    assert.equal(store.state.activeJob?.state, "reviewer_ready");
    assert.equal(store.state.activeJob?.baseSha, refreshedBase);
    assert.equal(store.state.activeJob?.headSha, refreshedHead);
    assert.deepEqual(github.suspended, [42]);
    assert.deepEqual(git.baseSyncs, [{
            expectedHeadSha: oldHead,
            expectedRemoteHeadSha: oldHead,
            latestBaseSha: refreshedBase,
        }]);
    await driveUntil(controller, store, "awaiting_merge");
    assert.equal(store.state.activeJob?.pullRequest?.headSha, refreshedHead);
    assert.equal(github.published.at(-1)?.headSha, refreshedHead);
    assert.equal(store.state.activeJob?.ciReworkCount, 0);
});
test("a conflicting base refresh fails closed after suspending auto-merge", async () => {
    const store = new MemoryStore();
    const github = new FakeGitHub([issue({ number: 41, title: "Conflict base" })]);
    const git = new FakeGit();
    const controller = new HarnessController({
        config,
        store,
        github,
        git,
        herdr: new FakeHerdr([
            { lane: "worker", status: "completed", headSha: oldHead },
            { lane: "reviewer", status: "pass", reviewedHeadSha: oldHead },
        ]),
        analyst: new FakeAnalyst(),
        evidence: new FakeEvidence(),
        clock: new FakeClock(),
        ids: new SequenceIds(),
        preflight: new FakeRuntimePreflight(),
    });
    await driveUntil(controller, store, "awaiting_merge");
    github.autoMergeEnabled = true;
    github.requiredChecks = [passedCheck];
    git.baseSha = "e".repeat(40);
    git.baseSyncFailure = { class: "agent_decision", reason: "main conflicts with the reviewed HEAD" };
    const blocked = await controller.tick();
    assert.equal(blocked.action, "blocked");
    assert.equal(store.state.activeJob?.state, "blocked");
    assert.equal(store.state.activeJob?.incident?.class, "agent_decision");
    assert.equal(store.state.activeJob?.headSha, oldHead);
    assert.deepEqual(github.suspended, [42]);
});
async function driveUntil(controller, store, state) {
    for (let tick = 0; tick < 40; tick += 1) {
        if (store.state.activeJob?.state === state)
            return;
        await controller.tick();
    }
    throw new Error(`controller did not reach ${state}`);
}
//# sourceMappingURL=controller-ci-recovery.test.js.map