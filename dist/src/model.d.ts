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
export type AttemptRuntimeAdapter = "herdr-pi-cli" | "pi-rpc";
export type ExecutionResource = {
    kind: "skill" | "extension" | "agent" | "runtime" | "model-config";
    path: string;
    digest: string;
};
export type ContextEntry = {
    source: "trusted-repo-policy";
    sourceSha: string;
    path: string;
    gitMode: "100644" | "100755";
    digest: string;
};
export type ExecutionContext = {
    version: 1;
    mode: "explicit-v1";
    lane: Lane;
    trustAnchorSha: string;
    entries: ContextEntry[];
    bundlePath: string;
    bundleDigest: string;
    manifestPath: string;
    manifestDigest: string;
    agentDir: string;
};
export type ExecutionSnapshot = {
    version: 1;
    adapter: AttemptRuntimeAdapter;
    executable: string;
    runtimeVersion: string;
    argv: string[];
    provider: string | null;
    model: string | null;
    thinking: string;
    tools: string[];
    sessionMode: "ephemeral" | "fresh-persistent";
    retryMode: "runtime-default" | "disabled";
    compactionMode: "runtime-default" | "disabled";
    credentialMode: "runtime-default" | "canonical-oauth" | "canonical-model-config";
    dockerHost: string | null;
    resources: ExecutionResource[];
    /** Missing only on snapshots prepared before explicit context closure. */
    context?: ExecutionContext;
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
export type HandoffObligation = {
    severity: ReviewerFinding["severity"] | null;
    summary: string;
    evidence: string | null;
};
export type TypedHandoff = {
    version: 1;
    id: string;
    kind: "review_changes" | "approved_recovery" | "ci_rework";
    source: {
        jobRevision: number;
        taskDigest: string;
        attemptId: string | null;
        resultDigest: string | null;
        incidentId: string | null;
        evidenceDigest: string | null;
        analysisId: string | null;
        approvalId: string | null;
        headSha: string | null;
    };
    target: {
        lane: Lane;
        baseSha: string;
        expectedHeadSha: string | null;
        expectedRemoteHeadSha: string | null;
    };
    summary: string;
    obligations: HandoffObligation[];
    evidenceRefs: string[];
    unknowns: string[];
    createdAt: string;
};
export type AttemptContextEnvelope = {
    version: 1;
    identity: {
        jobId: string;
        sourceJobRevision: number;
        attemptId: string;
        lane: Lane;
        round: number;
        taskDigest: string;
        preparedAt: string;
    };
    authority: {
        roleResources: Array<{
            kind: Extract<ExecutionResource["kind"], "skill" | "extension" | "agent">;
            digest: string;
        }>;
        repositoryPolicy: {
            trustAnchorSha: string;
            entries: ContextEntry[];
            bundleDigest: string;
            manifestDigest: string;
        };
    };
    task: TaskSnapshot & {
        trust: "untrusted-task-data";
    };
    target: {
        branch: string;
        baseSha: string;
        expectedHeadSha: string | null;
        expectedRemoteHeadSha: string | null;
    };
    handoff: {
        trust: "untrusted-task-data";
        digest: string;
        value: TypedHandoff;
    } | null;
    evidence: {
        trust: "untrusted-evidence";
        refs: string[];
        reviewEvidencePath: string | null;
        validationArgv: string[] | null;
    };
    runtime: {
        snapshotDigest: string;
        adapter: AttemptRuntimeAdapter;
        runtimeVersion: string;
        provider: string | null;
        model: string | null;
        thinking: string;
        tools: string[];
        sessionMode: ExecutionSnapshot["sessionMode"];
        retryMode: ExecutionSnapshot["retryMode"];
        compactionMode: ExecutionSnapshot["compactionMode"];
        credentialMode: ExecutionSnapshot["credentialMode"];
    };
    writeback: {
        tool: "worker_submit";
        statuses: WorkerResult["status"][];
    } | {
        tool: "review_submit";
        statuses: ReviewerResult["status"][];
    };
};
export type Attempt = {
    id: string;
    lane: Lane;
    phase: AttemptPhase;
    round: number;
    baseSha: string;
    expectedHeadSha: string | null;
    /** Null for the initial Worker; exact published SHA for a post-PR rework Worker. */
    expectedRemoteHeadSha?: string | null;
    resultPath: string;
    reviewerValidationArgv?: string[];
    promptDigest: string;
    /** Optional only for ledgers written before execution plans were introduced. */
    executionSnapshot?: ExecutionSnapshot;
    /** Digest of the immutable Attempt identity and execution snapshot. */
    planDigest?: string;
    /** Missing only on Attempts prepared before the role-scoped context projection. */
    contextEnvelope?: AttemptContextEnvelope;
    contextEnvelopeDigest?: string;
    handle: AgentHandle | null;
    result: AttemptResult | null;
    /** Optional for V1 ledgers written before bounded same-attempt reconciliation. */
    reconciliationAttempts?: number;
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
export type BlockClass = "agent_decision" | "agent_blocked" | "review_uncertain" | "reviewer_preflight_dirty" | "infrastructure_exhausted" | "integrity_violation" | "stale_task" | "ci_failure" | "ci_rework_exhausted" | "analyst_unavailable";
export type RecoveryAction = "retry_fresh_worker" | "retry_fresh_reviewer" | "hold";
export declare function isRecoveryAction(value: unknown): value is RecoveryAction;
export declare function isRetryAction(value: unknown): value is Exclude<RecoveryAction, "hold">;
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
    action: Exclude<RecoveryAction, "hold">;
    /** Optional because V1 ledgers created before decision resolution have no basis field. */
    basis?: "analyst_advice" | "human_decision";
    actor: string;
    reason: string;
    createdAt: string;
    consumedAt: string | null;
};
export type Reassessment = {
    id: string;
    jobRevision: number;
    incidentId: string;
    analysisId: string;
    replacementIncidentId: string;
    actor: string;
    reason: string;
    createdAt: string;
};
export type Cancellation = {
    id: string;
    jobRevision: number;
    incidentId: string;
    analysisId: string;
    actor: string;
    reason: string;
    createdAt: string;
};
export type PullRequestRef = {
    number: number;
    url: string;
    headSha: string;
};
export type PullRequestCheck = {
    name: string;
    state: string;
    bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
    workflow: string;
    link: string;
    completedAt: string | null;
    diagnostic: string | null;
};
export type PullRequestObservation = {
    status: "open" | "merged" | "closed_unmerged";
    autoMergeEnabled: boolean;
    requiredChecks: PullRequestCheck[];
};
export type CiFailure = {
    headSha: string;
    observedAt: string;
    checks: PullRequestCheck[];
};
export declare const MAX_CI_REWORKS = 2;
export declare const MAX_ATTEMPT_RECONCILIATIONS = 1;
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
    pendingHandoff?: TypedHandoff | null;
    /** Read-only compatibility field; new state never writes a free-form brief. */
    pendingBrief?: string | null;
    incident: Incident | null;
    analysis: AnalystAdvice | null;
    approval: Approval | null;
    cancellation?: Cancellation | null;
    reassessments?: Reassessment[];
    pullRequest: PullRequestRef | null;
    /** Optional for backward compatibility with V1 ledgers created before CI feedback. */
    ciFailure?: CiFailure | null;
    /** V1 permits two separately human-approved post-PR CI rework cycles. */
    ciReworkCount?: number;
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
    cancellation?: Cancellation | null;
    reassessments?: Reassessment[];
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
export declare function assertTypedHandoff(handoff: TypedHandoff): void;
export declare function isBoundedText(value: unknown, max: number): value is string;
