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
export type EvidenceRequestKind = "issue_context" | "git_status" | "git_diff" | "test_output" | "attempt_result" | "file_excerpt";
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
export type BlockClass = "agent_decision" | "agent_blocked" | "review_uncertain" | "infrastructure_exhausted" | "integrity_violation" | "stale_task" | "analyst_unavailable";
export type RecoveryAction = "retry_fresh_worker" | "hold";
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
export type AnalystTurn = {
    kind: "need_evidence";
    requests: EvidenceRequest[];
} | {
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
    action: "retry_fresh_worker";
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
export type JobState = "claimed" | "worker_ready" | "worker_running" | "reviewer_ready" | "reviewer_running" | "publish_ready" | "awaiting_merge" | "blocked" | "recovery_approved" | "done" | "cancelled";
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
export declare function taskFromSelection(repo: string, selected: SelectedTask): TaskSnapshot;
export declare function digest(value: unknown): string;
export declare function stableStringify(value: unknown): string;
export declare function evolveJob(job: Job, now: string, patch: Partial<Omit<Job, "id" | "revision" | "createdAt">>): Job;
export declare function assertJobInvariant(job: Job): void;
