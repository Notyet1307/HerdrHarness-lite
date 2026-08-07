import { digest } from "./model.js";
export function allowedActionsFor(blockClass, lane) {
    switch (blockClass) {
        case "agent_decision":
        case "agent_blocked":
        case "review_uncertain":
        case "ci_failure":
            return ["retry_fresh_worker", "hold"];
        case "reviewer_preflight_dirty":
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
/** Exact evidence boundary for a maintainer resolving an exhausted Reviewer architecture decision. */
export function isDecisionResolutionEligible(job) {
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
export function makeIncident(input) {
    const createdAt = input.clock.now();
    const core = {
        jobId: input.jobId,
        jobRevision: input.jobRevision,
        lane: input.lane,
        attemptId: input.attemptId,
        blockClass: input.blockClass,
        summary: input.summary,
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
        createdAt,
    };
}
export function validateAttemptResult(jobId, attempt, result) {
    if (!result)
        return { ok: false, reason: "agent settled without a durable result" };
    if (result.version !== 1)
        return { ok: false, reason: "unsupported attempt result version" };
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
export function buildEvidencePack(input) {
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
//# sourceMappingURL=policy.js.map