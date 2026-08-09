import type {
  IssueReference,
  IssueSnapshot,
  PullRequestCheck,
  PullRequestObservation,
  PullRequestRef,
  SelectedTask,
} from "../model.js";
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
  constructor(
    private readonly runner: CommandRunner = new SyncCommandRunner(),
    private readonly autoMerge = false,
  ) {}

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

  async requeueIssue(input: {
    repo: string;
    issueNumber: number;
    claimLabel: string;
    readyLabel: string;
  }): Promise<void> {
    requireSuccess(
      this.runner.run("gh", [
        "issue",
        "edit",
        String(input.issueNumber),
        "--repo",
        input.repo,
        "--add-label",
        input.readyLabel,
        "--remove-label",
        input.claimLabel,
      ]),
      `requeue issue #${input.issueNumber}`,
    );
  }

  async releaseIssueClaim(input: {
    repo: string;
    issueNumber: number;
    claimLabel: string;
  }): Promise<void> {
    requireSuccess(
      this.runner.run("gh", [
        "issue",
        "edit",
        String(input.issueNumber),
        "--repo",
        input.repo,
        "--remove-label",
        input.claimLabel,
      ]),
      `release issue #${input.issueNumber} claim`,
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
      this.runner.run("gh", [
        "pr",
        "view",
        String(number),
        "--repo",
        input.repo,
        "--json",
        "number,url,headRefOid,baseRefName,mergedAt,autoMergeRequest",
      ]),
      `gh pr view #${number}`,
    );
    const view = JSON.parse(viewRaw) as {
      number?: unknown;
      url?: unknown;
      headRefOid?: unknown;
      baseRefName?: unknown;
      mergedAt?: unknown;
      autoMergeRequest?: unknown;
    };
    if (
      typeof view.number !== "number" ||
      typeof view.url !== "string" ||
      typeof view.headRefOid !== "string" ||
      typeof view.baseRefName !== "string"
    ) {
      throw new Error("GitHub PR response has incomplete identity");
    }
    if (view.baseRefName !== input.baseRef) {
      throw new Error(`PR base ${view.baseRefName} differs from expected base ${input.baseRef}`);
    }
    if (
      this.autoMerge &&
      view.headRefOid !== input.headSha &&
      !(typeof view.mergedAt === "string" && view.mergedAt) &&
      view.autoMergeRequest
    ) {
      this.disableAutoMerge(input.repo, view.number);
    }
    if (
      this.autoMerge &&
      view.headRefOid === input.headSha &&
      !(typeof view.mergedAt === "string" && view.mergedAt) &&
      !view.autoMergeRequest
    ) {
      requireSuccess(
        this.runner.run("gh", [
          "pr",
          "merge",
          String(view.number),
          "--repo",
          input.repo,
          "--auto",
          "--match-head-commit",
          input.headSha,
          "--merge",
        ]),
        `enable auto-merge for PR #${view.number}`,
      );
    }
    return { number: view.number, url: view.url, headSha: view.headRefOid };
  }

  async observePullRequest(
    repo: string,
    pullRequest: PullRequestRef,
  ): Promise<PullRequestObservation> {
    const stdout = requireSuccess(
      this.runner.run("gh", [
        "pr",
        "view",
        String(pullRequest.number),
        "--repo",
        repo,
        "--json",
        "state,mergedAt,headRefOid,autoMergeRequest",
      ]),
      `gh pr view #${pullRequest.number}`,
    );
    const view = JSON.parse(stdout) as {
      state?: unknown;
      mergedAt?: unknown;
      headRefOid?: unknown;
      autoMergeRequest?: unknown;
    };
    if (view.headRefOid !== pullRequest.headSha) {
      if (this.autoMerge && view.state === "OPEN" && view.autoMergeRequest) {
        this.disableAutoMerge(repo, pullRequest.number);
      }
      throw new Error(`PR head changed after review: expected ${pullRequest.headSha}, got ${String(view.headRefOid)}`);
    }
    if (typeof view.mergedAt === "string" && view.mergedAt) {
      return { status: "merged", autoMergeEnabled: false, requiredChecks: [] };
    }
    if (view.state !== "OPEN") {
      return { status: "closed_unmerged", autoMergeEnabled: false, requiredChecks: [] };
    }
    return {
      status: "open",
      autoMergeEnabled: Boolean(view.autoMergeRequest),
      requiredChecks: this.readRequiredChecks(repo, pullRequest.number),
    };
  }

  async suspendAutoMerge(repo: string, pullRequest: PullRequestRef): Promise<void> {
    this.disableAutoMerge(repo, pullRequest.number);
  }

  private readRequiredChecks(repo: string, number: number): PullRequestCheck[] {
    const result = this.runner.run("gh", [
      "pr",
      "checks",
      String(number),
      "--repo",
      repo,
      "--required",
      "--json",
      "name,state,bucket,workflow,link,completedAt",
    ]);
    if (!result.stdout.trim()) {
      throw new Error(`gh pr checks #${number} failed: ${(result.error ?? result.stderr.trim()) || `exit ${result.code}`}`);
    }
    let checks: PullRequestCheck[];
    try {
      const raw = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(raw) || raw.length > 100) throw new Error("required checks response is not a bounded array");
      checks = raw.map(normalizeCheck);
    } catch (error) {
      throw new Error(`cannot parse required checks for PR #${number}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const logs = new Map<string, string>();
    for (const check of checks) {
      if (check.bucket !== "fail" && check.bucket !== "cancel") continue;
      const runId = check.link.match(/\/actions\/runs\/(\d+)/)?.[1];
      if (!runId || (logs.size >= 4 && !logs.has(runId))) continue;
      if (logs.has(runId)) continue;
      const log = this.readFailedLog(repo, runId);
      logs.set(runId, log);
      check.diagnostic = log;
    }
    return checks;
  }

  private readFailedLog(repo: string, runId: string): string {
    const result = this.runner.run("gh", ["run", "view", runId, "--repo", repo, "--log-failed"]);
    if (result.ok) return boundedFailedLog(result.stdout, 12_000);
    const diagnostic = (result.error ?? result.stderr.trim()) || result.stdout.trim() || `exit ${result.code}`;
    return bounded(`failed log unavailable: ${diagnostic}`, 2_000);
  }

  private disableAutoMerge(repo: string, number: number): void {
    requireSuccess(
      this.runner.run("gh", ["pr", "merge", String(number), "--repo", repo, "--disable-auto"]),
      `disable auto-merge for drifted PR #${number}`,
    );
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

function normalizeCheck(value: unknown): PullRequestCheck {
  if (!value || typeof value !== "object") throw new Error("required check is not an object");
  const raw = value as Record<string, unknown>;
  const name = string(raw.name, "required check name");
  const state = string(raw.state, `required check ${name} state`);
  if (!isCheckBucket(raw.bucket)) throw new Error(`required check ${name} has invalid bucket ${String(raw.bucket)}`);
  if (raw.completedAt !== null && raw.completedAt !== undefined && typeof raw.completedAt !== "string") {
    throw new Error(`required check ${name} has invalid completedAt`);
  }
  return {
    name: bounded(name, 512),
    state: bounded(state, 512),
    bucket: raw.bucket,
    workflow: typeof raw.workflow === "string" ? bounded(raw.workflow, 512) : "",
    link: typeof raw.link === "string" ? bounded(raw.link, 2_000) : "",
    completedAt: typeof raw.completedAt === "string" ? bounded(raw.completedAt, 512) : null,
    diagnostic: null,
  };
}

function isCheckBucket(value: unknown): value is PullRequestCheck["bucket"] {
  return value === "pass" || value === "fail" || value === "pending" || value === "skipping" || value === "cancel";
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}

function boundedTail(value: string, max: number): string {
  return value.length <= max ? value : `...[truncated]\n${value.slice(-max)}`;
}

function boundedFailedLog(value: string, max: number): string {
  if (value.length <= max) return value;
  const signal = [
    /\bExpected:\s/gi,
    /\bReceived:\s/gi,
    /Error:\s+expect\b/gi,
    /\bAssertionError\b/gi,
    /##\[error\]/gi,
    /Traceback \(most recent call last\)/g,
    /\bpanic:/gi,
    /\berror(?:\[[^\]]+\])?:/gi,
  ].map((pattern) => lastMatchIndex(value, pattern)).find((index) => index >= 0) ?? -1;
  if (signal < 0 || signal >= value.length - max) return boundedTail(value, max);

  const prefix = "...[focused failure excerpt]\n";
  const divider = "\n...[final log tail]\n";
  const tailLength = Math.min(3_000, Math.floor(max / 4));
  const focusLength = max - prefix.length - divider.length - tailLength;
  const focusStart = Math.max(0, signal - Math.floor(focusLength / 2));
  return `${prefix}${value.slice(focusStart, focusStart + focusLength)}${divider}${value.slice(-tailLength)}`;
}

function lastMatchIndex(value: string, pattern: RegExp): number {
  let index = -1;
  for (const match of value.matchAll(pattern)) index = match.index;
  return index;
}
