import { join, resolve } from "node:path";
import { digest, type AnalystSession, type AnalystTurn, type AttemptResult, type EvidenceItem, type EvidenceRequest, type HarnessState, type IssueSnapshot, type Job, type PullRequestCheck, type PullRequestObservation, type PullRequestRef, type SelectedTask } from "../src/model.js";
import type { AnalystPort, Clock, EvidencePort, GitHubPort, GitPort, HerdrPort, IdGenerator, RuntimePreflightPort, StateStore } from "../src/ports.js";

export const validCodeReviewSkillPath = resolve("pi/skills/code-review");
export const validFocusedSelfCheckSkillPath = resolve("pi/skills/focused-self-check");
export const validPiSubagentsExtensionPath = resolve("test/fixtures/pi-subagents/index.js");
export const validWorkerToolsExtensionPath = resolve("pi/extensions/worker-tools.js");
export const validReviewerToolsExtensionPath = resolve("pi/extensions/reviewer-tools.js");
export const validImplementSkillPath = resolve("test/fixtures/pi-skills/skills/implement");
export const validTddSkillPath = resolve("test/fixtures/pi-skills/skills/tdd");
export const substituteCodeReviewSkillPath = resolve("test/fixtures/substitute-review/other/SKILL.md");
export const untrustedImplementSkillPath = resolve("test/fixtures/untrusted-skills/skills/implement");

export const validWorkerArgv = [
  "--no-approve",
  "--no-skills",
  "--no-extensions",
  "--extension", validWorkerToolsExtensionPath,
  "--skill", validImplementSkillPath,
  "--skill", validTddSkillPath,
  "--skill", validFocusedSelfCheckSkillPath,
  "--tools", "read,bash,edit,write,grep,find,ls,worker_submit",
  "--thinking", "high",
];

export const validReviewerArgv = [
  "--no-approve",
  "--no-skills",
  "--no-extensions",
  "--extension", validPiSubagentsExtensionPath,
  "--extension", validReviewerToolsExtensionPath,
  "--skill", validCodeReviewSkillPath,
  "--tools", "read,grep,find,ls,subagent,review_preflight,review_validate,review_submit",
  "--thinking", "max",
];

export class FakeClock implements Clock {
  private tick = 0;
  now(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 7, 3, 0, 0, this.tick)).toISOString();
  }
}

export class SequenceIds implements IdGenerator {
  private count = 0;
  next(prefix: string): string {
    this.count += 1;
    return `${prefix}-${String(this.count).padStart(3, "0")}`;
  }
}

export class FakeRuntimePreflight implements RuntimePreflightPort {
  providerCalls: Array<{ lane: "worker" | "reviewer"; cwd: string; roleArgv: string[]; piBin: string }> = [];
  dockerCalls: string[] = [];
  providerFailure: Error | null = null;
  dockerFailure: Error | null = null;
  dockerHost = "unix:///tmp/docker.sock";

  async probeProvider(input: { lane: "worker" | "reviewer"; cwd: string; roleArgv: string[]; piBin: string }): Promise<void> {
    this.providerCalls.push({ ...input, roleArgv: [...input.roleArgv] });
    if (this.providerFailure) throw this.providerFailure;
  }

  async probeDocker(input: { cwd: string }): Promise<{ host: string }> {
    this.dockerCalls.push(input.cwd);
    if (this.dockerFailure) throw this.dockerFailure;
    return { host: this.dockerHost };
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
  releasedClaims: number[] = [];
  published: PullRequestRef[] = [];
  suspended: number[] = [];
  mergeStatus: "open" | "merged" | "closed_unmerged" = "open";
  autoMergeEnabled = false;
  requiredChecks: PullRequestCheck[] = [];
  suspendFailure: Error | null = null;
  releaseClaimFailure: Error | null = null;

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

  async requeueIssue(input: { repo: string; issueNumber: number; claimLabel: string; readyLabel: string }): Promise<void> {
    const issue = this.graph.find((candidate) => candidate.number === input.issueNumber);
    if (!issue) throw new Error(`missing issue #${input.issueNumber}`);
    issue.labels = issue.labels.filter((label) => label !== input.claimLabel);
    if (!issue.labels.includes(input.readyLabel)) issue.labels.push(input.readyLabel);
  }

  async releaseIssueClaim(input: { repo: string; issueNumber: number; claimLabel: string }): Promise<void> {
    if (this.releaseClaimFailure) throw this.releaseClaimFailure;
    this.releasedClaims.push(input.issueNumber);
    const issue = this.graph.find((candidate) => candidate.number === input.issueNumber);
    if (issue) issue.labels = issue.labels.filter((label) => label !== input.claimLabel);
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

  async observePullRequest(_repo: string, _pullRequest: PullRequestRef): Promise<PullRequestObservation> {
    return {
      status: this.mergeStatus,
      autoMergeEnabled: this.mergeStatus === "open" && this.autoMergeEnabled,
      requiredChecks: this.mergeStatus === "open" ? clone(this.requiredChecks) : [],
    };
  }

  async suspendAutoMerge(_repo: string, pullRequest: PullRequestRef): Promise<void> {
    if (this.suspendFailure) throw this.suspendFailure;
    this.suspended.push(pullRequest.number);
    this.autoMergeEnabled = false;
  }
}

export class FakeGit implements GitPort {
  baseSha = "a".repeat(40);
  baseSyncHeadSha: string | null = null;
  baseSyncFailure: { class: "agent_decision" | "integrity_violation"; reason: string } | null = null;
  baseSyncs: Array<{ expectedHeadSha: string; expectedRemoteHeadSha: string | null; latestBaseSha: string }> = [];
  workerFailure: { class: "integrity_violation" | "stale_task"; reason: string } | null = null;
  reviewerFailure: string | null = null;
  reviewerValidationArgv: string[][] = [];
  reviewerDockerHosts: Array<string | null> = [];
  workerVerifications: Array<{
    reportedHeadSha: string;
    expectedRemoteHeadSha: string | null;
  }> = [];

  async refreshBase(): Promise<string> {
    return this.baseSha;
  }

  async syncBase(input: {
    expectedHeadSha: string;
    expectedRemoteHeadSha: string | null;
    latestBaseSha: string;
  }): Promise<{ ok: true; headSha: string } | { ok: false; class: "agent_decision" | "integrity_violation"; reason: string }> {
    this.baseSyncs.push({
      expectedHeadSha: input.expectedHeadSha,
      expectedRemoteHeadSha: input.expectedRemoteHeadSha,
      latestBaseSha: input.latestBaseSha,
    });
    return this.baseSyncFailure
      ? { ok: false, ...this.baseSyncFailure }
      : { ok: true, headSha: this.baseSyncHeadSha ?? input.expectedHeadSha };
  }

  async verifyWorker(input: { reportedHeadSha: string; expectedRemoteHeadSha: string | null }): Promise<{ ok: true; headSha: string } | { ok: false; class: "integrity_violation" | "stale_task"; reason: string }> {
    this.workerVerifications.push({
      reportedHeadSha: input.reportedHeadSha,
      expectedRemoteHeadSha: input.expectedRemoteHeadSha,
    });
    return this.workerFailure ? { ok: false, ...this.workerFailure } : { ok: true, headSha: input.reportedHeadSha };
  }

  async prepareWorkerResult(input: { rootPath: string }): Promise<{ descriptorPath: string }> {
    return { descriptorPath: join(input.rootPath, "descriptor.json") };
  }

  async prepareReviewer(input: { rootPath: string; validationArgv: string[]; dockerHost: string | null }): Promise<{ reviewPath: string; descriptorPath: string; evidencePath: string }> {
    this.reviewerValidationArgv.push([...input.validationArgv]);
    this.reviewerDockerHosts.push(input.dockerHost);
    return {
      reviewPath: join(input.rootPath, "source"),
      descriptorPath: join(input.rootPath, "descriptor.json"),
      evidencePath: join(input.rootPath, "review-evidence.txt"),
    };
  }

  async verifyReviewer(): Promise<{ ok: true } | { ok: false; class: "integrity_violation"; kind: "worktree_dirty"; reason: string }> {
    return this.reviewerFailure
      ? { ok: false, class: "integrity_violation", kind: "worktree_dirty", reason: this.reviewerFailure }
      : { ok: true };
  }
}

type Outcome = (
  | { lane: "worker"; status: "completed" | "blocked" | "failed"; summary?: string; headSha?: string }
  | { lane: "reviewer"; status: "pass" | "changes" | "blocked" | "failed"; summary?: string; reviewedHeadSha?: string; findings?: Array<{ severity: "critical" | "major" | "minor"; summary: string; evidence: string }> }
) & { agentStatus?: "idle" | "done" | "blocked" | "unknown" };

export class FakeHerdr implements HerdrPort {
  prepared: Array<{ attemptId: string; lane: string; cwd: string; env: Record<string, string>; handle: { agentName: string; paneId: string; tabId: string; workspaceId: string } }> = [];
  started: string[] = [];
  prompts: Array<{ dispatchId: string; skill: "implement" | "code-review"; text: string }> = [];
  closed: string[] = [];
  promptFailureAfterDispatch: Error | null = null;
  waitFailure: Error | null = null;
  settleWithoutResult: { agentStatus: "idle" | "done" | "blocked" | "unknown"; diagnostic: string | null } | null = null;

  constructor(private readonly outcomes: Outcome[]) {}

  async createWorktree(input: { branch: string; path: string }): Promise<{ workspaceId: string; path: string; branch: string }> {
    return { workspaceId: "ws-1", path: input.path, branch: input.branch };
  }

  async createAttemptPane(input: { worktree: { workspaceId: string; path: string }; attempt: { id: string; lane: "worker" | "reviewer" }; cwd?: string; env?: Record<string, string> }): Promise<{ agentName: string; paneId: string; tabId: string; workspaceId: string }> {
    const handle = {
      agentName: `agent-${input.attempt.id}`,
      paneId: `pane-${input.attempt.id}`,
      tabId: `tab-${input.attempt.id}`,
      workspaceId: input.worktree.workspaceId,
    };
    this.prepared.push({ attemptId: input.attempt.id, lane: input.attempt.lane, cwd: input.cwd ?? input.worktree.path, env: input.env ?? {}, handle });
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
    if (this.settleWithoutResult) {
      const settled = this.settleWithoutResult;
      this.settleWithoutResult = null;
      return { ...settled, result: null };
    }
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
      reviewedHeadSha: outcome.reviewedHeadSha
        ?? (outcome.status === "pass" || outcome.status === "changes" ? "b".repeat(40) : null),
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
    const result: { items: EvidenceItem[]; missing: string[] } = {
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
    if (job.ciFailure) {
      const summary = JSON.stringify(job.ciFailure);
      result.items.push({
        ref: "ci-checks",
        source: "github.required-checks",
        summary,
        digest: digest(summary),
        trust: "untrusted",
      });
    }
    return result;
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
