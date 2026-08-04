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
    workerArgv: [],
    reviewerArgv: [],
};
test("actionable review findings create a fresh worker and a fresh reviewer", async () => {
    const store = new MemoryStore();
    const herdr = new FakeHerdr([
        { lane: "worker", status: "completed", headSha: "b".repeat(40) },
        {
            lane: "reviewer",
            status: "changes",
            reviewedHeadSha: "b".repeat(40),
            summary: "one correctness issue",
            findings: [{ severity: "major", summary: "handle empty input", evidence: "src/core.ts:12" }],
        },
        { lane: "worker", status: "completed", headSha: "c".repeat(40) },
        { lane: "reviewer", status: "pass", reviewedHeadSha: "c".repeat(40) },
    ]);
    const controller = new HarnessController({
        config,
        store,
        github: new FakeGitHub([issue({ number: 41, title: "Review loop" })]),
        git: new FakeGit(),
        herdr,
        analyst: new FakeAnalyst(),
        evidence: new FakeEvidence(),
        clock: new FakeClock(),
        ids: new SequenceIds(),
    });
    for (let index = 0; index < 23; index += 1)
        await controller.tick();
    assert.equal(store.state.activeJob?.state, "publish_ready");
    assert.equal(herdr.prepared.filter((entry) => entry.lane === "worker").length, 2);
    assert.equal(herdr.prepared.filter((entry) => entry.lane === "reviewer").length, 2);
    const workerPrompts = herdr.prompts.filter((prompt) => prompt.text.includes("Pi implementation worker"));
    assert.equal(workerPrompts.length, 2);
    assert.match(workerPrompts[1]?.text ?? "", /handle empty input/);
    assert.match(workerPrompts[1]?.text ?? "", /src\/core\.ts:12/);
});
//# sourceMappingURL=review-rework.test.js.map