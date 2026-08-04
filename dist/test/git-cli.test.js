import test from "node:test";
import assert from "node:assert/strict";
import { GitCli } from "../src/adapters/git-cli.js";
const head = "b".repeat(40);
const worktree = { path: "/repo", branch: "agent/issue-1", workspaceId: "w1" };
const allowedResultPaths = [
    "/repo/.harness/attempt-worker.json",
    "/repo/.harness/attempt-reviewer.json",
];
test("Reviewer Git verification rejects untracked files outside Harness results", async () => {
    const allowed = await new GitCli(new ReviewRunner("?? .harness/attempt-worker.json\n?? .harness/attempt-reviewer.json\n")).verifyReviewer({ worktree, expectedHeadSha: head, reportedHeadSha: head, allowedResultPaths });
    assert.deepEqual(allowed, { ok: true });
    const rejected = await new GitCli(new ReviewRunner("?? .harness/attempt-reviewer.json\n?? notes.txt\n")).verifyReviewer({ worktree, expectedHeadSha: head, reportedHeadSha: head, allowedResultPaths });
    assert.equal(rejected.ok, false);
    if (!rejected.ok)
        assert.match(rejected.reason, /notes\.txt/);
});
class ReviewRunner {
    status;
    constructor(status) {
        this.status = status;
    }
    run(_command, args) {
        const operation = args[2];
        if (operation === "rev-parse")
            return ok(`${head}\n`);
        if (operation === "status")
            return ok(args.includes("--untracked-files=no") ? "" : this.status);
        throw new Error(`unexpected git command: ${args.join(" ")}`);
    }
}
function ok(stdout) {
    return { ok: true, code: 0, stdout, stderr: "", error: null };
}
//# sourceMappingURL=git-cli.test.js.map