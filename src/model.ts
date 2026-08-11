import { createHash } from "node:crypto";
import { isSafePiRpcDiagnostic, type SafeRuntimeDiagnostic } from "./pi-rpc-diagnostics.js";

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
  /** Missing only on ledgers created before dependency closure was bound to the task. */
  blockedBy?: IssueReference[];
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
  task: TaskSnapshot & { trust: "untrusted-task-data" };
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
  writeback:
    | { tool: "worker_submit"; statuses: WorkerResult["status"][] }
    | { tool: "review_submit"; statuses: ReviewerResult["status"][] };
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

export type EvidenceRequestKind =
  | "issue_context"
  | "git_status"
  | "git_diff"
  | "worktree_progress"
  | "test_output"
  | "attempt_result"
  | "attempt_runtime"
  | "attempt_history"
  | "controller_health"
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
  | "reviewer_preflight_dirty"
  | "infrastructure_exhausted"
  | "integrity_violation"
  | "stale_task"
  | "ci_failure"
  | "ci_rework_exhausted"
  | "analyst_unavailable";

export type RecoveryAction = "retry_fresh_worker" | "retry_fresh_reviewer" | "hold";
export type AutomaticRecoveryRule = "worker_pre_dispatch_infrastructure" | "reviewer_same_head_infrastructure";

export type AutomaticRecoveryCandidate = {
  rule: AutomaticRecoveryRule;
  fingerprint: string;
};

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
  automaticRecovery?: AutomaticRecoveryCandidate;
  runtimeDiagnostic?: SafeRuntimeDiagnostic;
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
  diagnosis?: AnalystDiagnosis;
  createdAt: string;
};

export type AnalystHypothesis = {
  claim: string;
  status: "supported" | "rejected" | "unresolved";
  confidence: "high" | "medium" | "low";
  evidenceRefs: string[];
};

export type AnalystDiagnosis = {
  primaryCause: string;
  confidence: "high" | "medium" | "low";
  contributingFactors: string[];
  preservationConstraints: string[];
  hypotheses: AnalystHypothesis[];
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
      diagnosis?: AnalystDiagnosis;
    };

export type Approval = {
  id: string;
  jobRevision: number;
  incidentId: string;
  analysisId: string;
  action: Exclude<RecoveryAction, "hold">;
  /** Optional because V1 ledgers created before decision resolution have no basis field. */
  basis?: "analyst_advice" | "human_decision" | "policy_rule";
  policyRule?: AutomaticRecoveryRule;
  fingerprint?: string;
  actor: string;
  reason: string;
  createdAt: string;
  consumedAt: string | null;
};

export type AutomaticRecovery = Approval & {
  basis: "policy_rule";
  policyRule: AutomaticRecoveryRule;
  fingerprint: string;
  attemptId: string;
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

export const MAX_CI_REWORKS = 2;
export const MAX_ATTEMPT_RECONCILIATIONS = 1;

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
  pendingHandoff?: TypedHandoff | null;
  /** Read-only compatibility field; new state never writes a free-form brief. */
  pendingBrief?: string | null;
  incident: Incident | null;
  analysis: AnalystAdvice | null;
  approval: Approval | null;
  automaticRecoveries?: AutomaticRecovery[];
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

export function taskFromSelection(repo: string, selected: SelectedTask): TaskSnapshot {
  const value = {
    repo,
    issueNumber: selected.issue.number,
    mapNumber: selected.mapNumber,
    title: selected.issue.title,
    objective: selected.issue.body,
    labels: [...selected.issue.labels].sort(),
    blockedBy: [...selected.issue.blockedBy].sort((a, b) => a.number - b.number || a.state.localeCompare(b.state)),
    issueUpdatedAt: selected.issue.updatedAt,
  };
  const identity = {
    repo: value.repo,
    issueNumber: value.issueNumber,
    mapNumber: value.mapNumber,
    title: value.title,
    objective: value.objective,
    blockedBy: value.blockedBy,
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
  if (job.state === "cancelled" && !job.cancellation) throw new Error("cancelled job requires a cancellation record");
  if (job.pendingBrief?.trim()) throw new Error("legacy pendingBrief requires a quiescent migration");
  if (job.pendingHandoff) {
    assertTypedHandoff(job.pendingHandoff);
    const lane = job.pendingHandoff.target.lane;
    if (
      job.activeAttempt
      || job.state !== `${lane}_ready`
      || job.pendingHandoff.source.jobRevision + 1 !== job.revision
      || job.pendingHandoff.source.taskDigest !== job.task.digest
      || job.pendingHandoff.target.baseSha !== (lane === "worker" ? (job.headSha ?? job.baseSha) : job.baseSha)
      || job.pendingHandoff.target.expectedHeadSha !== (lane === "reviewer" ? job.headSha : null)
      || job.pendingHandoff.target.expectedRemoteHeadSha !== (lane === "worker" ? (job.pullRequest?.headSha ?? null) : null)
    ) throw new Error("pending handoff is not bound to the next ready Attempt");
  }
  if (job.cancellation && (
    !Number.isInteger(job.cancellation.jobRevision)
    || job.cancellation.jobRevision < 0
    || !isBoundedText(job.cancellation.id, 512)
    || !isBoundedText(job.cancellation.incidentId, 512)
    || !isBoundedText(job.cancellation.analysisId, 512)
    || !isBoundedText(job.cancellation.actor, 512)
    || !isBoundedText(job.cancellation.reason, 2_000)
    || !Number.isFinite(Date.parse(job.cancellation.createdAt))
  )) throw new Error("job has an invalid cancellation record");
  const ciReworkCount = job.ciReworkCount ?? 0;
  if (!Number.isInteger(ciReworkCount) || ciReworkCount < 0 || ciReworkCount > MAX_CI_REWORKS) {
    throw new Error("job has an invalid CI rework count");
  }
  if (job.ciFailure) {
    if (
      !job.pullRequest ||
      job.ciFailure.headSha !== job.pullRequest.headSha ||
      !Number.isFinite(Date.parse(job.ciFailure.observedAt)) ||
      job.ciFailure.checks.length === 0 ||
      job.ciFailure.checks.some((check) => check.bucket !== "fail" && check.bucket !== "cancel")
    ) {
      throw new Error("job has invalid CI failure evidence");
    }
  }
  if ((job.incident?.class === "ci_failure" || job.incident?.class === "ci_rework_exhausted") && !job.ciFailure) {
    throw new Error("CI incident requires failure evidence");
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
  if (job.incident?.automaticRecovery && (
    !["worker_pre_dispatch_infrastructure", "reviewer_same_head_infrastructure"].includes(job.incident.automaticRecovery.rule)
    || !/^[0-9a-f]{64}$/i.test(job.incident.automaticRecovery.fingerprint)
  )) throw new Error("incident has an invalid automatic recovery candidate");
  if (job.incident?.runtimeDiagnostic !== undefined && !isSafePiRpcDiagnostic(job.incident.runtimeDiagnostic)) {
    throw new Error("incident has an invalid runtime diagnostic");
  }
  if (job.analysis && !isRecoveryAction(job.analysis.action)) {
    throw new Error("analysis has an invalid recovery action");
  }
  if (job.analysis?.diagnosis && !isAnalystDiagnosis(job.analysis.diagnosis)) {
    throw new Error("analysis has an invalid structured diagnosis");
  }
  if (job.approval && !isRetryAction(job.approval.action)) {
    throw new Error("approval has an invalid recovery action");
  }
  if (
    job.approval?.basis !== undefined &&
    job.approval.basis !== "analyst_advice" &&
    job.approval.basis !== "human_decision" &&
    job.approval.basis !== "policy_rule"
  ) {
    throw new Error("approval has an invalid basis");
  }
  if (
    job.approval?.basis === "human_decision" &&
    (!isBoundedText(job.approval.actor, 512) ||
      !isBoundedText(job.approval.reason, 2_000) ||
      !Number.isFinite(Date.parse(job.approval.createdAt)))
  ) {
    throw new Error("human decision approval is not auditable");
  }
  const automaticRecoveries = job.automaticRecoveries ?? [];
  if (
    automaticRecoveries.length > 32
    || new Set(automaticRecoveries.map((entry) => entry.id)).size !== automaticRecoveries.length
    || new Set(automaticRecoveries.map((entry) => entry.fingerprint)).size !== automaticRecoveries.length
    || automaticRecoveries.some((entry) => (
      entry.basis !== "policy_rule"
      || !isRetryAction(entry.action)
      || !["worker_pre_dispatch_infrastructure", "reviewer_same_head_infrastructure"].includes(entry.policyRule)
      || (entry.policyRule === "worker_pre_dispatch_infrastructure") !== (entry.action === "retry_fresh_worker")
      || !/^[0-9a-f]{64}$/i.test(entry.fingerprint)
      || !isBoundedText(entry.id, 512)
      || !isBoundedText(entry.incidentId, 512)
      || !isBoundedText(entry.analysisId, 512)
      || !isBoundedText(entry.attemptId, 512)
      || !isBoundedText(entry.actor, 512)
      || !isBoundedText(entry.reason, 2_000)
      || !Number.isInteger(entry.jobRevision)
      || entry.jobRevision < 0
      || !Number.isFinite(Date.parse(entry.createdAt))
      || (entry.consumedAt !== null && !Number.isFinite(Date.parse(entry.consumedAt)))
    ))
  ) throw new Error("job has invalid automatic recovery history");
  if (job.approval?.basis === "policy_rule" && !automaticRecoveries.some((entry) => (
    entry.id === job.approval!.id
    && entry.policyRule === job.approval!.policyRule
    && entry.fingerprint === job.approval!.fingerprint
  ))) throw new Error("policy approval has no automatic recovery history");
  if (
    job.reassessments !== undefined &&
    (!Array.isArray(job.reassessments) || job.reassessments.some((entry) => (
      !entry ||
      !Number.isInteger(entry.jobRevision) ||
      entry.jobRevision < 0 ||
      !isBoundedText(entry.id, 512) ||
      !isBoundedText(entry.incidentId, 512) ||
      !isBoundedText(entry.analysisId, 512) ||
      !isBoundedText(entry.replacementIncidentId, 512) ||
      !isBoundedText(entry.actor, 512) ||
      !isBoundedText(entry.reason, 2_000) ||
      !Number.isFinite(Date.parse(entry.createdAt))
    )))
  ) {
    throw new Error("job has an invalid reassessment record");
  }
  if ((job.state === "worker_running" || job.state === "reviewer_running") && !job.activeAttempt) {
    throw new Error(`${job.state} requires an active attempt`);
  }
  if (
    job.activeAttempt &&
    job.activeAttempt.lane === "worker" &&
    !["worker_running", "blocked", "recovery_approved", "cancelled"].includes(job.state)
  ) {
    throw new Error("worker attempt is bound to an invalid state");
  }
  if (
    job.activeAttempt &&
    job.activeAttempt.lane === "reviewer" &&
    !["reviewer_running", "blocked", "recovery_approved", "cancelled"].includes(job.state)
  ) {
    throw new Error("reviewer attempt is bound to an invalid state");
  }
  if (
    job.activeAttempt?.expectedRemoteHeadSha !== undefined &&
    job.activeAttempt.expectedRemoteHeadSha !== null &&
    !/^[0-9a-f]{40}$/i.test(job.activeAttempt.expectedRemoteHeadSha)
  ) {
    throw new Error("attempt has an invalid remote HEAD anchor");
  }
  if (job.activeAttempt?.planDigest !== undefined && !/^[0-9a-f]{64}$/i.test(job.activeAttempt.planDigest)) {
    throw new Error("attempt has an invalid plan digest");
  }
  if (job.activeAttempt?.executionSnapshot !== undefined && job.activeAttempt.planDigest === undefined) {
    throw new Error("attempt execution snapshot requires a plan digest");
  }
  const handoff = job.activeAttempt?.contextEnvelope?.handoff?.value;
  if (handoff && job.activeAttempt) {
    assertTypedHandoff(handoff);
    if (
      handoff.source.taskDigest !== job.task.digest
      || handoff.target.lane !== job.activeAttempt.lane
      || handoff.target.baseSha !== job.activeAttempt.baseSha
      || handoff.target.expectedHeadSha !== job.activeAttempt.expectedHeadSha
      || handoff.target.expectedRemoteHeadSha !== (job.activeAttempt.expectedRemoteHeadSha ?? null)
    ) throw new Error("attempt handoff targets different work");
  }
  const reconciliationAttempts = job.activeAttempt?.reconciliationAttempts ?? 0;
  if (
    !Number.isInteger(reconciliationAttempts)
    || reconciliationAttempts < 0
    || reconciliationAttempts > MAX_ATTEMPT_RECONCILIATIONS
  ) {
    throw new Error("attempt has an invalid reconciliation count");
  }
  if ((job.state === "publish_ready" || job.state === "awaiting_merge" || job.state === "done") && !job.headSha) {
    throw new Error(`${job.state} requires headSha`);
  }
  if (job.analyst && job.analyst.taskDigest !== job.task.digest) {
    throw new Error("analyst is bound to a different task digest");
  }
}

function isAnalystDiagnosis(value: AnalystDiagnosis): boolean {
  return isBoundedText(value.primaryCause, 2_000)
    && ["high", "medium", "low"].includes(value.confidence)
    && Array.isArray(value.contributingFactors)
    && value.contributingFactors.length <= 4
    && value.contributingFactors.every((entry) => isBoundedText(entry, 512))
    && Array.isArray(value.preservationConstraints)
    && value.preservationConstraints.length <= 4
    && value.preservationConstraints.every((entry) => isBoundedText(entry, 512))
    && Array.isArray(value.hypotheses)
    && value.hypotheses.length >= 1
    && value.hypotheses.length <= 5
    && value.hypotheses.every((hypothesis) => (
      isBoundedText(hypothesis.claim, 512)
      && ["supported", "rejected", "unresolved"].includes(hypothesis.status)
      && ["high", "medium", "low"].includes(hypothesis.confidence)
      && Array.isArray(hypothesis.evidenceRefs)
      && hypothesis.evidenceRefs.length <= 8
      && new Set(hypothesis.evidenceRefs).size === hypothesis.evidenceRefs.length
      && hypothesis.evidenceRefs.every((entry) => isBoundedText(entry, 128))
    ));
}

export function assertTypedHandoff(handoff: TypedHandoff): void {
  if (
    !handoff
    || typeof handoff !== "object"
    || !handoff.source
    || typeof handoff.source !== "object"
    || !handoff.target
    || typeof handoff.target !== "object"
    || !Array.isArray(handoff.obligations)
    || !Array.isArray(handoff.evidenceRefs)
    || !Array.isArray(handoff.unknowns)
  ) throw new Error("job has an invalid typed handoff");
  const { id, ...body } = handoff;
  const nullableText = (value: unknown, max = 512): boolean => value === null || isBoundedText(value, max);
  const nullableDigest = (value: unknown): boolean => value === null || (typeof value === "string" && /^[0-9a-f]{64}$/i.test(value));
  const nullableSha = (value: unknown): boolean => value === null || (typeof value === "string" && /^[0-9a-f]{40}$/i.test(value));
  if (
    handoff.version !== 1
    || id !== `handoff-${digest(body).slice(0, 32)}`
    || !["review_changes", "approved_recovery", "ci_rework"].includes(handoff.kind)
    || !Number.isInteger(handoff.source.jobRevision)
    || handoff.source.jobRevision < 0
    || !/^[0-9a-f]{64}$/i.test(handoff.source.taskDigest)
    || !nullableText(handoff.source.attemptId)
    || !nullableDigest(handoff.source.resultDigest)
    || !nullableText(handoff.source.incidentId)
    || !nullableDigest(handoff.source.evidenceDigest)
    || !nullableText(handoff.source.analysisId)
    || !nullableText(handoff.source.approvalId)
    || !nullableSha(handoff.source.headSha)
    || (handoff.target.lane !== "worker" && handoff.target.lane !== "reviewer")
    || !/^[0-9a-f]{40}$/i.test(handoff.target.baseSha)
    || !nullableSha(handoff.target.expectedHeadSha)
    || !nullableSha(handoff.target.expectedRemoteHeadSha)
    || !isBoundedText(handoff.summary, 10_000)
    || handoff.obligations.length > 100
    || handoff.obligations.some((item) => (
      !item
      || typeof item !== "object"
      || (item.severity !== null && !["critical", "major", "minor"].includes(item.severity))
      || !isBoundedText(item.summary, 10_000)
      || !nullableText(item.evidence, 10_000)
    ))
    || handoff.evidenceRefs.length > 100
    || handoff.evidenceRefs.some((entry) => !isBoundedText(entry, 2_000))
    || handoff.unknowns.length > 100
    || handoff.unknowns.some((entry) => !isBoundedText(entry, 2_000))
    || !Number.isFinite(Date.parse(handoff.createdAt))
  ) throw new Error("job has an invalid typed handoff");
}

export function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\u0000");
}
