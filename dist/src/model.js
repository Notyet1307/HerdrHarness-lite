import { createHash } from "node:crypto";
export function isRecoveryAction(value) {
    return value === "retry_fresh_worker" || value === "retry_fresh_reviewer" || value === "hold";
}
export function isRetryAction(value) {
    return value === "retry_fresh_worker" || value === "retry_fresh_reviewer";
}
export const MAX_CI_REWORKS = 2;
export const MAX_ATTEMPT_RECONCILIATIONS = 1;
export function taskFromSelection(repo, selected) {
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
export function digest(value) {
    const hash = createHash("sha256");
    hash.update(stableStringify(value));
    return hash.digest("hex");
}
export function stableStringify(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    const object = value;
    return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
        .join(",")}}`;
}
export function evolveJob(job, now, patch) {
    return {
        ...job,
        ...patch,
        revision: job.revision + 1,
        updatedAt: now,
    };
}
export function assertJobInvariant(job) {
    if (!job.id.trim())
        throw new Error("job id is empty");
    if (job.revision < 0 || !Number.isInteger(job.revision))
        throw new Error("job revision is invalid");
    if (job.state === "blocked" && !job.incident)
        throw new Error("blocked job requires an incident");
    if (job.state === "recovery_approved" && !job.approval) {
        throw new Error("recovery_approved job requires an approval");
    }
    if (job.state === "cancelled" && !job.cancellation)
        throw new Error("cancelled job requires a cancellation record");
    if (job.pendingBrief?.trim())
        throw new Error("legacy pendingBrief requires a quiescent migration");
    if (job.pendingHandoff) {
        assertTypedHandoff(job.pendingHandoff);
        const lane = job.pendingHandoff.target.lane;
        if (job.activeAttempt
            || job.state !== `${lane}_ready`
            || job.pendingHandoff.source.jobRevision + 1 !== job.revision
            || job.pendingHandoff.source.taskDigest !== job.task.digest
            || job.pendingHandoff.target.baseSha !== (lane === "worker" ? (job.headSha ?? job.baseSha) : job.baseSha)
            || job.pendingHandoff.target.expectedHeadSha !== (lane === "reviewer" ? job.headSha : null)
            || job.pendingHandoff.target.expectedRemoteHeadSha !== (lane === "worker" ? (job.pullRequest?.headSha ?? null) : null))
            throw new Error("pending handoff is not bound to the next ready Attempt");
    }
    if (job.cancellation && (!Number.isInteger(job.cancellation.jobRevision)
        || job.cancellation.jobRevision < 0
        || !isBoundedText(job.cancellation.id, 512)
        || !isBoundedText(job.cancellation.incidentId, 512)
        || !isBoundedText(job.cancellation.analysisId, 512)
        || !isBoundedText(job.cancellation.actor, 512)
        || !isBoundedText(job.cancellation.reason, 2_000)
        || !Number.isFinite(Date.parse(job.cancellation.createdAt))))
        throw new Error("job has an invalid cancellation record");
    const ciReworkCount = job.ciReworkCount ?? 0;
    if (!Number.isInteger(ciReworkCount) || ciReworkCount < 0 || ciReworkCount > MAX_CI_REWORKS) {
        throw new Error("job has an invalid CI rework count");
    }
    if (job.ciFailure) {
        if (!job.pullRequest ||
            job.ciFailure.headSha !== job.pullRequest.headSha ||
            !Number.isFinite(Date.parse(job.ciFailure.observedAt)) ||
            job.ciFailure.checks.length === 0 ||
            job.ciFailure.checks.some((check) => check.bucket !== "fail" && check.bucket !== "cancel")) {
            throw new Error("job has invalid CI failure evidence");
        }
    }
    if ((job.incident?.class === "ci_failure" || job.incident?.class === "ci_rework_exhausted") && !job.ciFailure) {
        throw new Error("CI incident requires failure evidence");
    }
    if (job.incident &&
        (!Array.isArray(job.incident.allowedActions) ||
            job.incident.allowedActions.length === 0 ||
            job.incident.allowedActions.some((action) => !isRecoveryAction(action)) ||
            new Set(job.incident.allowedActions).size !== job.incident.allowedActions.length)) {
        throw new Error("incident has an invalid recovery action");
    }
    if (job.analysis && !isRecoveryAction(job.analysis.action)) {
        throw new Error("analysis has an invalid recovery action");
    }
    if (job.approval && !isRetryAction(job.approval.action)) {
        throw new Error("approval has an invalid recovery action");
    }
    if (job.approval?.basis !== undefined &&
        job.approval.basis !== "analyst_advice" &&
        job.approval.basis !== "human_decision") {
        throw new Error("approval has an invalid basis");
    }
    if (job.approval?.basis === "human_decision" &&
        (!isBoundedText(job.approval.actor, 512) ||
            !isBoundedText(job.approval.reason, 2_000) ||
            !Number.isFinite(Date.parse(job.approval.createdAt)))) {
        throw new Error("human decision approval is not auditable");
    }
    if (job.reassessments !== undefined &&
        (!Array.isArray(job.reassessments) || job.reassessments.some((entry) => (!entry ||
            !Number.isInteger(entry.jobRevision) ||
            entry.jobRevision < 0 ||
            !isBoundedText(entry.id, 512) ||
            !isBoundedText(entry.incidentId, 512) ||
            !isBoundedText(entry.analysisId, 512) ||
            !isBoundedText(entry.replacementIncidentId, 512) ||
            !isBoundedText(entry.actor, 512) ||
            !isBoundedText(entry.reason, 2_000) ||
            !Number.isFinite(Date.parse(entry.createdAt)))))) {
        throw new Error("job has an invalid reassessment record");
    }
    if ((job.state === "worker_running" || job.state === "reviewer_running") && !job.activeAttempt) {
        throw new Error(`${job.state} requires an active attempt`);
    }
    if (job.activeAttempt &&
        job.activeAttempt.lane === "worker" &&
        !["worker_running", "blocked", "recovery_approved", "cancelled"].includes(job.state)) {
        throw new Error("worker attempt is bound to an invalid state");
    }
    if (job.activeAttempt &&
        job.activeAttempt.lane === "reviewer" &&
        !["reviewer_running", "blocked", "recovery_approved", "cancelled"].includes(job.state)) {
        throw new Error("reviewer attempt is bound to an invalid state");
    }
    if (job.activeAttempt?.expectedRemoteHeadSha !== undefined &&
        job.activeAttempt.expectedRemoteHeadSha !== null &&
        !/^[0-9a-f]{40}$/i.test(job.activeAttempt.expectedRemoteHeadSha)) {
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
        if (handoff.source.taskDigest !== job.task.digest
            || handoff.target.lane !== job.activeAttempt.lane
            || handoff.target.baseSha !== job.activeAttempt.baseSha
            || handoff.target.expectedHeadSha !== job.activeAttempt.expectedHeadSha
            || handoff.target.expectedRemoteHeadSha !== (job.activeAttempt.expectedRemoteHeadSha ?? null))
            throw new Error("attempt handoff targets different work");
    }
    const reconciliationAttempts = job.activeAttempt?.reconciliationAttempts ?? 0;
    if (!Number.isInteger(reconciliationAttempts)
        || reconciliationAttempts < 0
        || reconciliationAttempts > MAX_ATTEMPT_RECONCILIATIONS) {
        throw new Error("attempt has an invalid reconciliation count");
    }
    if ((job.state === "publish_ready" || job.state === "awaiting_merge" || job.state === "done") && !job.headSha) {
        throw new Error(`${job.state} requires headSha`);
    }
    if (job.analyst && job.analyst.taskDigest !== job.task.digest) {
        throw new Error("analyst is bound to a different task digest");
    }
}
export function assertTypedHandoff(handoff) {
    if (!handoff
        || typeof handoff !== "object"
        || !handoff.source
        || typeof handoff.source !== "object"
        || !handoff.target
        || typeof handoff.target !== "object"
        || !Array.isArray(handoff.obligations)
        || !Array.isArray(handoff.evidenceRefs)
        || !Array.isArray(handoff.unknowns))
        throw new Error("job has an invalid typed handoff");
    const { id, ...body } = handoff;
    const nullableText = (value, max = 512) => value === null || isBoundedText(value, max);
    const nullableDigest = (value) => value === null || (typeof value === "string" && /^[0-9a-f]{64}$/i.test(value));
    const nullableSha = (value) => value === null || (typeof value === "string" && /^[0-9a-f]{40}$/i.test(value));
    if (handoff.version !== 1
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
        || handoff.obligations.some((item) => (!item
            || typeof item !== "object"
            || (item.severity !== null && !["critical", "major", "minor"].includes(item.severity))
            || !isBoundedText(item.summary, 10_000)
            || !nullableText(item.evidence, 10_000)))
        || handoff.evidenceRefs.length > 100
        || handoff.evidenceRefs.some((entry) => !isBoundedText(entry, 2_000))
        || handoff.unknowns.length > 100
        || handoff.unknowns.some((entry) => !isBoundedText(entry, 2_000))
        || !Number.isFinite(Date.parse(handoff.createdAt)))
        throw new Error("job has an invalid typed handoff");
}
export function isBoundedText(value, max) {
    return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\u0000");
}
//# sourceMappingURL=model.js.map