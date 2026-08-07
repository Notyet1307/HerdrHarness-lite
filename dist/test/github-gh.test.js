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
test("publish recovery disables an existing auto-merge request after head drift", async () => {
    const runner = new PublishDriftRunner();
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
    assert.equal(pullRequest.headSha, "c".repeat(40));
    assert.deepEqual(runner.calls.at(-1), {
        command: "gh",
        args: ["pr", "merge", "42", "--repo", "owner/repo", "--disable-auto"],
    });
});
test("observing an open PR returns required check failures with bounded failed logs", async () => {
    const runner = new FailedChecksRunner();
    const github = new GitHubGh(runner, true);
    const observation = await github.observePullRequest("owner/repo", {
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        headSha,
    });
    assert.deepEqual(observation, {
        status: "open",
        autoMergeEnabled: true,
        requiredChecks: [{
                name: "test-backend",
                state: "FAILURE",
                bucket: "fail",
                workflow: "Backend",
                link: "https://github.com/owner/repo/actions/runs/123/job/456",
                completedAt: "2026-08-06T00:00:00Z",
                diagnostic: "test-backend\tFAIL\nassertion failed\n",
            }],
    });
    assert.deepEqual(runner.calls.at(-1), {
        command: "gh",
        args: ["run", "view", "123", "--repo", "owner/repo", "--log-failed"],
    });
    await github.suspendAutoMerge("owner/repo", {
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        headSha,
    });
    assert.deepEqual(runner.calls.at(-1), {
        command: "gh",
        args: ["pr", "merge", "42", "--repo", "owner/repo", "--disable-auto"],
    });
});
test("bounded failed logs retain the failure tail instead of build startup noise", async () => {
    const runner = new FailedChecksRunner(`${"build startup noise\n".repeat(1_000)}playwright timeout\nlogin returned 400\n`);
    const github = new GitHubGh(runner, true);
    const observation = await github.observePullRequest("owner/repo", {
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        headSha,
    });
    const diagnostic = observation.requiredChecks[0]?.diagnostic ?? "";
    assert.match(diagnostic, /^\.\.\.\[truncated\]\n/);
    assert.equal(diagnostic.startsWith("build startup noise"), false);
    assert.match(diagnostic, /playwright timeout\nlogin returned 400\n$/);
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
class PublishDriftRunner {
    calls = [];
    run(command, args) {
        this.calls.push({ command, args: [...args] });
        if (command === "git")
            return ok("");
        if (args[0] === "pr" && args[1] === "list") {
            return ok(JSON.stringify([{
                    number: 42,
                    url: "https://github.com/owner/repo/pull/42",
                    state: "OPEN",
                    mergedAt: null,
                    headRefOid: "c".repeat(40),
                }]));
        }
        if (args[0] === "pr" && args[1] === "view") {
            return ok(JSON.stringify({
                number: 42,
                url: "https://github.com/owner/repo/pull/42",
                headRefOid: "c".repeat(40),
                baseRefName: "main",
                mergedAt: null,
                autoMergeRequest: { enabledAt: "2026-08-05T00:00:00Z" },
            }));
        }
        if (args[0] === "pr" && args[1] === "merge" && args.includes("--disable-auto"))
            return ok("");
        return fail(`unexpected command: ${command} ${args.join(" ")}`);
    }
}
class FailedChecksRunner {
    failedLog;
    calls = [];
    constructor(failedLog = "test-backend\tFAIL\nassertion failed\n") {
        this.failedLog = failedLog;
    }
    run(command, args) {
        this.calls.push({ command, args: [...args] });
        if (args[0] === "pr" && args[1] === "view") {
            return ok(JSON.stringify({
                state: "OPEN",
                mergedAt: null,
                headRefOid: headSha,
                autoMergeRequest: { enabledAt: "2026-08-06T00:00:00Z" },
            }));
        }
        if (args[0] === "pr" && args[1] === "checks") {
            return {
                ok: false,
                code: 1,
                stdout: JSON.stringify([{
                        name: "test-backend",
                        state: "FAILURE",
                        bucket: "fail",
                        workflow: "Backend",
                        link: "https://github.com/owner/repo/actions/runs/123/job/456",
                        completedAt: "2026-08-06T00:00:00Z",
                    }]),
                stderr: "",
                error: null,
            };
        }
        if (args[0] === "run" && args[1] === "view")
            return ok(this.failedLog);
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