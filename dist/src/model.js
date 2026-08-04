import { createHash } from "node:crypto";
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
    if ((job.state === "publish_ready" || job.state === "awaiting_merge" || job.state === "done") && !job.headSha) {
        throw new Error(`${job.state} requires headSha`);
    }
    if (job.analyst && job.analyst.taskDigest !== job.task.digest) {
        throw new Error("analyst is bound to a different task digest");
    }
}
//# sourceMappingURL=model.js.map