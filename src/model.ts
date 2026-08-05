import { createHash } from "node:crypto";

export type IssueState = "OPEN" | "CLOSED";

export type IssueReference = {
  number: number;
  state: IssueState;
};

export type IssueSnapshot = {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  assignees: string[];
  blockedBy: IssueReference[];
  parentNumber: number | null;
  subIssues: IssueReference[];
  updatedAt: string;
};

export type SelectedTask = {
  issue: IssueSnapshot;
  mapNumber: number | null;
  selectionKey: number;
};

export type TaskSnapshot = {
  repo: string;
  issueNumber: number;
  mapNumber: number | null;
  title: string;
  objective: string;
  labels: string[];
  issueUpdatedAt: string;
  digest: string;
};

export type Lane = "worker" | "reviewer";
export type AttemptPhase = "prepared" | "pane_ready" | "agent_ready" | "running" | "settled";
export type AgentStatus = "idle" | "done" | "blocked" | "unknown";

export type AgentHandle = {
  agentName: string;
  paneId: string;
  tabId: string;
  workspaceId: string;
};

export type WorkerResult = {
  version: 1;
  jobId: string;
  attemptId: string;
  lane: "worker";
  status: "completed" | "blocked" | "failed";
  summary: string;
  headSha: string | null;
  failedCommands: string[];
};

export type ReviewerFinding = {
  severity: "critical" | "major" | "minor";
  summary: string;
  evidence: string;
};

export type ReviewerResult = {
  version: 1;
  jobId: string;
  attemptId: string;
  lane: "reviewer";
  status: "pass" | "changes" | "blocked" | "failed";
  summary: string;
  reviewedHeadSha: string | null;
  findings: ReviewerFinding[];
};

export type AttemptResult = WorkerResult | ReviewerResult;

export type Attempt = {
  id: string;
  lane: Lane;
  phase: AttemptPhase;
  round: number;
  baseSha: string;
  expectedHeadSha: string | null;
  resultPath: string;
  promptDigest: string;
  handle: AgentHandle | null;
  result: AttemptResult | null;
  startedAt: string;
  completedAt: string | null;
};

export type WorktreeHandle = {
  workspaceId: string;
  path: string;
  branch: string;
};

export type AnalystSession = {
  id: string;
  agentName: string;
  startedAt: string;
  taskDigest: string;
};

export type EvidenceRequestKind =
  | "issue_context"
  | "git_status"
  | "git_diff"
  | "test_output"
  | "attempt_result"
  | "file_excerpt";

export type EvidenceRequest = {
  kind: EvidenceRequestKind;
  path: string | null;
  reason: string;
};

export type EvidenceItem = {
  ref: string;
  source: string;
  summary: string;
  digest: string;
  trust: "untrusted";
};

export type EvidencePack = {
  incidentId: string;
  jobId: string;
  jobRevision: number;
  taskDigest: string;
  digest: string;
  items: EvidenceItem[];
  missing: string[];
};

export type BlockClass =
  | "agent_decision"
  | "agent_blocked"
  | "review_uncertain"
  | "infrastructure_exhausted"
  | "integrity_violation"
  | "stale_task"
  | "analyst_unavailable";

export type RecoveryAction = "retry_fresh_worker" | "retry_fresh_reviewer" | "hold";

export function isRecoveryAction(value: unknown): value is RecoveryAction {
  return value === "retry_fresh_worker" || value === "retry_fresh_reviewer" || value === "hold";
}

export function isRetryAction(value: unknown): value is Exclude<RecoveryAction, "hold"> {
  return value === "retry_fresh_worker" || value === "retry_fresh_reviewer";
}

export type Incident = {
  id: string;
  class: BlockClass;
  lane: Lane | "controller";
  attemptId: string | null;
  summary: string;
  evidenceDigest: string;
  allowedActions: RecoveryAction[];
  createdAt: string;
};

export type AnalystAdvice = {
  id: string;
  incidentId: string;
  evidenceDigest: string;
  action: RecoveryAction;
  summary: string;
  resolutionBrief: string;
  evidenceRefs: string[];
  unknowns: string[];
  createdAt: string;
};

export type AnalystTurn =
  | { kind: "need_evidence"; requests: EvidenceRequest[] }
  | {
      kind: "advice";
      action: RecoveryAction;
      summary: string;
      resolutionBrief: string;
      evidenceRefs: string[];
      unknowns: string[];
    };

export type Approval = {
  id: string;
  jobRevision: number;
  incidentId: string;
  analysisId: string;
  action: Exclude<RecoveryAction, "hold">;
  actor: string;
  reason: string;
  createdAt: string;
  consumedAt: string | null;
};

export type PullRequestRef = {
  number: number;
  url: string;
  headSha: string;
};

export type JobState =
  | "claimed"
  | "worker_ready"
  | "worker_running"
  | "reviewer_ready"
  | "reviewer_running"
  | "publish_ready"
  | "awaiting_merge"
  | "blocked"
  | "recovery_approved"
  | "done"
  | "cancelled";

export type Job = {
  id: string;
  revision: number;
  state: JobState;
  task: TaskSnapshot;
  baseSha: string;
  claimConfirmed: boolean;
  headSha: string | null;
  branch: string;
  worktree: WorktreeHandle | null;
  analyst: AnalystSession | null;
  activeAttempt: Attempt | null;
  attempts: Attempt[];
  reviewRound: number;
  maxReviewRounds: number;
  pendingBrief: string | null;
  incident: Incident | null;
  analysis: AnalystAdvice | null;
  approval: Approval | null;
  pullRequest: PullRequestRef | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TerminalJob = {
  id: string;
  repo: string;
  issueNumber: number;
  state: "done" | "cancelled";
  finishedAt: string;
};

export type HarnessState = {
  version: 1;
  activeJob: Job | null;
  terminalJobs: TerminalJob[];
};

export function taskFromSelection(repo: string, selected: SelectedTask): TaskSnapshot {
  const value = {
    repo,
    issueNumber: selected.issue.number,
    mapNumber: selected.mapNumber,
    title: selected.issue.title,
    objective: selected.issue.body,
    labels: [...selected.issue.labels].sort(),
    issueUpdatedAt: selected.issue.updatedAt,
  };
  const identity = {
    repo: value.repo,
    issueNumber: value.issueNumber,
    mapNumber: value.mapNumber,
    title: value.title,
    objective: value.objective,
    issueUpdatedAt: value.issueUpdatedAt,
  };
  return { ...value, digest: digest(identity) };
}

export function digest(value: unknown): string {
  const hash = createHash("sha256");
  hash.update(stableStringify(value));
  return hash.digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

export function evolveJob(job: Job, now: string, patch: Partial<Omit<Job, "id" | "revision" | "createdAt">>): Job {
  return {
    ...job,
    ...patch,
    revision: job.revision + 1,
    updatedAt: now,
  };
}

export function assertJobInvariant(job: Job): void {
  if (!job.id.trim()) throw new Error("job id is empty");
  if (job.revision < 0 || !Number.isInteger(job.revision)) throw new Error("job revision is invalid");
  if (job.state === "blocked" && !job.incident) throw new Error("blocked job requires an incident");
  if (job.state === "recovery_approved" && !job.approval) {
    throw new Error("recovery_approved job requires an approval");
  }
  if (
    job.incident &&
    (!Array.isArray(job.incident.allowedActions) ||
      job.incident.allowedActions.length === 0 ||
      job.incident.allowedActions.some((action) => !isRecoveryAction(action)) ||
      new Set(job.incident.allowedActions).size !== job.incident.allowedActions.length)
  ) {
    throw new Error("incident has an invalid recovery action");
  }
  if (job.analysis && !isRecoveryAction(job.analysis.action)) {
    throw new Error("analysis has an invalid recovery action");
  }
  if (job.approval && !isRetryAction(job.approval.action)) {
    throw new Error("approval has an invalid recovery action");
  }
  if ((job.state === "worker_running" || job.state === "reviewer_running") && !job.activeAttempt) {
    throw new Error(`${job.state} requires an active attempt`);
  }
  if (
    job.activeAttempt &&
    job.activeAttempt.lane === "worker" &&
    !["worker_running", "blocked", "recovery_approved"].includes(job.state)
  ) {
    throw new Error("worker attempt is bound to an invalid state");
  }
  if (
    job.activeAttempt &&
    job.activeAttempt.lane === "reviewer" &&
    !["reviewer_running", "blocked", "recovery_approved"].includes(job.state)
  ) {
    throw new Error("reviewer attempt is bound to an invalid state");
  }
  if ((job.state === "publish_ready" || job.state === "awaiting_merge" || job.state === "done") && !job.headSha) {
    throw new Error(`${job.state} requires headSha`);
  }
  if (job.analyst && job.analyst.taskDigest !== job.task.digest) {
    throw new Error("analyst is bound to a different task digest");
  }
}
