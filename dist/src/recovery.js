import { evolveJob, isRetryAction } from "./model.js";
import { allowedActionsFor } from "./policy.js";
/** Human gate: records authority, but never talks to an old agent or mutates Git. */
export async function approveRecovery(store, request, dependencies) {
    if (!request.actor.trim())
        throw new Error("approval actor is required");
    if (!request.reason.trim())
        throw new Error("approval reason is required");
    const state = await store.load();
    const job = state.activeJob;
    if (!job)
        throw new Error("no active job");
    if (job.revision !== request.expectedRevision) {
        throw new Error(`stale job revision: expected ${request.expectedRevision}, current ${job.revision}`);
    }
    if (job.state !== "blocked" || !job.incident)
        throw new Error("job is not awaiting a recovery decision");
    if (job.incident.id !== request.incidentId)
        throw new Error("incident changed before approval");
    if (!job.analysis)
        throw new Error("no ready analyst advice");
    if (job.analysis.id !== request.analysisId)
        throw new Error("analysis changed before approval");
    if (job.analysis.incidentId !== job.incident.id)
        throw new Error("analysis is not bound to the active incident");
    if (!isRetryAction(job.analysis.action))
        throw new Error("analyst did not recommend retry");
    if (!job.incident.allowedActions.includes(job.analysis.action) ||
        !allowedActionsFor(job.incident.class, job.incident.lane).includes(job.analysis.action)) {
        throw new Error(`incident class ${job.incident.class} forbids ${job.analysis.action}`);
    }
    const now = dependencies.clock.now();
    const approval = {
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
    const next = { ...state, activeJob: nextJob };
    await store.save(next, job.revision);
    return approval;
}
//# sourceMappingURL=recovery.js.map