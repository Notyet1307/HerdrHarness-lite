import { requireSuccess, SyncCommandRunner } from "./command.js";
const ISSUE_FIELDS = "number,title,body,state,updatedAt,labels,assignees,blockedBy,parent,subIssues";
/** GitHub adapter built only on `gh` and `git`; mutations are idempotent. */
export class GitHubGh {
    runner;
    autoMerge;
    constructor(runner = new SyncCommandRunner(), autoMerge = false) {
        this.runner = runner;
        this.autoMerge = autoMerge;
    }
    async listIssueGraph(repo, readyLabel) {
        const stdout = requireSuccess(this.runner.run("gh", [
            "issue",
            "list",
            "--repo",
            repo,
            "--state",
            "open",
            "--label",
            readyLabel,
            "--limit",
            "100",
            "--json",
            ISSUE_FIELDS,
        ]), "gh issue list");
        const raw = JSON.parse(stdout);
        if (!Array.isArray(raw))
            throw new Error("GitHub issue list response is not an array");
        const byNumber = new Map();
        const queue = [];
        for (const item of raw) {
            const issue = normalizeIssue(item);
            byNumber.set(issue.number, issue);
            enqueueReferences(issue, queue, byNumber);
        }
        const visited = new Set();
        while (queue.length > 0) {
            if (byNumber.size > 200)
                throw new Error("issue graph exceeds the V1 safety limit of 200 issues");
            const number = queue.shift();
            if (byNumber.has(number) || visited.has(number))
                continue;
            visited.add(number);
            const issue = await this.getIssue(repo, number);
            byNumber.set(number, issue);
            enqueueReferences(issue, queue, byNumber);
        }
        return [...byNumber.values()].sort((a, b) => a.number - b.number);
    }
    async getIssue(repo, issueNumber) {
        const stdout = requireSuccess(this.runner.run("gh", ["issue", "view", String(issueNumber), "--repo", repo, "--json", ISSUE_FIELDS]), `gh issue view #${issueNumber}`);
        return normalizeIssue(JSON.parse(stdout));
    }
    async claimIssue(input) {
        requireSuccess(this.runner.run("gh", [
            "issue",
            "edit",
            String(input.task.issue.number),
            "--repo",
            input.repo,
            "--add-label",
            input.claimLabel,
            "--remove-label",
            input.readyLabel,
        ]), `claim issue #${input.task.issue.number}`);
    }
    async publish(input) {
        requireSuccess(this.runner.run("git", ["-C", input.worktreePath, "push", "--set-upstream", "origin", input.branch]), "git push reviewed branch");
        const existingRaw = requireSuccess(this.runner.run("gh", [
            "pr",
            "list",
            "--repo",
            input.repo,
            "--head",
            input.branch,
            "--state",
            "all",
            "--limit",
            "10",
            "--json",
            "number,url,state,mergedAt,headRefOid",
        ]), "gh pr list");
        const existing = JSON.parse(existingRaw);
        let number;
        if (existing.length > 0) {
            const pr = existing[0];
            if (typeof pr.number !== "number")
                throw new Error("existing PR has no number");
            if (pr.state === "CLOSED" && !pr.mergedAt)
                throw new Error(`existing PR #${pr.number} is closed without merge`);
            number = pr.number;
        }
        else {
            const created = requireSuccess(this.runner.run("gh", [
                "pr",
                "create",
                "--repo",
                input.repo,
                "--head",
                input.branch,
                "--base",
                input.baseRef,
                "--title",
                input.title,
                "--body",
                `Closes #${input.issueNumber}`,
            ]), "gh pr create");
            const match = created.match(/\/pull\/(\d+)/);
            if (!match)
                throw new Error(`cannot parse created PR URL: ${created.trim()}`);
            number = Number(match[1]);
        }
        const viewRaw = requireSuccess(this.runner.run("gh", [
            "pr",
            "view",
            String(number),
            "--repo",
            input.repo,
            "--json",
            "number,url,headRefOid,baseRefName,mergedAt,autoMergeRequest",
        ]), `gh pr view #${number}`);
        const view = JSON.parse(viewRaw);
        if (typeof view.number !== "number" ||
            typeof view.url !== "string" ||
            typeof view.headRefOid !== "string" ||
            typeof view.baseRefName !== "string") {
            throw new Error("GitHub PR response has incomplete identity");
        }
        if (view.baseRefName !== input.baseRef) {
            throw new Error(`PR base ${view.baseRefName} differs from expected base ${input.baseRef}`);
        }
        if (this.autoMerge &&
            view.headRefOid === input.headSha &&
            !(typeof view.mergedAt === "string" && view.mergedAt) &&
            !view.autoMergeRequest) {
            requireSuccess(this.runner.run("gh", [
                "pr",
                "merge",
                String(view.number),
                "--repo",
                input.repo,
                "--auto",
                "--match-head-commit",
                input.headSha,
                "--merge",
            ]), `enable auto-merge for PR #${view.number}`);
        }
        return { number: view.number, url: view.url, headSha: view.headRefOid };
    }
    async observePullRequest(repo, pullRequest) {
        const stdout = requireSuccess(this.runner.run("gh", [
            "pr",
            "view",
            String(pullRequest.number),
            "--repo",
            repo,
            "--json",
            "state,mergedAt,headRefOid,autoMergeRequest",
        ]), `gh pr view #${pullRequest.number}`);
        const view = JSON.parse(stdout);
        if (view.headRefOid !== pullRequest.headSha) {
            if (this.autoMerge && view.state === "OPEN" && view.autoMergeRequest) {
                requireSuccess(this.runner.run("gh", [
                    "pr",
                    "merge",
                    String(pullRequest.number),
                    "--repo",
                    repo,
                    "--disable-auto",
                ]), `disable auto-merge for drifted PR #${pullRequest.number}`);
            }
            throw new Error(`PR head changed after review: expected ${pullRequest.headSha}, got ${String(view.headRefOid)}`);
        }
        if (typeof view.mergedAt === "string" && view.mergedAt)
            return "merged";
        return view.state === "OPEN" ? "open" : "closed_unmerged";
    }
}
function enqueueReferences(issue, queue, known) {
    if (issue.parentNumber !== null && !known.has(issue.parentNumber))
        queue.push(issue.parentNumber);
    for (const child of issue.subIssues)
        if (!known.has(child.number))
            queue.push(child.number);
}
function normalizeIssue(raw) {
    const number = integer(raw.number, "issue.number");
    const title = string(raw.title, "issue.title");
    const state = normalizeState(raw.state);
    const updatedAt = string(raw.updatedAt, "issue.updatedAt");
    const labels = (raw.labels ?? []).flatMap((label) => {
        const value = typeof label === "string" ? label : label.name;
        return typeof value === "string" ? [value] : [];
    });
    const assignees = (raw.assignees ?? []).flatMap((assignee) => {
        const value = typeof assignee === "string" ? assignee : assignee.login;
        return typeof value === "string" ? [value] : [];
    });
    return {
        number,
        title,
        body: typeof raw.body === "string" ? raw.body.slice(0, 24_000) : "",
        state,
        labels,
        assignees,
        blockedBy: normalizeConnection(raw.blockedBy),
        parentNumber: raw.parent ? integer(raw.parent.number, "issue.parent.number") : null,
        subIssues: normalizeConnection(raw.subIssues),
        updatedAt,
    };
}
function normalizeConnection(value) {
    const nodes = Array.isArray(value) ? value : value?.nodes ?? [];
    return nodes.map((node) => ({
        number: integer(node.number, "issue reference number"),
        state: normalizeState(node.state),
    }));
}
function normalizeState(value) {
    if (value === "OPEN" || value === "CLOSED")
        return value;
    throw new Error(`invalid GitHub issue state: ${String(value)}`);
}
function integer(value, name) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
        throw new Error(`${name} is invalid`);
    return value;
}
function string(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} is invalid`);
    return value;
}
//# sourceMappingURL=github-gh.js.map