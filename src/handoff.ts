import { digest, type AnalystAdvice, type Approval, type Attempt, type Incident, type Job, type ReviewerResult, type TypedHandoff } from "./model.js";

const MAX_HANDOFF_OBLIGATION_SUMMARY = 10_000;
const HANDOFF_TRUNCATION_MARKER = "\n...[truncated for typed handoff]...\n";

export function reviewChangesHandoff(input: {
  job: Job;
  attempt: Attempt;
  result: ReviewerResult;
  createdAt: string;
}): TypedHandoff {
  const body: Omit<TypedHandoff, "id"> = {
    version: 1,
    kind: "review_changes",
    source: {
      jobRevision: input.job.revision,
      taskDigest: input.job.task.digest,
      attemptId: input.attempt.id,
      resultDigest: digest(input.result),
      incidentId: null,
      evidenceDigest: null,
      analysisId: null,
      approvalId: null,
      headSha: input.result.reviewedHeadSha,
    },
    target: {
      lane: "worker",
      baseSha: input.job.headSha!,
      expectedHeadSha: null,
      expectedRemoteHeadSha: input.job.pullRequest?.headSha ?? null,
    },
    summary: input.result.summary,
    obligations: input.result.findings.map((finding) => ({ ...finding })),
    evidenceRefs: [],
    unknowns: [],
    createdAt: input.createdAt,
  };
  return identify(body);
}

export function approvedRecoveryHandoff(input: {
  job: Job;
  incident: Incident;
  analysis: AnalystAdvice | null;
  approval: Approval;
  createdAt: string;
}): TypedHandoff {
  const targetLane = input.approval.action === "retry_fresh_reviewer" ? "reviewer" : "worker";
  const obligations = [] as TypedHandoff["obligations"];
  if (input.approval.basis === "human_decision") {
    obligations.push({ severity: null, summary: input.approval.reason, evidence: null });
    if (input.job.activeAttempt?.result?.lane === "reviewer") {
      obligations.push(...input.job.activeAttempt.result.findings.map((finding) => ({ ...finding })));
    }
  } else if (input.analysis?.resolutionBrief.trim()) {
    obligations.push({ severity: null, summary: input.analysis.resolutionBrief, evidence: null });
  }
  if (input.approval.basis === "analyst_advice") {
    obligations.push({
      severity: null,
      summary: boundHandoffText(`Operator statement (untrusted): ${input.approval.reason}`, MAX_HANDOFF_OBLIGATION_SUMMARY),
      evidence: null,
    });
  }
  if (input.incident.class === "ci_failure") {
    obligations.push(...(input.job.ciFailure?.checks ?? []).map((check) => ({
      severity: null,
      summary: boundHandoffText(`${check.name}: ${check.diagnostic ?? check.state}`, MAX_HANDOFF_OBLIGATION_SUMMARY),
      evidence: check.link || null,
    })));
  }
  const body: Omit<TypedHandoff, "id"> = {
    version: 1,
    kind: input.incident.class === "ci_failure" ? "ci_rework" : "approved_recovery",
    source: {
      jobRevision: input.job.revision,
      taskDigest: input.job.task.digest,
      attemptId: input.job.activeAttempt?.id ?? null,
      resultDigest: input.job.activeAttempt?.result ? digest(input.job.activeAttempt.result) : null,
      incidentId: input.incident.id,
      evidenceDigest: input.incident.evidenceDigest,
      analysisId: input.approval.analysisId,
      approvalId: input.approval.id,
      headSha: input.job.headSha,
    },
    target: {
      lane: targetLane,
      baseSha: targetLane === "worker" ? (input.job.headSha ?? input.job.baseSha) : input.job.baseSha,
      expectedHeadSha: targetLane === "reviewer" ? input.job.headSha : null,
      expectedRemoteHeadSha: targetLane === "worker" ? (input.job.pullRequest?.headSha ?? null) : null,
    },
    summary: input.approval.basis === "policy_rule" && input.analysis === null
      ? input.approval.reason
      : input.approval.basis === "human_decision" ? input.approval.reason : input.analysis!.summary,
    obligations,
    evidenceRefs: [...new Set([
      ...(input.analysis?.evidenceRefs ?? []),
      ...(input.incident.class === "ci_failure" ? (input.job.ciFailure?.checks ?? []).map((check) => check.link).filter(Boolean) : []),
    ])],
    unknowns: [...(input.analysis?.unknowns ?? [])],
    createdAt: input.createdAt,
  };
  return identify(body);
}

export function bindPendingHandoff(job: Job, attempt: Attempt): TypedHandoff | null {
  if (job.pendingBrief?.trim()) throw new Error("legacy pendingBrief cannot be promoted into a new Attempt");
  const handoff = job.pendingHandoff ?? null;
  if (!handoff) return null;
  if (
    handoff.version !== 1
    || handoff.source.jobRevision + 1 !== job.revision
    || handoff.source.taskDigest !== job.task.digest
    || handoff.target.lane !== attempt.lane
    || handoff.target.baseSha !== attempt.baseSha
    || handoff.target.expectedHeadSha !== attempt.expectedHeadSha
    || handoff.target.expectedRemoteHeadSha !== (attempt.expectedRemoteHeadSha ?? null)
  ) throw new Error("pending handoff is stale or targets a different Attempt");
  return handoff;
}

function identify(body: Omit<TypedHandoff, "id">): TypedHandoff {
  return { ...body, id: `handoff-${digest(body).slice(0, 32)}` };
}

function boundHandoffText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const available = maxLength - HANDOFF_TRUNCATION_MARKER.length;
  const prefixLength = Math.ceil(available / 2);
  const suffixLength = Math.floor(available / 2);
  return `${value.slice(0, prefixLength)}${HANDOFF_TRUNCATION_MARKER}${value.slice(-suffixLength)}`;
}
