import { createHash } from "node:crypto";
export function isRecoveryAction(value) {
    return value === "retry_fresh_worker" || value === "retry_fresh_reviewer" || value === "hold";
}
export function isRetryAction(value) {
    return value === "retry_fresh_worker" || value === "retry_fresh_reviewer";
}
export const MAX_CI_REWORKS = 2;
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
        !["worker_running", "blocked", "recovery_approved"].includes(job.state)) {
        throw new Error("worker attempt is bound to an invalid state");
    }
    if (job.activeAttempt &&
        job.activeAttempt.lane === "reviewer" &&
        !["reviewer_running", "blocked", "recovery_approved"].includes(job.state)) {
        throw new Error("reviewer attempt is bound to an invalid state");
    }
    if (job.activeAttempt?.expectedRemoteHeadSha !== undefined &&
        job.activeAttempt.expectedRemoteHeadSha !== null &&
        !/^[0-9a-f]{40}$/i.test(job.activeAttempt.expectedRemoteHeadSha)) {
        throw new Error("attempt has an invalid remote HEAD anchor");
    }
    if ((job.state === "publish_ready" || job.state === "awaiting_merge" || job.state === "done") && !job.headSha) {
        throw new Error(`${job.state} requires headSha`);
    }
    if (job.analyst && job.analyst.taskDigest !== job.task.digest) {
        throw new Error("analyst is bound to a different task digest");
    }
}
export function isBoundedText(value, max) {
    return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\u0000");
}
//# sourceMappingURL=model.js.map