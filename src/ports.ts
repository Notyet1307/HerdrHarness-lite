import type {
  AgentHandle,
  AgentStatus,
  AnalystSession,
  AnalystTurn,
  Attempt,
  AttemptResult,
  EvidenceItem,
  EvidencePack,
  EvidenceRequest,
  HarnessState,
  IssueSnapshot,
  Job,
  PullRequestRef,
  SelectedTask,
  TaskSnapshot,
  WorktreeHandle,
} from "./model.js";

export type HarnessConfig = {
  repo: string;
  localPath: string;
  baseRef: string;
  readyLabel: string;
  claimLabel: string;
  worktreeRoot: string;
  maxReviewRounds: number;
  maxAnalystTurns: number;
  /** Native Pi arguments only; Herdr selects `pi` and Controller validates the role contract. */
  workerArgv: string[];
  reviewerArgv: string[];
};

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(prefix: string): string;
}

export interface StateStore {
  load(): Promise<HarnessState>;
  save(next: HarnessState, expectedActiveRevision: number | null): Promise<void>;
}

export interface GitHubPort {
  listIssueGraph(repo: string, readyLabel: string): Promise<IssueSnapshot[]>;
  getIssue(repo: string, issueNumber: number): Promise<IssueSnapshot>;
  claimIssue(input: {
    repo: string;
    task: SelectedTask;
    jobId: string;
    claimLabel: string;
    readyLabel: string;
  }): Promise<void>;
  publish(input: {
    repo: string;
    issueNumber: number;
    branch: string;
    baseRef: string;
    headSha: string;
    title: string;
    worktreePath: string;
  }): Promise<PullRequestRef>;
  observePullRequest(repo: string, pullRequest: PullRequestRef): Promise<"open" | "merged" | "closed_unmerged">;
}

export type WorkerVerification =
  | { ok: true; headSha: string }
  | { ok: false; class: "integrity_violation" | "stale_task"; reason: string };

export type ReviewerVerification =
  | { ok: true }
  | { ok: false; class: "integrity_violation"; reason: string };

export interface GitPort {
  refreshBase(localPath: string, baseRef: string): Promise<string>;
  verifyWorker(input: {
    worktree: WorktreeHandle;
    branch: string;
    baseSha: string;
    reportedHeadSha: string;
  }): Promise<WorkerVerification>;
  verifyReviewer(input: {
    worktree: WorktreeHandle;
    expectedHeadSha: string;
    reportedHeadSha: string | null;
    allowedResultPaths: string[];
  }): Promise<ReviewerVerification>;
}

export interface HerdrPort {
  createWorktree(input: {
    sourcePath: string;
    branch: string;
    baseRef: string;
    path: string;
    label: string;
  }): Promise<WorktreeHandle>;
  createAttemptPane(input: {
    worktree: WorktreeHandle;
    attempt: Attempt;
  }): Promise<AgentHandle>;
  startAgent(input: { handle: AgentHandle; argv: string[] }): Promise<void>;
  prompt(input: {
    handle: AgentHandle;
    dispatchId: string;
    skill: "implement" | "code-review";
    text: string;
  }): Promise<void>;
  wait(input: {
    handle: AgentHandle;
    resultPath: string;
    expectedJobId: string;
    expectedAttemptId: string;
    expectedLane: Attempt["lane"];
  }): Promise<{ agentStatus: AgentStatus; result: AttemptResult | null; diagnostic: string | null }>;
  close(handle: AgentHandle): Promise<void>;
}

export interface AnalystPort {
  start(input: { jobId: string; task: TaskSnapshot }): Promise<AnalystSession>;
  turn(input: {
    session: AnalystSession;
    job: Job;
    evidence: EvidencePack;
    turn: number;
  }): Promise<AnalystTurn>;
  close(input: { jobId: string; taskDigest: string; session: AnalystSession | null }): Promise<void>;
}

export interface EvidencePort {
  initial(job: Job): Promise<{ items: EvidenceItem[]; missing: string[] }>;
  collect(job: Job, requests: EvidenceRequest[]): Promise<EvidenceItem[]>;
}
