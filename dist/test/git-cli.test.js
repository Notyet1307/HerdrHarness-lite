import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCli } from "../src/adapters/git-cli.js";
import { requireSuccess, SyncCommandRunner } from "../src/adapters/command.js";
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
test("Reviewer preparation exports a read-only exact-HEAD snapshot and writable validation copy", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-review-workspace-"));
    const repo = join(root, "repo");
    const attemptRoot = join(root, "state", "attempt-1");
    const runner = new SyncCommandRunner();
    const git = (...args) => requireSuccess(runner.run("git", ["-C", repo, ...args]), `git ${args[0]}`);
    try {
        mkdirSync(repo, { recursive: true });
        git("init", "--quiet");
        git("config", "user.email", "reviewer@example.test");
        git("config", "user.name", "Reviewer Test");
        writeFileSync(join(repo, "product.txt"), "base\n");
        git("add", "product.txt");
        git("commit", "--quiet", "-m", "base");
        const baseSha = git("rev-parse", "HEAD").trim();
        writeFileSync(join(repo, "product.txt"), "head\n");
        git("add", "product.txt");
        git("commit", "--quiet", "-m", "head");
        const expectedHeadSha = git("rev-parse", "HEAD").trim();
        const input = {
            worktree: { path: repo, branch: "agent/issue-1", workspaceId: "w1" },
            rootPath: attemptRoot,
            resultPath: join(attemptRoot, "result.json"),
            jobId: "job-1",
            attemptId: "reviewer-1",
            baseSha,
            expectedHeadSha,
            validationArgv: ["npm", "run", "verify"],
        };
        const workspace = await new GitCli(runner).prepareReviewer(input);
        assert.equal(readFileSync(join(workspace.reviewPath, "product.txt"), "utf8"), "head\n");
        assert.equal(lstatSync(join(workspace.reviewPath, "product.txt")).mode & 0o222, 0);
        writeFileSync(join(attemptRoot, "validation", "product.txt"), "validation mutation\n");
        assert.match(readFileSync(workspace.evidencePath, "utf8"), new RegExp(`Head SHA: ${expectedHeadSha}`));
        assert.deepEqual(await new GitCli(runner).prepareReviewer(input), workspace);
        await assert.rejects(() => new GitCli(runner).prepareReviewer({
            ...input,
            rootPath: join(repo, "review-state"),
            resultPath: join(repo, "review-state", "result.json"),
        }), /outside the product worktree/);
        await assert.rejects(() => new GitCli(runner).prepareReviewer({
            ...input,
            rootPath: root,
            resultPath: join(root, "result.json"),
        }), /outside the product worktree/);
        const linkedState = join(repo, "linked-review-state");
        mkdirSync(linkedState);
        const stateLink = join(root, "state-link");
        symlinkSync(linkedState, stateLink, "dir");
        await assert.rejects(() => new GitCli(runner).prepareReviewer({
            ...input,
            rootPath: stateLink,
            resultPath: join(stateLink, "result.json"),
        }), /outside the product worktree/);
    }
    finally {
        const sourcePath = join(attemptRoot, "source");
        const productPath = join(sourcePath, "product.txt");
        if (existsSync(sourcePath))
            chmodSync(sourcePath, 0o700);
        if (existsSync(productPath))
            chmodSync(productPath, 0o600);
        rmSync(root, { recursive: true, force: true });
    }
});
test("Worker Git verification rejects untracked files outside Harness results", async () => {
    const input = {
        worktree,
        branch: worktree.branch,
        baseSha: "a".repeat(40),
        reportedHeadSha: head,
        expectedRemoteHeadSha: null,
        allowedResultPaths: ["/repo/.harness/attempt-worker.json"],
    };
    const allowed = await new GitCli(new WorkerRunner(head, null, "?? .harness/attempt-worker.json\n")).verifyWorker(input);
    assert.deepEqual(allowed, { ok: true, headSha: head });
    const rejected = await new GitCli(new WorkerRunner(head, null, "?? .harness/attempt-worker.json\n?? investigations/issue_33/__pycache__/probe.pyc\n")).verifyWorker(input);
    assert.equal(rejected.ok, false);
    if (!rejected.ok)
        assert.match(rejected.reason, /probe\.pyc/);
});
test("post-PR Worker verification requires the remote branch to remain on the reviewed anchor", async () => {
    const publishedHead = "b".repeat(40);
    const reworkedHead = "c".repeat(40);
    const input = {
        worktree,
        branch: worktree.branch,
        baseSha: publishedHead,
        reportedHeadSha: reworkedHead,
        expectedRemoteHeadSha: publishedHead,
        allowedResultPaths: [],
    };
    const accepted = await new GitCli(new WorkerRunner(reworkedHead, publishedHead)).verifyWorker(input);
    assert.deepEqual(accepted, { ok: true, headSha: reworkedHead });
    const drifted = await new GitCli(new WorkerRunner(reworkedHead, "d".repeat(40))).verifyWorker(input);
    assert.equal(drifted.ok, false);
    if (!drifted.ok)
        assert.match(drifted.reason, /remote branch .* differs from reviewed anchor/);
    const premature = await new GitCli(new WorkerRunner(reworkedHead, publishedHead)).verifyWorker({
        ...input,
        expectedRemoteHeadSha: null,
    });
    assert.equal(premature.ok, false);
    if (!premature.ok)
        assert.match(premature.reason, /pushed the branch before review/);
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
class WorkerRunner {
    localHead;
    remoteHead;
    status;
    constructor(localHead, remoteHead, status = "") {
        this.localHead = localHead;
        this.remoteHead = remoteHead;
        this.status = status;
    }
    run(_command, args) {
        const operation = args[2];
        if (operation === "rev-parse")
            return ok(`${this.localHead}\n`);
        if (operation === "branch")
            return ok(`${worktree.branch}\n`);
        if (operation === "merge-base")
            return ok("");
        if (operation === "rev-list")
            return ok("1\n");
        if (operation === "status")
            return ok(args.includes("--untracked-files=no") ? "" : this.status);
        if (operation === "ls-remote") {
            return ok(this.remoteHead ? `${this.remoteHead}\trefs/heads/${worktree.branch}\n` : "");
        }
        throw new Error(`unexpected git command: ${args.join(" ")}`);
    }
}
function ok(stdout) {
    return { ok: true, code: 0, stdout, stderr: "", error: null };
}
//# sourceMappingURL=git-cli.test.js.map