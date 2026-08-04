import { resolve } from "node:path";
import { digest, type AnalystSession, type AnalystTurn, type AttemptResult, type EvidenceItem, type EvidenceRequest, type HarnessState, type IssueSnapshot, type Job, type PullRequestRef, type SelectedTask } from "../src/model.js";
import type { AnalystPort, Clock, EvidencePort, GitHubPort, GitPort, HerdrPort, IdGenerator, StateStore } from "../src/ports.js";

export const validCodeReviewSkillPath = resolve("pi/skills/code-review");
export const validImplementSkillPath = resolve("test/fixtures/pi-skills/skills/implement");
export const validTddSkillPath = resolve("test/fixtures/pi-skills/skills/tdd");
export const substituteCodeReviewSkillPath = resolve("test/fixtures/substitute-review/other/SKILL.md");
export const untrustedImplementSkillPath = resolve("test/fixtures/untrusted-skills/skills/implement");

export const validWorkerArgv = [
  "--no-approve",
  "--no-skills",
  "--skill", validImplementSkillPath,
  "--skill", validTddSkillPath,
  "--skill", validCodeReviewSkillPath,
  "--tools", "read,bash,edit,write,grep,find,ls,subagent",
  "--thinking", "high",
];

export const validReviewerArgv = [
  "--no-approve",
  "--no-skills",
  "--skill", validCodeReviewSkillPath,
  "--tools", "read,bash,grep,find,ls,subagent",
  "--thinking", "high",
];

export class FakeClock implements Clock {
  private tick = 0;
  now(): string {
    this.tick += 1;
    return `2026-08-03T00:00:${String(this.tick).padStart(2, "0")}.000Z`;
  }
}

export class SequenceIds implements IdGenerator {
  private count = 0;
  next(prefix: string): string {
    this.count += 1;
    return `${prefix}-${String(this.count).padStart(3, "0")}`;
  }
}

export class MemoryStore implements StateStore {
  state: HarnessState = { version: 1, activeJob: null, terminalJobs: [] };
  saves: HarnessState[] = [];

  async load(): Promise<HarnessState> {
    return clone(this.state);
  }

  async save(next: HarnessState, expectedActiveRevision: number | null): Promise<void> {
    const current = this.state.activeJob?.revision ?? null;
    if (current !== expectedActiveRevision) throw new Error(`CAS expected ${expectedActiveRevision}, current ${current}`);
    this.state = clone(next);
    this.saves.push(clone(next));
  }
}

export class FakeGitHub implements GitHubPort {
  claims: Array<{ issue: number; jobId: string }> = [];
  published: PullRequestRef[] = [];
  mergeStatus: "open" | "merged" | "closed_unmerged" = "open";

  constructor(public graph: IssueSnapshot[]) {}

  async listIssueGraph(_repo: string, _readyLabel: string): Promise<IssueSnapshot[]> {
    return clone(this.graph);
  }

  async getIssue(_repo: string, issueNumber: number): Promise<IssueSnapshot> {
    const issue = this.graph.find((candidate) => candidate.number === issueNumber);
    if (!issue) throw new Error(`missing issue #${issueNumber}`);
    return clone(issue);
  }

  async claimIssue(input: { repo: string; task: SelectedTask; jobId: string; claimLabel: string; readyLabel: string }): Promise<void> {
    this.claims.push({ issue: input.task.issue.number, jobId: input.jobId });
    const issue = this.graph.find((candidate) => candidate.number === input.task.issue.number);
    if (issue) {
      issue.labels = issue.labels.filter((label) => label !== input.readyLabel);
      if (!issue.labels.includes(input.claimLabel)) issue.labels.push(input.claimLabel);
    }
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
    const pr = { number: 42, url: "https://example.test/pr/42", headSha: input.headSha };
    this.published.push(pr);
    return pr;
  }

  async observePullRequest(_repo: string, _pullRequest: PullRequestRef): Promise<"open" | "merged" | "closed_unmerged"> {
    return this.mergeStatus;
  }
}

export class FakeGit implements GitPort {
  baseSha = "a".repeat(40);
  workerFailure: { class: "integrity_violation" | "stale_task"; reason: string } | null = null;
  reviewerFailure: string | null = null;

  async refreshBase(): Promise<string> {
    return this.baseSha;
  }

  async verifyWorker(input: { reportedHeadSha: string }): Promise<{ ok: true; headSha: string } | { ok: false; class: "integrity_violation" | "stale_task"; reason: string }> {
    return this.workerFailure ? { ok: false, ...this.workerFailure } : { ok: true, headSha: input.reportedHeadSha };
  }

  async verifyReviewer(): Promise<{ ok: true } | { ok: false; class: "integrity_violation"; reason: string }> {
    return this.reviewerFailure
      ? { ok: false, class: "integrity_violation", reason: this.reviewerFailure }
      : { ok: true };
  }
}

type Outcome = (
  | { lane: "worker"; status: "completed" | "blocked" | "failed"; summary?: string; headSha?: string }
  | { lane: "reviewer"; status: "pass" | "changes" | "blocked" | "failed"; summary?: string; reviewedHeadSha?: string; findings?: Array<{ severity: "critical" | "major" | "minor"; summary: string; evidence: string }> }
) & { agentStatus?: "idle" | "done" | "blocked" | "unknown" };

export class FakeHerdr implements HerdrPort {
  prepared: Array<{ attemptId: string; lane: string; handle: { agentName: string; paneId: string; tabId: string; workspaceId: string } }> = [];
  started: string[] = [];
  prompts: Array<{ dispatchId: string; skill: "implement" | "code-review"; text: string }> = [];
  closed: string[] = [];
  promptFailureAfterDispatch: Error | null = null;
  waitFailure: Error | null = null;

  constructor(private readonly outcomes: Outcome[]) {}

  async createWorktree(input: { branch: string; path: string }): Promise<{ workspaceId: string; path: string; branch: string }> {
    return { workspaceId: "ws-1", path: input.path, branch: input.branch };
  }

  async createAttemptPane(input: { worktree: { workspaceId: string }; attempt: { id: string; lane: "worker" | "reviewer" } }): Promise<{ agentName: string; paneId: string; tabId: string; workspaceId: string }> {
    const handle = {
      agentName: `agent-${input.attempt.id}`,
      paneId: `pane-${input.attempt.id}`,
      tabId: `tab-${input.attempt.id}`,
      workspaceId: input.worktree.workspaceId,
    };
    this.prepared.push({ attemptId: input.attempt.id, lane: input.attempt.lane, handle });
    return handle;
  }

  async startAgent(input: { handle: { agentName: string } }): Promise<void> {
    this.started.push(input.handle.agentName);
  }

  async prompt(input: { dispatchId: string; skill: "implement" | "code-review"; text: string }): Promise<void> {
    this.prompts.push({ dispatchId: input.dispatchId, skill: input.skill, text: input.text });
    const failure = this.promptFailureAfterDispatch;
    this.promptFailureAfterDispatch = null;
    if (failure) throw failure;
  }

  async wait(input: {
    expectedJobId: string;
    expectedAttemptId: string;
    expectedLane: "worker" | "reviewer";
  }): Promise<{ agentStatus: "idle" | "done" | "blocked" | "unknown"; result: AttemptResult | null; diagnostic: string | null }> {
    const failure = this.waitFailure;
    this.waitFailure = null;
    if (failure) throw failure;
    const outcome = this.outcomes.shift();
    if (!outcome) throw new Error("no fake outcome queued");
    if (outcome.lane !== input.expectedLane) throw new Error(`expected ${input.expectedLane}, got ${outcome.lane}`);
    if (outcome.lane === "worker") {
      const result: AttemptResult = {
        version: 1,
        jobId: input.expectedJobId,
        attemptId: input.expectedAttemptId,
        lane: "worker",
        status: outcome.status,
        summary: outcome.summary ?? outcome.status,
        headSha: outcome.status === "completed" ? (outcome.headSha ?? "b".repeat(40)) : null,
        failedCommands: [],
      };
      return { agentStatus: outcome.agentStatus ?? (outcome.status === "blocked" ? "blocked" : "done"), result, diagnostic: null };
    }
    const job = currentJobId(input.expectedJobId);
    const result: AttemptResult = {
      version: 1,
      jobId: job,
      attemptId: input.expectedAttemptId,
      lane: "reviewer",
      status: outcome.status,
      summary: outcome.summary ?? outcome.status,
      reviewedHeadSha: outcome.status === "pass" || outcome.status === "changes" ? (outcome.reviewedHeadSha ?? "b".repeat(40)) : null,
      findings: outcome.findings ?? [],
    };
    return { agentStatus: outcome.agentStatus ?? (outcome.status === "blocked" ? "blocked" : "done"), result, diagnostic: null };
  }

  async close(handle: { agentName: string }): Promise<void> {
    this.closed.push(handle.agentName);
  }
}

export class FakeAnalyst implements AnalystPort {
  starts: Array<{ jobId: string; taskDigest: string }> = [];
  closes: Array<{ jobId: string; sessionId: string | null; taskDigest: string }> = [];
  closeFailure: Error | null = null;
  turns: AnalystTurn[];

  constructor(turns: AnalystTurn[] = [{
    kind: "advice",
    action: "hold",
    summary: "hold",
    resolutionBrief: "",
    evidenceRefs: ["task"],
    unknowns: [],
  }]) {
    this.turns = [...turns];
  }

  async start(input: { jobId: string; task: { digest: string } }): Promise<AnalystSession> {
    this.starts.push({ jobId: input.jobId, taskDigest: input.task.digest });
    return {
      id: `analyst-${input.jobId}`,
      agentName: `codex-${input.jobId}`,
      startedAt: "2026-08-03T00:00:00.000Z",
      taskDigest: input.task.digest,
    };
  }

  async turn(): Promise<AnalystTurn> {
    const turn = this.turns.shift();
    if (!turn) throw new Error("no analyst turn queued");
    return turn;
  }

  async close(input: { jobId: string; session: AnalystSession | null; taskDigest: string }): Promise<void> {
    this.closes.push({ jobId: input.jobId, sessionId: input.session?.id ?? null, taskDigest: input.taskDigest });
    if (this.closeFailure) throw this.closeFailure;
  }
}

export class FakeEvidence implements EvidencePort {
  async initial(job: Job): Promise<{ items: EvidenceItem[]; missing: string[] }> {
    return {
      items: [
        {
          ref: "task",
          source: "task",
          summary: job.task.objective,
          digest: digest(job.task.objective),
          trust: "untrusted",
        },
      ],
      missing: ["git_diff"],
    };
  }

  async collect(_job: Job, requests: EvidenceRequest[]): Promise<EvidenceItem[]> {
    return requests.map((request, index) => ({
      ref: `${request.kind}-${index}`,
      source: request.kind,
      summary: request.reason,
      digest: digest(request),
      trust: "untrusted",
    }));
  }
}

export function issue(input: Partial<IssueSnapshot> & Pick<IssueSnapshot, "number" | "title">): IssueSnapshot {
  return {
    number: input.number,
    title: input.title,
    body: input.body ?? `Implement ${input.title}`,
    state: input.state ?? "OPEN",
    labels: input.labels ?? ["ready-for-agent"],
    assignees: input.assignees ?? [],
    blockedBy: input.blockedBy ?? [],
    parentNumber: input.parentNumber ?? null,
    subIssues: input.subIssues ?? [],
    updatedAt: input.updatedAt ?? "2026-08-03T00:00:00Z",
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function currentJobId(value: string): string {
  return value;
}
