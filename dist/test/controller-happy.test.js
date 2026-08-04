import test from "node:test";
import assert from "node:assert/strict";
import { HarnessController } from "../src/controller.js";
import { FakeAnalyst, FakeClock, FakeEvidence, FakeGit, FakeGitHub, FakeHerdr, MemoryStore, SequenceIds, issue, } from "./fakes.js";
const config = {
    repo: "owner/repo",
    localPath: "/repo",
    baseRef: "main",
    readyLabel: "ready-for-agent",
    claimLabel: "agent:claimed",
    worktreeRoot: "/worktrees",
    maxReviewRounds: 3,
    maxAnalystTurns: 3,
    workerArgv: ["pi", "--profile", "worker"],
    reviewerArgv: ["pi", "--profile", "reviewer"],
};
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
    for (let index = 0; index < 10; index += 1)
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
        "attempt_dispatched",
        "attempt_completed",
        "attempt_prepared",
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
    assert.equal(herdr.prepared.length, 2);
    assert.equal(herdr.prepared[0]?.lane, "worker");
    assert.equal(herdr.prepared[1]?.lane, "reviewer");
    assert.ok(herdr.prepared[0]?.attemptId !== herdr.prepared[1]?.attemptId);
    assert.equal(github.published[0]?.headSha, "b".repeat(40));
    assert.equal(store.state.activeJob, null);
    assert.equal(store.state.terminalJobs[0]?.state, "done");
});
//# sourceMappingURL=controller-happy.test.js.map