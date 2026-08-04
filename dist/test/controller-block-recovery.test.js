import test from "node:test";
import assert from "node:assert/strict";
import { HarnessController } from "../src/controller.js";
import { approveRecovery } from "../src/recovery.js";
import { FakeAnalyst, FakeClock, FakeEvidence, FakeGit, FakeGitHub, FakeHerdr, MemoryStore, SequenceIds, issue, validReviewerArgv, validWorkerArgv, } from "./fakes.js";
const config = {
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
    for (let index = 0; index < 8; index += 1)
        await controller.tick();
    assert.equal(store.state.activeJob?.state, "blocked");
    const blockedAttemptId = store.state.activeJob?.activeAttempt?.id;
    assert.ok(blockedAttemptId);
    assert.equal(store.state.activeJob?.analysis, null);
    const diagnosis = await controller.tick();
    assert.equal(diagnosis.action, "analysis_recorded");
    const blocked = store.state.activeJob;
    assert.equal(blocked.analysis?.action, "retry_fresh_worker");
    await assert.rejects(() => approveRecovery(store, {
        expectedRevision: blocked.revision - 1,
        incidentId: blocked.incident.id,
        analysisId: blocked.analysis.id,
        actor: "human@example.test",
        reason: "reviewed",
    }, { clock, ids }), /stale job revision/);
    assert.equal(store.state.activeJob?.state, "blocked");
    await approveRecovery(store, {
        expectedRevision: blocked.revision,
        incidentId: blocked.incident.id,
        analysisId: blocked.analysis.id,
        actor: "human@example.test",
        reason: "Evidence supports the bounded retry",
    }, { clock, ids });
    assert.equal(store.state.activeJob?.state, "recovery_approved");
    const applied = await controller.tick();
    assert.equal(applied.action, "recovery_applied");
    assert.equal(store.state.activeJob?.state, "worker_ready");
    assert.equal(herdr.closed.length, 1);
    await controller.tick();
    const freshAttemptId = store.state.activeJob?.activeAttempt?.id;
    assert.ok(freshAttemptId);
    assert.ok(freshAttemptId !== blockedAttemptId);
    for (let index = 0; index < 3; index += 1)
        await controller.tick();
    const recoveryPrompt = herdr.prompts.at(-1)?.text ?? "";
    assert.match(recoveryPrompt, /Keep the public interface unchanged/);
    assert.match(recoveryPrompt, new RegExp(freshAttemptId));
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
    for (let index = 0; index < 8; index += 1)
        await controller.tick();
    assert.equal(store.state.activeJob?.incident?.class, "integrity_violation");
    await controller.tick();
    const job = store.state.activeJob;
    assert.equal(job.analysis?.action, "hold");
    await assert.rejects(() => approveRecovery(store, {
        expectedRevision: job.revision,
        incidentId: job.incident.id,
        analysisId: job.analysis.id,
        actor: "human@example.test",
        reason: "attempted override",
    }, { clock, ids }), /did not recommend retry/);
});
//# sourceMappingURL=controller-block-recovery.test.js.map