import { digest } from "./model.js";
export function reviewChangesHandoff(input) {
    const body = {
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
            baseSha: input.job.headSha,
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
export function approvedRecoveryHandoff(input) {
    const targetLane = input.approval.action === "retry_fresh_reviewer" ? "reviewer" : "worker";
    const obligations = [];
    if (input.approval.basis === "human_decision") {
        obligations.push({ severity: null, summary: input.approval.reason, evidence: null });
        if (input.job.activeAttempt?.result?.lane === "reviewer") {
            obligations.push(...input.job.activeAttempt.result.findings.map((finding) => ({ ...finding })));
        }
    }
    else if (input.analysis.resolutionBrief.trim()) {
        obligations.push({ severity: null, summary: input.analysis.resolutionBrief, evidence: null });
    }
    if (input.incident.class === "ci_failure") {
        obligations.push(...(input.job.ciFailure?.checks ?? []).map((check) => ({
            severity: null,
            summary: `${check.name}: ${check.diagnostic ?? check.state}`,
            evidence: check.link || null,
        })));
    }
    const body = {
        version: 1,
        kind: input.incident.class === "ci_failure" ? "ci_rework" : "approved_recovery",
        source: {
            jobRevision: input.job.revision,
            taskDigest: input.job.task.digest,
            attemptId: input.job.activeAttempt?.id ?? null,
            resultDigest: input.job.activeAttempt?.result ? digest(input.job.activeAttempt.result) : null,
            incidentId: input.incident.id,
            evidenceDigest: input.incident.evidenceDigest,
            analysisId: input.analysis.id,
            approvalId: input.approval.id,
            headSha: input.job.headSha,
        },
        target: {
            lane: targetLane,
            baseSha: targetLane === "worker" ? (input.job.headSha ?? input.job.baseSha) : input.job.baseSha,
            expectedHeadSha: targetLane === "reviewer" ? input.job.headSha : null,
            expectedRemoteHeadSha: targetLane === "worker" ? (input.job.pullRequest?.headSha ?? null) : null,
        },
        summary: input.approval.basis === "human_decision" ? input.approval.reason : input.analysis.summary,
        obligations,
        evidenceRefs: [...new Set([
                ...input.analysis.evidenceRefs,
                ...(input.incident.class === "ci_failure" ? (input.job.ciFailure?.checks ?? []).map((check) => check.link).filter(Boolean) : []),
            ])],
        unknowns: [...input.analysis.unknowns],
        createdAt: input.createdAt,
    };
    return identify(body);
}
export function bindPendingHandoff(job, attempt) {
    if (job.pendingBrief?.trim())
        throw new Error("legacy pendingBrief cannot be promoted into a new Attempt");
    const handoff = job.pendingHandoff ?? null;
    if (!handoff)
        return null;
    if (handoff.version !== 1
        || handoff.source.jobRevision + 1 !== job.revision
        || handoff.source.taskDigest !== job.task.digest
        || handoff.target.lane !== attempt.lane
        || handoff.target.baseSha !== attempt.baseSha
        || handoff.target.expectedHeadSha !== attempt.expectedHeadSha
        || handoff.target.expectedRemoteHeadSha !== (attempt.expectedRemoteHeadSha ?? null))
        throw new Error("pending handoff is stale or targets a different Attempt");
    return handoff;
}
function identify(body) {
    return { ...body, id: `handoff-${digest(body).slice(0, 32)}` };
}
//# sourceMappingURL=handoff.js.map