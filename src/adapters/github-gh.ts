import type { IssueReference, IssueSnapshot, PullRequestRef, SelectedTask } from "../model.js";
import type { GitHubPort } from "../ports.js";
import { type CommandRunner, requireSuccess, SyncCommandRunner } from "./command.js";

type RawConnection = RawReference[] | { nodes?: RawReference[]; totalCount?: number };
type RawReference = { number?: unknown; state?: unknown };
type RawIssue = {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  updatedAt?: unknown;
  labels?: Array<string | { name?: unknown }>;
  assignees?: Array<string | { login?: unknown }>;
  blockedBy?: RawConnection;
  parent?: { number?: unknown } | null;
  subIssues?: RawConnection;
};

const ISSUE_FIELDS = "number,title,body,state,updatedAt,labels,assignees,blockedBy,parent,subIssues";

/** GitHub adapter built only on `gh` and `git`; mutations are idempotent. */
export class GitHubGh implements GitHubPort {
  constructor(private readonly runner: CommandRunner = new SyncCommandRunner()) {}

  async listIssueGraph(repo: string, readyLabel: string): Promise<IssueSnapshot[]> {
    const stdout = requireSuccess(
      this.runner.run("gh", [
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
      ]),
      "gh issue list",
    );
    const raw = JSON.parse(stdout) as RawIssue[];
    if (!Array.isArray(raw)) throw new Error("GitHub issue list response is not an array");

    const byNumber = new Map<number, IssueSnapshot>();
    const queue: number[] = [];
    for (const item of raw) {
      const issue = normalizeIssue(item);
      byNumber.set(issue.number, issue);
      enqueueReferences(issue, queue, byNumber);
    }

    const visited = new Set<number>();
    while (queue.length > 0) {
      if (byNumber.size > 200) throw new Error("issue graph exceeds the V1 safety limit of 200 issues");
      const number = queue.shift()!;
      if (byNumber.has(number) || visited.has(number)) continue;
      visited.add(number);
      const issue = await this.getIssue(repo, number);
      byNumber.set(number, issue);
      enqueueReferences(issue, queue, byNumber);
    }
    return [...byNumber.values()].sort((a, b) => a.number - b.number);
  }

  async getIssue(repo: string, issueNumber: number): Promise<IssueSnapshot> {
    const stdout = requireSuccess(
      this.runner.run("gh", ["issue", "view", String(issueNumber), "--repo", repo, "--json", ISSUE_FIELDS]),
      `gh issue view #${issueNumber}`,
    );
    return normalizeIssue(JSON.parse(stdout) as RawIssue);
  }

  async claimIssue(input: {
    repo: string;
    task: SelectedTask;
    jobId: string;
    claimLabel: string;
    readyLabel: string;
  }): Promise<void> {
    requireSuccess(
      this.runner.run("gh", [
        "issue",
        "edit",
        String(input.task.issue.number),
        "--repo",
        input.repo,
        "--add-label",
        input.claimLabel,
        "--remove-label",
        input.readyLabel,
      ]),
      `claim issue #${input.task.issue.number}`,
    );
  }

  async publish(input: {
    repo: string;
    issueNumber: number;
    branch: string;
    baseRef: string;
    headSha: string;
    title: string;
    worktreePath: string;
  }): Promise<PullRequestRef> {
    requireSuccess(
      this.runner.run("git", ["-C", input.worktreePath, "push", "--set-upstream", "origin", input.branch]),
      "git push reviewed branch",
    );

    const existingRaw = requireSuccess(
      this.runner.run("gh", [
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
      ]),
      "gh pr list",
    );
    const existing = JSON.parse(existingRaw) as Array<{
      number?: unknown;
      url?: unknown;
      state?: unknown;
      mergedAt?: unknown;
      headRefOid?: unknown;
    }>;
    let number: number;
    if (existing.length > 0) {
      const pr = existing[0]!;
      if (typeof pr.number !== "number") throw new Error("existing PR has no number");
      if (pr.state === "CLOSED" && !pr.mergedAt) throw new Error(`existing PR #${pr.number} is closed without merge`);
      number = pr.number;
    } else {
      const created = requireSuccess(
        this.runner.run("gh", [
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
        ]),
        "gh pr create",
      );
      const match = created.match(/\/pull\/(\d+)/);
      if (!match) throw new Error(`cannot parse created PR URL: ${created.trim()}`);
      number = Number(match[1]);
    }

    const viewRaw = requireSuccess(
      this.runner.run("gh", ["pr", "view", String(number), "--repo", input.repo, "--json", "number,url,headRefOid"]),
      `gh pr view #${number}`,
    );
    const view = JSON.parse(viewRaw) as { number?: unknown; url?: unknown; headRefOid?: unknown };
    if (typeof view.number !== "number" || typeof view.url !== "string" || typeof view.headRefOid !== "string") {
      throw new Error("GitHub PR response has incomplete identity");
    }
    return { number: view.number, url: view.url, headSha: view.headRefOid };
  }

  async observePullRequest(
    repo: string,
    pullRequest: PullRequestRef,
  ): Promise<"open" | "merged" | "closed_unmerged"> {
    const stdout = requireSuccess(
      this.runner.run("gh", [
        "pr",
        "view",
        String(pullRequest.number),
        "--repo",
        repo,
        "--json",
        "state,mergedAt,headRefOid",
      ]),
      `gh pr view #${pullRequest.number}`,
    );
    const view = JSON.parse(stdout) as { state?: unknown; mergedAt?: unknown; headRefOid?: unknown };
    if (view.headRefOid !== pullRequest.headSha) {
      throw new Error(`PR head changed after review: expected ${pullRequest.headSha}, got ${String(view.headRefOid)}`);
    }
    if (typeof view.mergedAt === "string" && view.mergedAt) return "merged";
    return view.state === "OPEN" ? "open" : "closed_unmerged";
  }
}

function enqueueReferences(issue: IssueSnapshot, queue: number[], known: Map<number, IssueSnapshot>): void {
  if (issue.parentNumber !== null && !known.has(issue.parentNumber)) queue.push(issue.parentNumber);
  for (const child of issue.subIssues) if (!known.has(child.number)) queue.push(child.number);
}

function normalizeIssue(raw: RawIssue): IssueSnapshot {
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

function normalizeConnection(value: RawConnection | undefined): IssueReference[] {
  const nodes = Array.isArray(value) ? value : value?.nodes ?? [];
  return nodes.map((node) => ({
    number: integer(node.number, "issue reference number"),
    state: normalizeState(node.state),
  }));
}

function normalizeState(value: unknown): "OPEN" | "CLOSED" {
  if (value === "OPEN" || value === "CLOSED") return value;
  throw new Error(`invalid GitHub issue state: ${String(value)}`);
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${name} is invalid`);
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is invalid`);
  return value;
}
