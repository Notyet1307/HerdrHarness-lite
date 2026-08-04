import test from "node:test";
import assert from "node:assert/strict";
import { HarnessController } from "../src/controller.js";
import { FakeAnalyst, FakeClock, FakeEvidence, FakeGit, FakeGitHub, FakeHerdr, MemoryStore, SequenceIds, issue, substituteCodeReviewSkillPath, untrustedImplementSkillPath, validCodeReviewSkillPath, validImplementSkillPath, validReviewerArgv, validWorkerArgv, } from "./fakes.js";
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
test("config rejects non-string native Pi arguments", () => {
    for (const field of ["workerArgv", "reviewerArgv"]) {
        const invalidConfig = { ...config, [field]: [42] };
        assert.throws(() => new HarnessController({
            config: invalidConfig,
            store: new MemoryStore(),
            github: new FakeGitHub([]),
            git: new FakeGit(),
            herdr: new FakeHerdr([]),
            analyst: new FakeAnalyst(),
            evidence: new FakeEvidence(),
            clock: new FakeClock(),
            ids: new SequenceIds(),
        }), new RegExp(`${field} must be an array of strings`));
    }
});
test("config rejects incomplete Pi role contracts", () => {
    for (const invalidConfig of [
        { ...config, workerArgv: [] },
        { ...config, reviewerArgv: [] },
        { ...config, workerArgv: [...validWorkerArgv.slice(0, 2), ...validWorkerArgv.slice(4)] },
        { ...config, workerArgv: validWorkerArgv.map((value) => value === "high" ? "low" : value) },
        { ...config, reviewerArgv: [...validReviewerArgv, "--no-extensions"] },
        { ...config, reviewerArgv: [...validReviewerArgv, "--extension", "/tmp/override.js"] },
        { ...config, reviewerArgv: [...validReviewerArgv, "--continue"] },
        {
            ...config,
            reviewerArgv: validReviewerArgv.map((value) => value === validCodeReviewSkillPath ? "/tmp/code-review" : value),
        },
        { ...config, reviewerArgv: [...validReviewerArgv, "--skill", "/tmp/code-review"] },
        { ...config, reviewerArgv: [...validReviewerArgv, "--skill", substituteCodeReviewSkillPath] },
        {
            ...config,
            workerArgv: validWorkerArgv.map((value) => value === validImplementSkillPath ? untrustedImplementSkillPath : value),
        },
        {
            ...config,
            reviewerArgv: validReviewerArgv.map((value) => (value === "read,bash,grep,find,ls,subagent" ? `${value},write` : value)),
        },
    ]) {
        assert.throws(() => new HarnessController({
            config: invalidConfig,
            store: new MemoryStore(),
            github: new FakeGitHub([]),
            git: new FakeGit(),
            herdr: new FakeHerdr([]),
            analyst: new FakeAnalyst(),
            evidence: new FakeEvidence(),
            clock: new FakeClock(),
            ids: new SequenceIds(),
        }), /(?:workerArgv|reviewerArgv) must enforce the Pi role contract/);
    }
});
test("blocked Reviewer cannot bypass worktree verification", async () => {
    const store = new MemoryStore();
    const git = new FakeGit();
    git.reviewerFailure = "reviewer left an untracked product file";
    const controller = new HarnessController({
        config,
        store,
        github: new FakeGitHub([issue({ number: 22, title: "Verify blocked review" })]),
        git,
        herdr: new FakeHerdr([
            { lane: "worker", status: "completed", headSha: "b".repeat(40) },
            { lane: "reviewer", status: "blocked", summary: "review evidence unavailable" },
        ]),
        analyst: new FakeAnalyst(),
        evidence: new FakeEvidence(),
        clock: new FakeClock(),
        ids: new SequenceIds(),
    });
    for (let index = 0; index < 13; index += 1)
        await controller.tick();
    assert.equal(store.state.activeJob?.incident?.class, "integrity_violation");
    assert.match(store.state.activeJob?.incident?.summary ?? "", /untracked product file/);
});
test("happy path claims, starts Analyst, runs fresh Pi worker/reviewer, publishes, and archives", async () => {
    const store = new MemoryStore();
    const github = new FakeGitHub([issue({ number: 21, title: "Implement feature" })]);
    const herdr = new FakeHerdr([
        { lane: "worker", status: "completed", headSha: "b".repeat(40) },
        { lane: "reviewer", status: "pass" },
    ]);
    const analyst = new FakeAnalyst();
    const controller = new HarnessController({
        config,
        store,
        github,
        git: new FakeGit(),
        herdr,
        analyst,
        evidence: new FakeEvidence(),
        clock: new FakeClock(),
        ids: new SequenceIds(),
    });
    const actions = [];
    for (let index = 0; index < 14; index += 1)
        actions.push((await controller.tick()).action);
    github.mergeStatus = "open";
    actions.push((await controller.tick()).action);
    github.mergeStatus = "merged";
    actions.push((await controller.tick()).action);
    actions.push((await controller.tick()).action);
    assert.deepEqual(actions, [
        "selected",
        "claimed",
        "worktree_created",
        "attempt_prepared",
        "attempt_pane_ready",
        "attempt_agent_ready",
        "attempt_dispatched",
        "attempt_completed",
        "attempt_prepared",
        "attempt_pane_ready",
        "attempt_agent_ready",
        "attempt_dispatched",
        "attempt_completed",
        "published",
        "waiting_for_merge",
        "merged",
        "archived",
    ]);
    assert.equal(github.claims.length, 1);
    assert.equal(github.claims[0]?.issue, 21);
    assert.equal(analyst.starts.length, 1);
    assert.deepEqual(analyst.closes, [{
            jobId: "job-001",
            sessionId: "analyst-job-001",
            taskDigest: analyst.starts[0].taskDigest,
        }]);
    assert.equal(herdr.prepared.length, 2);
    assert.equal(herdr.prepared[0]?.lane, "worker");
    assert.equal(herdr.prepared[1]?.lane, "reviewer");
    assert.ok(herdr.prepared[0]?.attemptId !== herdr.prepared[1]?.attemptId);
    assert.deepEqual(herdr.prompts.map((prompt) => prompt.skill), ["implement", "code-review"]);
    assert.deepEqual(herdr.closed, [
        herdr.prepared[0].handle.agentName,
        herdr.prepared[1].handle.agentName,
    ]);
    assert.equal(github.published[0]?.headSha, "b".repeat(40));
    assert.equal(store.state.activeJob, null);
    assert.equal(store.state.terminalJobs[0]?.state, "done");
});
test("an ambiguous prompt failure never replays the same dispatch", async () => {
    const store = new MemoryStore();
    const herdr = new FakeHerdr([
        { lane: "worker", status: "completed", headSha: "b".repeat(40) },
    ]);
    herdr.promptFailureAfterDispatch = new Error("connection closed after submission");
    const controller = new HarnessController({
        config,
        store,
        github: new FakeGitHub([issue({ number: 22, title: "At-most-once dispatch" })]),
        git: new FakeGit(),
        herdr,
        analyst: new FakeAnalyst(),
        evidence: new FakeEvidence(),
        clock: new FakeClock(),
        ids: new SequenceIds(),
    });
    for (let index = 0; index < 4; index += 1)
        await controller.tick();
    const paneReady = await controller.tick();
    assert.equal(paneReady.action, "attempt_pane_ready");
    assert.equal(store.state.activeJob?.activeAttempt?.phase, "pane_ready");
    assert.equal(herdr.started.length, 0);
    await controller.tick();
    assert.equal(store.state.activeJob?.activeAttempt?.phase, "agent_ready");
    assert.equal(herdr.started.length, 1);
    const ambiguous = await controller.tick();
    assert.equal(ambiguous.action, "attempt_dispatched");
    assert.equal(ambiguous.ok, false);
    assert.equal(store.state.activeJob?.activeAttempt?.phase, "running");
    assert.equal(herdr.prompts.length, 1);
    await controller.tick();
    assert.equal(herdr.prompts.length, 1);
    assert.equal(store.state.activeJob?.state, "reviewer_ready");
});
test("a durable valid result completes even when the closed agent is no longer known", async () => {
    const store = new MemoryStore();
    const herdr = new FakeHerdr([
        { lane: "worker", status: "completed", headSha: "b".repeat(40), agentStatus: "unknown" },
    ]);
    const controller = new HarnessController({
        config,
        store,
        github: new FakeGitHub([issue({ number: 23, title: "Recover closed pane" })]),
        git: new FakeGit(),
        herdr,
        analyst: new FakeAnalyst(),
        evidence: new FakeEvidence(),
        clock: new FakeClock(),
        ids: new SequenceIds(),
    });
    for (let index = 0; index < 8; index += 1)
        await controller.tick();
    assert.equal(store.state.activeJob?.state, "reviewer_ready");
    assert.equal(herdr.closed.length, 1);
});
test("a terminal job is retained when its exact Analyst session cannot be closed", async () => {
    const store = new MemoryStore();
    const github = new FakeGitHub([issue({ number: 24, title: "Retain cleanup failure" })]);
    const analyst = new FakeAnalyst();
    analyst.closeFailure = new Error("session delete failed");
    const controller = new HarnessController({
        config,
        store,
        github,
        git: new FakeGit(),
        herdr: new FakeHerdr([
            { lane: "worker", status: "completed", headSha: "b".repeat(40) },
            { lane: "reviewer", status: "pass" },
        ]),
        analyst,
        evidence: new FakeEvidence(),
        clock: new FakeClock(),
        ids: new SequenceIds(),
    });
    for (let index = 0; index < 14; index += 1)
        await controller.tick();
    github.mergeStatus = "merged";
    await controller.tick();
    const retained = await controller.tick();
    assert.equal(retained.action, "archived");
    assert.equal(retained.ok, false);
    assert.match(retained.message, /session delete failed/);
    assert.equal(store.state.activeJob?.state, "done");
    assert.equal(store.state.terminalJobs.length, 0);
});
//# sourceMappingURL=controller-happy.test.js.map