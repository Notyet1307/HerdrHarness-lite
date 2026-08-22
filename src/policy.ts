import type {
  Attempt,
  AttemptResult,
  AnalystAdvice,
  Approval,
  AutomaticRecoveryCandidate,
  BlockClass,
  EvidencePack,
  HarnessState,
  Incident,
  Job,
  JobState,
  RecoveryAction,
} from "./model.js";
import type { SafeRuntimeDiagnostic } from "./pi-rpc-diagnostics.js";
import { isPreSideEffectTransientProviderCode, runtimeSideEffectBoundaryFrom } from "./pi-rpc-diagnostics.js";
import { digest, isRetryAction, MAX_CI_REWORKS } from "./model.js";
import type { Clock, IdGenerator } from "./ports.js";

export function allowedActionsFor(blockClass: BlockClass, lane: Incident["lane"]): RecoveryAction[] {
  switch (blockClass) {
    case "agent_decision":
    case "agent_blocked":
    case "review_uncertain":
    case "ci_failure":
      return ["retry_fresh_worker", "hold"];
    case "reviewer_preflight_dirty":
    case "validation_infrastructure":
      return lane === "reviewer" ? ["retry_fresh_reviewer", "hold"] : ["hold"];
    case "infrastructure_exhausted":
      return lane === "reviewer" ? ["retry_fresh_reviewer", "hold"] : ["retry_fresh_worker", "hold"];
    case "integrity_violation":
    case "stale_task":
    case "ci_rework_exhausted":
    case "analyst_unavailable":
      return ["hold"];
  }
}

export const PROVIDER_PRE_SIDE_EFFECT_BACKOFF_MS = 5_000;

export function automaticRecoveryCandidateForAttempt(
  job: Job,
  attempt: Attempt,
  runtimeDiagnostic: SafeRuntimeDiagnostic | null = null,
  observedAt?: string,
): AutomaticRecoveryCandidate | undefined {
  if (attempt.result !== null) return undefined;
  const providerCandidate = providerAutomaticRecoveryCandidate(job, attempt, runtimeDiagnostic, observedAt);
  if (providerCandidate) return providerCandidate;
  if (attempt.phase === "running" || attempt.phase === "settled") return undefined;
  if (attempt.lane === "worker") {
    const rule = "worker_pre_dispatch_infrastructure" as const;
    return {
      rule,
      fingerprint: digest({
        rule,
        baseSha: attempt.baseSha,
        expectedRemoteHeadSha: attempt.expectedRemoteHeadSha ?? null,
      }),
    };
  }
  if (
    attempt.lane !== "reviewer"
    || !job.headSha
    || attempt.expectedHeadSha !== job.headSha
  ) return undefined;
  const rule = "reviewer_same_head_infrastructure" as const;
  return { rule, fingerprint: digest({ rule, baseSha: attempt.baseSha, headSha: job.headSha }) };
}

export function automaticRecoveryFor(job: Job, advice: AnalystAdvice | null, now?: string): (AutomaticRecoveryCandidate & {
  action: Exclude<RecoveryAction, "hold">;
  attemptId: string;
}) | null {
  const incident = job.incident;
  const attempt = job.activeAttempt;
  const candidate = incident?.automaticRecovery;
  const action = candidate?.rule === "reviewer_same_head_infrastructure"
    ? "retry_fresh_reviewer"
    : candidate?.rule === "worker_pre_dispatch_infrastructure"
      ? "retry_fresh_worker"
      : candidate?.rule === "provider_pre_side_effect_transient"
        ? candidate.lane === "worker" ? "retry_fresh_worker" : "retry_fresh_reviewer"
        : null;
  if (
    job.state !== "blocked"
    || job.approval !== null
    || incident?.class !== "infrastructure_exhausted"
    || !candidate
    || !action
    || incident.attemptId !== attempt?.id
    || incident.lane !== attempt?.lane
    || attempt.phase !== "settled"
    || attempt.result !== null
    || (candidate.rule !== "provider_pre_side_effect_transient" && (
      !advice
      || advice.incidentId !== incident.id
      || advice.action !== action
      || !advice.resolutionBrief.trim()
      || (candidate.rule === "worker_pre_dispatch_infrastructure" && advice.unknowns.length !== 0)
    ))
    || (candidate.rule === "provider_pre_side_effect_transient" && (
      !now
      || !Number.isFinite(Date.parse(now))
      || Date.parse(now) < Date.parse(candidate.notBefore)
      || attempt.lane !== candidate.lane
      || (attempt.expectedHeadSha ?? attempt.baseSha) !== candidate.headSha
      || attempt.executionSnapshot?.provider !== candidate.provider
      || incident.runtimeDiagnostic?.failureCode !== candidate.failureCode
      || !isPreSideEffectTransientProviderCode(candidate.failureCode)
      || !preSideEffectProviderFailure(incident.runtimeDiagnostic)
      || (job.automaticRecoveries ?? []).some((entry) => entry.scopeFingerprint === candidate.scopeFingerprint)
    ))
    || !incident.allowedActions.includes(action)
    || !allowedActionsFor(incident.class, incident.lane).includes(action)
    || (candidate.rule === "reviewer_same_head_infrastructure" && (
      attempt.lane !== "reviewer" || !job.headSha || attempt.expectedHeadSha !== job.headSha
    ))
    || (candidate.rule === "worker_pre_dispatch_infrastructure" && attempt.lane !== "worker")
    || (job.automaticRecoveries ?? []).some((entry) => entry.fingerprint === candidate.fingerprint)
  ) return null;
  return { ...candidate, action, attemptId: attempt.id };
}

export function automaticRecoveryBackoffPending(job: Job, advice: AnalystAdvice | null, now: string): boolean {
  const candidate = job.incident?.automaticRecovery;
  return candidate?.rule === "provider_pre_side_effect_transient"
    && Number.isFinite(Date.parse(now))
    && Date.parse(now) < Date.parse(candidate.notBefore)
    && automaticRecoveryFor(job, advice, candidate.notBefore) !== null;
}

export function isAutomaticRecoveryApproval(job: Job, approval: Approval): boolean {
  const candidate = job.incident?.automaticRecovery;
  return approval.basis === "policy_rule"
    && candidate !== undefined
    && approval.policyRule === candidate.rule
    && approval.fingerprint === candidate.fingerprint
    && (job.automaticRecoveries ?? []).some((entry) => (
      entry.id === approval.id
      && entry.incidentId === approval.incidentId
      && entry.analysisId === approval.analysisId
      && entry.attemptId === job.activeAttempt?.id
      && entry.action === approval.action
      && entry.policyRule === approval.policyRule
      && entry.fingerprint === approval.fingerprint
      && (candidate.rule !== "provider_pre_side_effect_transient" || (
        entry.scopeFingerprint === candidate.scopeFingerprint
        && entry.lane === candidate.lane
        && entry.headSha === candidate.headSha
        && entry.provider === candidate.provider
        && entry.failureCode === candidate.failureCode
        && entry.notBefore === candidate.notBefore
      ))
    ));
}

function providerAutomaticRecoveryCandidate(
  job: Job,
  attempt: Attempt,
  diagnostic: SafeRuntimeDiagnostic | null,
  observedAt?: string,
): AutomaticRecoveryCandidate | undefined {
  const provider = attempt.executionSnapshot?.provider;
  const headSha = attempt.expectedHeadSha ?? attempt.baseSha;
  if (
    attempt.executionSnapshot?.adapter !== "pi-rpc"
    || !provider
    || !observedAt
    || !Number.isFinite(Date.parse(observedAt))
    || !/^[0-9a-f]{40}$/i.test(headSha)
    || !diagnostic
    || !isPreSideEffectTransientProviderCode(diagnostic.failureCode)
    || !preSideEffectProviderFailure(diagnostic)
  ) return undefined;
  const rule = "provider_pre_side_effect_transient" as const;
  return {
    rule,
    provider,
    failureCode: diagnostic.failureCode,
    lane: attempt.lane,
    headSha,
    fingerprint: digest({ rule, provider, failureCode: diagnostic.failureCode, attemptId: attempt.id, headSha }),
    scopeFingerprint: digest({ rule, jobId: job.id, lane: attempt.lane, headSha }),
    notBefore: new Date(Date.parse(observedAt) + PROVIDER_PRE_SIDE_EFFECT_BACKOFF_MS).toISOString(),
  };
}

function preSideEffectProviderFailure(diagnostic: SafeRuntimeDiagnostic | undefined): boolean {
  if (!diagnostic) return false;
  const boundary = runtimeSideEffectBoundaryFrom(diagnostic);
  return boundary !== null
    && !boundary.toolExecutionStarted
    && !boundary.durableResultPresent
    && !boundary.worktreeChanged
    && !boundary.commitCreated;
}

export type OperatorAction = {
  id: string;
  kind: "approve_retry" | "reassess" | "resolve_decision" | "cancel";
  effect: "retry_fresh_worker" | "retry_fresh_reviewer" | "rerun_analysis" | "cancel_and_requeue";
  binding: {
    jobId: string;
    revision: number;
    incidentId: string;
    analysisId: string;
    attemptId: string | null;
    headSha: string | null;
    pullRequestHeadSha: string | null;
  };
};

export type OperatorProjection = {
  mode: "idle" | "running" | "waiting" | "needs_decision" | "terminal";
  phase: "idle" | "claim" | "worker" | "reviewer" | "delivery" | "recovery" | "terminal";
  jobId: string | null;
  revision: number | null;
  state: JobState | null;
  reason: string | null;
  actions: OperatorAction[];
};

/** One Core-owned projection used by operator adapters and recovery gates. */
export function projectOperatorState(state: HarnessState): OperatorProjection {
  const job = state.activeJob;
  if (!job) {
    return { mode: "idle", phase: "idle", jobId: null, revision: null, state: null, reason: null, actions: [] };
  }
  const actions = operatorActionsFor(job);
  const terminal = job.state === "done" || job.state === "cancelled";
  const waiting = job.state === "worker_running"
    || job.state === "reviewer_running"
    || job.state === "awaiting_merge"
    || job.state === "blocked";
  return {
    mode: terminal ? "terminal" : actions.length > 0 ? "needs_decision" : waiting ? "waiting" : "running",
    phase: operatorPhase(job.state),
    jobId: job.id,
    revision: job.revision,
    state: job.state,
    reason: job.incident?.summary ?? job.lastError,
    actions,
  };
}

export function operatorActionsFor(job: Job): OperatorAction[] {
  const incident = job.incident;
  const analysis = job.analysis;
  if (
    job.state !== "blocked"
    || job.approval !== null
    || !incident
    || !analysis
    || analysis.incidentId !== incident.id
  ) return [];

  const actions: OperatorAction[] = [];
  if (
    isRetryAction(analysis.action)
    && incident.allowedActions.includes(analysis.action)
    && allowedActionsFor(incident.class, incident.lane).includes(analysis.action)
  ) actions.push(makeOperatorAction(job, "approve_retry", analysis.action));
  if (isDecisionResolutionEligible(job)) {
    actions.push(makeOperatorAction(job, "resolve_decision", "retry_fresh_worker"));
  }
  if (reassessmentClassFor(job) !== null) actions.push(makeOperatorAction(job, "reassess", "rerun_analysis"));
  if (
    analysis.action === "hold"
    && job.claimConfirmed
    && job.pullRequest === null
  ) actions.push(makeOperatorAction(job, "cancel", "cancel_and_requeue"));
  return actions;
}

export function reassessmentClassFor(job: Job): BlockClass | null {
  const incident = job.incident;
  const analysis = job.analysis;
  if (
    job.state !== "blocked"
    || !incident
    || !analysis
    || analysis.incidentId !== incident.id
    || analysis.action !== "hold"
  ) return null;

  const retryActions = incident.allowedActions.filter(isRetryAction);
  const retryAction = retryActions.length === 1 ? retryActions[0]! : null;
  const exactAttempt = job.approval === null
    && job.activeAttempt?.lane === incident.lane
    && job.activeAttempt.id === incident.attemptId
    && job.activeAttempt.phase === "settled";
  const heldInfrastructure = incident.class === "infrastructure_exhausted" && job.activeAttempt?.result === null;
  const heldValidationInfrastructure = incident.class === "validation_infrastructure"
    && incident.lane === "reviewer"
    && job.activeAttempt?.lane === "reviewer"
    && job.activeAttempt.handle === null
    && job.activeAttempt.result === null
    && job.activeAttempt.expectedHeadSha === job.headSha;
  const heldReviewerBlock = incident.class === "review_uncertain"
    && incident.lane === "reviewer"
    && job.activeAttempt?.lane === "reviewer"
    && job.activeAttempt.expectedHeadSha === job.headSha
    && job.activeAttempt.result?.lane === "reviewer"
    && job.activeAttempt.result.status === "blocked"
    && job.activeAttempt.result.reviewedHeadSha === job.headSha;
  const heldReviewerPreflight = incident.class === "reviewer_preflight_dirty"
    && incident.lane === "reviewer"
    && job.activeAttempt?.lane === "reviewer"
    && job.activeAttempt.handle === null
    && job.activeAttempt.result === null
    && job.activeAttempt.expectedHeadSha === job.headSha;
  const legacyReviewerPreflight = incident.class === "integrity_violation"
    && incident.lane === "reviewer"
    && incident.allowedActions.length === 1
    && incident.allowedActions[0] === "hold"
    && job.activeAttempt?.lane === "reviewer"
    && job.activeAttempt.handle === null
    && job.activeAttempt.result === null
    && job.activeAttempt.expectedHeadSha === job.headSha
    && incident.summary.startsWith("reviewer modified the worktree outside Harness result files:");
  const legacyWorkerHeadMismatch = isLegacyWorkerHeadMismatch(job);
  const heldCiIncident = job.approval === null
    && (incident.class === "ci_failure" || incident.class === "ci_rework_exhausted")
    && incident.lane === "controller"
    && incident.attemptId === null
    && job.activeAttempt === null
    && job.pullRequest !== null
    && job.ciFailure !== null
    && job.ciFailure !== undefined
    && job.ciFailure.headSha === job.pullRequest.headSha
    && job.headSha === job.pullRequest.headSha
    && (job.ciReworkCount ?? 0) < MAX_CI_REWORKS;
  const heldCiFailure = heldCiIncident && incident.class === "ci_failure";
  const legacyCiExhausted = heldCiIncident
    && incident.class === "ci_rework_exhausted"
    && incident.allowedActions.length === 1
    && incident.allowedActions[0] === "hold";
  const effectiveRetryAction = legacyWorkerHeadMismatch
    ? "retry_fresh_worker"
    : legacyReviewerPreflight
      ? "retry_fresh_reviewer"
      : legacyCiExhausted
        ? "retry_fresh_worker"
        : retryAction;
  const analystExecutionFailed = analysis.evidenceDigest === incident.evidenceDigest
    && isControllerAnalystFailure(analysis);
  if (
    effectiveRetryAction === null
    || (!legacyWorkerHeadMismatch && !legacyReviewerPreflight && !legacyCiExhausted && !incident.allowedActions.includes(effectiveRetryAction))
    || (!legacyWorkerHeadMismatch && !legacyReviewerPreflight && !legacyCiExhausted && !allowedActionsFor(incident.class, incident.lane).includes(effectiveRetryAction))
    || (!exactAttempt && !heldCiIncident)
    || (!heldInfrastructure && !heldValidationInfrastructure && !heldReviewerBlock && !heldReviewerPreflight && !legacyWorkerHeadMismatch && !legacyReviewerPreflight && !analystExecutionFailed && !heldCiFailure && !legacyCiExhausted)
  ) return null;

  return legacyWorkerHeadMismatch
    ? "infrastructure_exhausted"
    : heldReviewerBlock
      ? "infrastructure_exhausted"
      : legacyReviewerPreflight
        ? "reviewer_preflight_dirty"
        : legacyCiExhausted
          ? "ci_failure"
          : incident.class;
}

/** Exact evidence boundary for a maintainer resolving an exhausted Reviewer architecture decision. */
export function isDecisionResolutionEligible(job: Job): boolean {
  const incident = job.incident;
  const analysis = job.analysis;
  const attempt = job.activeAttempt;
  const review = attempt?.result;
  return incident?.class === "review_uncertain"
    && incident.lane === "reviewer"
    && incident.attemptId !== null
    && incident.attemptId === attempt?.id
    && incident.allowedActions.includes("retry_fresh_worker")
    && allowedActionsFor(incident.class, incident.lane).includes("retry_fresh_worker")
    && analysis?.incidentId === incident.id
    && analysis.action === "hold"
    && analysis.resolutionBrief === ""
    && analysis.unknowns.length > 0
    && job.headSha !== null
    && Number.isInteger(job.maxReviewRounds)
    && job.maxReviewRounds >= 1
    && attempt?.lane === "reviewer"
    && attempt.phase === "settled"
    && Number.isInteger(attempt.round)
    && attempt.round >= job.maxReviewRounds
    && attempt.expectedHeadSha === job.headSha
    && review?.lane === "reviewer"
    && review.status === "changes"
    && review.reviewedHeadSha === job.headSha
    && review.findings.some((finding) => finding.severity === "major" || finding.severity === "critical");
}

function makeOperatorAction(
  job: Job,
  kind: OperatorAction["kind"],
  effect: OperatorAction["effect"],
): OperatorAction {
  const binding = {
    jobId: job.id,
    revision: job.revision,
    incidentId: job.incident!.id,
    analysisId: job.analysis!.id,
    attemptId: job.activeAttempt?.id ?? null,
    headSha: job.headSha,
    pullRequestHeadSha: job.pullRequest?.headSha ?? null,
  };
  return {
    id: `decision-${digest({ kind, effect, binding }).slice(0, 16)}`,
    kind,
    effect,
    binding,
  };
}

function operatorPhase(state: JobState): OperatorProjection["phase"] {
  switch (state) {
    case "claimed": return "claim";
    case "worker_ready":
    case "worker_running": return "worker";
    case "reviewer_ready":
    case "reviewer_running": return "reviewer";
    case "publish_ready":
    case "awaiting_merge": return "delivery";
    case "blocked":
    case "recovery_approved": return "recovery";
    case "done":
    case "cancelled": return "terminal";
  }
}

function isLegacyWorkerHeadMismatch(job: Job): boolean {
  const attempt = job.activeAttempt;
  const incident = job.incident;
  const result = attempt?.result;
  if (
    job.approval !== null
    || job.pullRequest !== null
    || incident?.class !== "integrity_violation"
    || incident.lane !== "worker"
    || incident.allowedActions.length !== 1
    || incident.allowedActions[0] !== "hold"
    || attempt?.lane !== "worker"
    || attempt.phase !== "settled"
    || incident.attemptId !== attempt.id
    || attempt.baseSha !== (job.headSha ?? job.baseSha)
    || result?.lane !== "worker"
    || result.status !== "completed"
    || result.jobId !== job.id
    || result.attemptId !== attempt.id
    || result.failedCommands.length !== 0
    || !result.headSha
  ) return false;
  const match = /^worktree HEAD ([0-9a-f]{40}) != worker result ([0-9a-f]{40})$/i.exec(incident.summary);
  if (!match) return false;
  const actualHead = match[1]!.toLowerCase();
  const reportedHead = match[2]!.toLowerCase();
  return actualHead !== reportedHead
    && actualHead.slice(0, 7) === reportedHead.slice(0, 7)
    && reportedHead === result.headSha.toLowerCase();
}

export function isControllerAnalystFailure(advice: AnalystAdvice): boolean {
  return advice.action === "hold"
    && advice.resolutionBrief === ""
    && advice.evidenceRefs.length === 0
    && advice.unknowns.length === 1
    && advice.summary === `Analyst diagnosis failed closed: ${advice.unknowns[0]}`;
}

export function makeIncident(input: {
  jobId: string;
  jobRevision: number;
  lane: Incident["lane"];
  attemptId: string | null;
  blockClass: BlockClass;
  summary: string;
  automaticRecovery?: AutomaticRecoveryCandidate;
  runtimeDiagnostic?: SafeRuntimeDiagnostic;
  clock: Clock;
  ids: IdGenerator;
}): Incident {
  const createdAt = input.clock.now();
  const core = {
    jobId: input.jobId,
    jobRevision: input.jobRevision,
    lane: input.lane,
    attemptId: input.attemptId,
    blockClass: input.blockClass,
    summary: input.summary,
    ...(input.automaticRecovery ? { automaticRecovery: input.automaticRecovery } : {}),
    ...(input.runtimeDiagnostic ? { runtimeDiagnostic: input.runtimeDiagnostic } : {}),
    createdAt,
  };
  return {
    id: input.ids.next("incident"),
    class: input.blockClass,
    lane: input.lane,
    attemptId: input.attemptId,
    summary: input.summary,
    evidenceDigest: digest(core),
    allowedActions: allowedActionsFor(input.blockClass, input.lane),
    ...(input.automaticRecovery ? { automaticRecovery: input.automaticRecovery } : {}),
    ...(input.runtimeDiagnostic ? { runtimeDiagnostic: input.runtimeDiagnostic } : {}),
    createdAt,
  };
}

export function validateAttemptResult(
  jobId: string,
  attempt: Attempt,
  result: AttemptResult | null,
): { ok: true; result: AttemptResult } | { ok: false; reason: string } {
  if (!result) return { ok: false, reason: "agent settled without a durable result" };
  if (result.version !== 1) return { ok: false, reason: "unsupported attempt result version" };
  if (result.jobId.trim() === "" || result.attemptId.trim() === "") {
    return { ok: false, reason: "attempt result identity is empty" };
  }
  if (result.jobId !== jobId) {
    return { ok: false, reason: `job id mismatch: expected ${jobId}, got ${result.jobId}` };
  }
  if (result.attemptId !== attempt.id) {
    return { ok: false, reason: `attempt id mismatch: expected ${attempt.id}, got ${result.attemptId}` };
  }
  if (result.lane !== attempt.lane) {
    return { ok: false, reason: `attempt lane mismatch: expected ${attempt.lane}, got ${result.lane}` };
  }
  if (result.lane === "worker" && result.status === "completed" && !result.headSha) {
    return { ok: false, reason: "completed worker result is missing headSha" };
  }
  if (result.lane === "reviewer" && (result.status === "pass" || result.status === "changes") && !result.reviewedHeadSha) {
    return { ok: false, reason: "reviewer result is missing reviewedHeadSha" };
  }
  return { ok: true, result };
}

export function buildEvidencePack(input: {
  incident: Incident;
  jobId: string;
  jobRevision: number;
  taskDigest: string;
  items: EvidencePack["items"];
  missing: string[];
}): EvidencePack {
  const root = {
    incidentId: input.incident.id,
    jobId: input.jobId,
    jobRevision: input.jobRevision,
    taskDigest: input.taskDigest,
    items: input.items.map((item) => ({ ref: item.ref, digest: item.digest })),
    missing: input.missing,
  };
  return {
    incidentId: input.incident.id,
    jobId: input.jobId,
    jobRevision: input.jobRevision,
    taskDigest: input.taskDigest,
    digest: digest(root),
    items: input.items,
    missing: input.missing,
  };
}
