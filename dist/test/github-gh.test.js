import test from "node:test";
import assert from "node:assert/strict";
import { GitHubGh } from "../src/adapters/github-gh.js";
const headSha = "b".repeat(40);
test("publishing in auto mode enables native auto-merge for the reviewed head", async () => {
    const runner = new PublishRunner();
    const github = new GitHubGh(runner, true);
    const pullRequest = await github.publish({
        repo: "owner/repo",
        issueNumber: 39,
        branch: "agent/issue-39",
        baseRef: "main",
        headSha,
        title: "Implement issue 39",
        worktreePath: "/worktree",
    });
    assert.deepEqual(pullRequest, {
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        headSha,
    });
    assert.deepEqual(runner.calls.at(-1), {
        command: "gh",
        args: [
            "pr",
            "merge",
            "42",
            "--repo",
            "owner/repo",
            "--auto",
            "--match-head-commit",
            headSha,
            "--merge",
        ],
    });
});
test("observing a changed PR head disables auto-merge before rejecting it", async () => {
    const runner = new DriftRunner();
    const github = new GitHubGh(runner, true);
    await assert.rejects(() => github.observePullRequest("owner/repo", {
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        headSha,
    }), /PR head changed after review/);
    assert.deepEqual(runner.calls.at(-1), {
        command: "gh",
        args: ["pr", "merge", "42", "--repo", "owner/repo", "--disable-auto"],
    });
});
class PublishRunner {
    calls = [];
    run(command, args) {
        this.calls.push({ command, args: [...args] });
        if (command === "git")
            return ok("");
        if (args[0] === "pr" && args[1] === "list")
            return ok("[]");
        if (args[0] === "pr" && args[1] === "create")
            return ok("https://github.com/owner/repo/pull/42\n");
        if (args[0] === "pr" && args[1] === "view") {
            return ok(JSON.stringify({
                number: 42,
                url: "https://github.com/owner/repo/pull/42",
                headRefOid: headSha,
                baseRefName: "main",
                mergedAt: null,
                autoMergeRequest: null,
            }));
        }
        if (args[0] === "pr" && args[1] === "merge")
            return ok("");
        return fail(`unexpected command: ${command} ${args.join(" ")}`);
    }
}
class DriftRunner {
    calls = [];
    run(command, args) {
        this.calls.push({ command, args: [...args] });
        if (args[0] === "pr" && args[1] === "view") {
            return ok(JSON.stringify({
                state: "OPEN",
                mergedAt: null,
                headRefOid: "c".repeat(40),
                autoMergeRequest: { enabledAt: "2026-08-05T00:00:00Z" },
            }));
        }
        if (args[0] === "pr" && args[1] === "merge" && args.includes("--disable-auto"))
            return ok("");
        return fail(`unexpected command: ${command} ${args.join(" ")}`);
    }
}
function ok(stdout) {
    return { ok: true, code: 0, stdout, stderr: "", error: null };
}
function fail(stderr) {
    return { ok: false, code: 1, stdout: "", stderr, error: null };
}
//# sourceMappingURL=github-gh.test.js.map