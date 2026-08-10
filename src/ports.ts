import type {
  AgentHandle,
  AgentStatus,
  AnalystSession,
  AnalystTurn,
  Attempt,
  AttemptResult,
  ExecutionContext,
  EvidenceItem,
  EvidencePack,
  EvidenceRequest,
  ExecutionResource,
  HarnessState,
  IssueSnapshot,
  Job,
  PullRequestObservation,
  PullRequestRef,
  SelectedTask,
  TaskSnapshot,
  WorktreeHandle,
} from "./model.js";

export type HarnessConfig = {
  repo: string;
  localPath: string;
  stateDir: string;
  baseRef: string;
  autoMerge?: boolean;
  readyLabel: string;
  claimLabel: string;
  worktreeRoot: string;
  maxReviewRounds: number;
  maxAnalystTurns: number;
  /** Fixed argv executed by the Harness-owned Reviewer validation tool without a shell. */
  reviewerValidationArgv: string[];
  /** Native Pi arguments only; Herdr selects `pi` and Controller validates the role contract. */
  workerArgv: string[];
  reviewerArgv: string[];
  workerRuntime?: "herdr-pi-cli" | "pi-rpc";
  reviewerRuntime?: "herdr-pi-cli" | "pi-rpc";
  preflight?: {
    /** Command used for bounded live Provider probes. Defaults to `pi`. */
    piBin?: string;
    /** Require a local Docker daemon plus Compose V2 and bind its Unix socket into attempts. */
    dockerRequired?: boolean;
  };
};

export interface RuntimePreflightPort {
  inspectPi(input: { cwd: string; piBin: string }): Promise<{ executable: string; version: string }>;
  assertNoAmbientSystemPrompt(input: { cwd: string }): Promise<{ agentDir: string }>;
  probeProvider(input: {
    lane: Attempt["lane"];
    cwd: string;
    roleArgv: string[];
    piBin: string;
    agentDir?: string;
    credentialAgentDir?: string;
    credentialMode?: "canonical-oauth" | "canonical-model-config";
    modelConfig?: ExecutionResource;
    rpcHost?: ExecutionResource;
  }): Promise<void>;
  probeDocker(input: { cwd: string }): Promise<{ host: string }>;
}

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
  requeueIssue(input: {
    repo: string;
    issueNumber: number;
    claimLabel: string;
    readyLabel: string;
  }): Promise<void>;
  releaseIssueClaim(input: {
    repo: string;
    issueNumber: number;
    claimLabel: string;
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
  observePullRequest(repo: string, pullRequest: PullRequestRef): Promise<PullRequestObservation>;
  suspendAutoMerge(repo: string, pullRequest: PullRequestRef): Promise<void>;
}

export type WorkerVerification =
  | { ok: true; headSha: string }
  | { ok: false; class: "integrity_violation" | "stale_task"; reason: string };

export type ReviewerVerification =
  | { ok: true }
  | { ok: false; class: "integrity_violation"; kind: "head_mismatch" | "worktree_dirty"; reason: string };

export type BaseSyncVerification =
  | { ok: true; headSha: string }
  | { ok: false; class: "agent_decision" | "integrity_violation"; reason: string };

export interface GitPort {
  refreshBase(localPath: string, baseRef: string): Promise<string>;
  syncBase(input: {
    worktree: WorktreeHandle;
    branch: string;
    baseRef: string;
    expectedHeadSha: string;
    expectedRemoteHeadSha: string | null;
    latestBaseSha: string;
  }): Promise<BaseSyncVerification>;
  verifyWorker(input: {
    worktree: WorktreeHandle;
    branch: string;
    baseSha: string;
    reportedHeadSha: string;
    expectedRemoteHeadSha: string | null;
    allowedResultPaths: string[];
  }): Promise<WorkerVerification>;
  prepareWorkerResult(input: {
    worktree: WorktreeHandle;
    rootPath: string;
    resultPath: string;
    jobId: string;
    attemptId: string;
  }): Promise<{ descriptorPath: string }>;
  prepareTrustedContext(input: {
    localPath: string;
    rootPath: string;
    trustAnchorSha: string;
    jobId: string;
    attemptId: string;
    lane: Attempt["lane"];
    agentDir: string;
  }): Promise<ExecutionContext>;
  verifyTrustedContext(context: ExecutionContext): Promise<void>;
  prepareReviewer(input: {
    worktree: WorktreeHandle;
    rootPath: string;
    resultPath: string;
    jobId: string;
    attemptId: string;
    baseSha: string;
    expectedHeadSha: string;
    validationArgv: string[];
    dockerHost: string | null;
    reviewAxisAgent: ExecutionResource;
    piExecutable: string;
    piRuntimeVersion: string;
    piAgentDir: string;
  }): Promise<{ reviewPath: string; descriptorPath: string; evidencePath: string }>;
  verifyReviewer(input: {
    worktree: WorktreeHandle;
    expectedHeadSha: string;
    reportedHeadSha: string | null;
    allowedResultPaths: string[];
  }): Promise<ReviewerVerification>;
}

export interface AttemptRuntimePort {
  startAgent(input: { handle: AgentHandle; attempt: Attempt; cwd: string; argv: string[] }): Promise<void>;
  prompt(input: {
    handle: AgentHandle;
    attempt: Attempt;
    dispatchId: string;
    skill: "implement" | "code-review";
    text: string;
  }): Promise<void>;
  wait(input: {
    handle: AgentHandle;
    attempt: Attempt;
    resultPath: string;
    expectedJobId: string;
    expectedAttemptId: string;
    expectedLane: Attempt["lane"];
  }): Promise<{ agentStatus: AgentStatus; result: AttemptResult | null; diagnostic: string | null }>;
  terminate?(input: {
    handle: AgentHandle;
    attempt: Attempt;
    reason: "completed" | "recovery" | "cancelled";
  }): Promise<void>;
}

export interface HerdrPort extends AttemptRuntimePort {
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
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<AgentHandle>;
  runInPane(input: { handle: AgentHandle; command: string; argv: string[] }): Promise<void>;
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
