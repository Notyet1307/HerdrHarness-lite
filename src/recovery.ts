import type { AnalystAdvice, Approval, HarnessState, Reassessment } from "./model.js";
import { evolveJob, isBoundedText, isRetryAction } from "./model.js";
import { allowedActionsFor, makeIncident } from "./policy.js";
import type { Clock, IdGenerator, StateStore } from "./ports.js";

export type ApprovalRequest = {
  expectedRevision: number;
  incidentId: string;
  analysisId: string;
  actor: string;
  reason: string;
};

export type ReassessmentRequest = ApprovalRequest;

/** Human gate: records authority, but never talks to an old agent or mutates Git. */
export async function approveRecovery(
  store: StateStore,
  request: ApprovalRequest,
  dependencies: { clock: Clock; ids: IdGenerator },
): Promise<Approval> {
  if (!request.actor.trim()) throw new Error("approval actor is required");
  if (!request.reason.trim()) throw new Error("approval reason is required");

  const state = await store.load();
  const job = state.activeJob;
  if (!job) throw new Error("no active job");
  if (job.revision !== request.expectedRevision) {
    throw new Error(`stale job revision: expected ${request.expectedRevision}, current ${job.revision}`);
  }
  if (job.state !== "blocked" || !job.incident) throw new Error("job is not awaiting a recovery decision");
  if (job.incident.id !== request.incidentId) throw new Error("incident changed before approval");
  if (!job.analysis) throw new Error("no ready analyst advice");
  if (job.analysis.id !== request.analysisId) throw new Error("analysis changed before approval");
  if (job.analysis.incidentId !== job.incident.id) throw new Error("analysis is not bound to the active incident");
  if (!isRetryAction(job.analysis.action)) throw new Error("analyst did not recommend retry");
  if (
    !job.incident.allowedActions.includes(job.analysis.action) ||
    !allowedActionsFor(job.incident.class, job.incident.lane).includes(job.analysis.action)
  ) {
    throw new Error(`incident class ${job.incident.class} forbids ${job.analysis.action}`);
  }

  const now = dependencies.clock.now();
  const approval: Approval = {
    id: dependencies.ids.next("approval"),
    jobRevision: job.revision,
    incidentId: job.incident.id,
    analysisId: job.analysis.id,
    action: job.analysis.action,
    actor: request.actor,
    reason: request.reason,
    createdAt: now,
    consumedAt: null,
  };
  const nextJob = evolveJob(job, now, {
    state: "recovery_approved",
    approval,
    lastError: null,
  });
  const next: HarnessState = { ...state, activeJob: nextJob };
  await store.save(next, job.revision);
  return approval;
}

/** Human gate: requests new analysis after a hold, but grants no retry authority. */
export async function reassessIncident(
  store: StateStore,
  request: ReassessmentRequest,
  dependencies: { clock: Clock; ids: IdGenerator },
): Promise<Reassessment> {
  if (!isBoundedText(request.actor, 512)) throw new Error("reassessment actor is required and bounded");
  if (!isBoundedText(request.reason, 2_000)) throw new Error("reassessment reason is required and bounded");

  const state = await store.load();
  const job = state.activeJob;
  if (!job) throw new Error("no active job");
  if (job.revision !== request.expectedRevision) {
    throw new Error(`stale job revision: expected ${request.expectedRevision}, current ${job.revision}`);
  }
  if (job.state !== "blocked" || !job.incident) throw new Error("job is not awaiting reassessment");
  if (job.incident.id !== request.incidentId) throw new Error("incident changed before reassessment");
  if (!job.analysis || job.analysis.id !== request.analysisId) throw new Error("analysis changed before reassessment");
  if (job.analysis.incidentId !== job.incident.id) throw new Error("analysis is not bound to the active incident");
  if (job.analysis.action !== "hold") throw new Error("only a held analysis can be reassessed");
  const retryActions = job.incident.allowedActions.filter(isRetryAction);
  const retryAction = retryActions.length === 1 ? retryActions[0]! : null;
  const exactAttempt = job.approval === null && job.activeAttempt?.lane === job.incident.lane
    && job.activeAttempt.id === job.incident.attemptId && job.activeAttempt.phase === "settled";
  const heldInfrastructure = job.incident.class === "infrastructure_exhausted"
    && job.activeAttempt?.result === null;
  const heldReviewerBlock = job.incident.class === "review_uncertain"
    && job.incident.lane === "reviewer"
    && job.activeAttempt?.lane === "reviewer"
    && job.activeAttempt.expectedHeadSha === job.headSha
    && job.activeAttempt.result?.lane === "reviewer"
    && job.activeAttempt.result.status === "blocked"
    && job.activeAttempt.result.reviewedHeadSha === job.headSha;
  const heldReviewerPreflight = job.incident.class === "reviewer_preflight_dirty"
    && job.incident.lane === "reviewer"
    && job.activeAttempt?.lane === "reviewer"
    && job.activeAttempt.handle === null
    && job.activeAttempt.result === null
    && job.activeAttempt.expectedHeadSha === job.headSha;
  const legacyReviewerPreflight = job.incident.class === "integrity_violation"
    && job.incident.lane === "reviewer"
    && job.incident.allowedActions.length === 1
    && job.incident.allowedActions[0] === "hold"
    && job.activeAttempt?.lane === "reviewer"
    && job.activeAttempt.handle === null
    && job.activeAttempt.result === null
    && job.activeAttempt.expectedHeadSha === job.headSha
    && job.incident.summary.startsWith("reviewer modified the worktree outside Harness result files:");
  const effectiveRetryAction = legacyReviewerPreflight ? "retry_fresh_reviewer" : retryAction;
  const analystExecutionFailed = job.analysis.evidenceDigest === job.incident.evidenceDigest
    && isControllerAnalystFailure(job.analysis);
  if (
    effectiveRetryAction === null ||
    (!legacyReviewerPreflight && !job.incident.allowedActions.includes(effectiveRetryAction)) ||
    (!legacyReviewerPreflight && !allowedActionsFor(job.incident.class, job.incident.lane).includes(effectiveRetryAction)) ||
    !exactAttempt ||
    (!heldInfrastructure && !heldReviewerBlock && !heldReviewerPreflight && !legacyReviewerPreflight && !analystExecutionFailed)
  ) {
    throw new Error("only an exact held infrastructure incident, HEAD-bound Reviewer block, pre-start Reviewer residue, or controller-recorded Analyst execution failure can be reassessed");
  }

  const successor = makeIncident({
    jobId: job.id,
    jobRevision: job.revision + 1,
    lane: job.incident.lane,
    attemptId: job.incident.attemptId,
    blockClass: heldReviewerBlock
      ? "infrastructure_exhausted"
      : legacyReviewerPreflight
        ? "reviewer_preflight_dirty"
        : job.incident.class,
    summary: [
      `Reassessment requested for held incident ${job.incident.id}.`,
      `Previous incident (untrusted):\n${job.incident.summary}`,
      `Previous Analyst hold (untrusted): ${job.analysis.summary}`,
      `Operator statement (untrusted): ${request.reason}`,
    ].join("\n"),
    clock: dependencies.clock,
    ids: dependencies.ids,
  });
  const createdAt = dependencies.clock.now();
  const reassessment: Reassessment = {
    id: dependencies.ids.next("reassessment"),
    jobRevision: job.revision,
    incidentId: job.incident.id,
    analysisId: job.analysis.id,
    replacementIncidentId: successor.id,
    actor: request.actor,
    reason: request.reason,
    createdAt,
  };
  const nextJob = evolveJob(job, createdAt, {
    state: "blocked",
    incident: successor,
    analysis: null,
    approval: null,
    reassessments: [...(job.reassessments ?? []), reassessment],
    lastError: successor.summary,
  });
  await store.save({ ...state, activeJob: nextJob }, job.revision);
  return reassessment;
}

function isControllerAnalystFailure(advice: AnalystAdvice): boolean {
  return advice.action === "hold"
    && advice.resolutionBrief === ""
    && advice.evidenceRefs.length === 0
    && advice.unknowns.length === 1
    && advice.summary === `Analyst diagnosis failed closed: ${advice.unknowns[0]}`;
}
