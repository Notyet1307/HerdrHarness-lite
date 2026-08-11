import { evolveJob, isBoundedText, isRetryAction } from "./model.js";
import { makeIncident, operatorActionsFor, reassessmentClassFor } from "./policy.js";
/** Human gate: retires one exact held pre-PR job without weakening its incident. */
export async function cancelHeldJob(store, request, dependencies) {
    if (!isBoundedText(request.actor, 512))
        throw new Error("cancellation actor is required and bounded");
    if (!isBoundedText(request.reason, 2_000))
        throw new Error("cancellation reason is required and bounded");
    const state = await store.load();
    const job = state.activeJob;
    if (!job)
        throw new Error("no active job");
    if (job.revision !== request.expectedRevision) {
        throw new Error(`stale job revision: expected ${request.expectedRevision}, current ${job.revision}`);
    }
    if (job.state !== "blocked" || !job.incident)
        throw new Error("job is not an exact blocked job");
    if (job.incident.id !== request.incidentId)
        throw new Error("incident changed before cancellation");
    if (!job.analysis || job.analysis.id !== request.analysisId)
        throw new Error("analysis changed before cancellation");
    if (!operatorActionsFor(job).some((action) => action.kind === "cancel")) {
        throw new Error("only the exact active Analyst hold can be cancelled");
    }
    const createdAt = dependencies.clock.now();
    const cancellation = {
        id: dependencies.ids.next("cancellation"),
        jobRevision: job.revision,
        incidentId: job.incident.id,
        analysisId: job.analysis.id,
        actor: request.actor,
        reason: request.reason,
        createdAt,
    };
    await store.save({
        ...state,
        activeJob: evolveJob(job, createdAt, { state: "cancelled", cancellation }),
    }, job.revision);
    return cancellation;
}
/** Human gate: records authority, but never talks to an old agent or mutates Git. */
export async function approveRecovery(store, request, dependencies) {
    if (!isBoundedText(request.actor, 512))
        throw new Error("approval actor is required and bounded");
    if (!isBoundedText(request.reason, 2_000))
        throw new Error("approval reason is required and bounded");
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
    const option = operatorActionsFor(job).find((action) => action.kind === "approve_retry");
    if (!option || option.effect !== job.analysis.action) {
        throw new Error(`incident class ${job.incident.class} forbids ${job.analysis.action}`);
    }
    const now = dependencies.clock.now();
    const approval = {
        id: dependencies.ids.next("approval"),
        jobRevision: job.revision,
        incidentId: job.incident.id,
        analysisId: job.analysis.id,
        action: job.analysis.action,
        basis: "analyst_advice",
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
/** Human gate for one narrow case: a maintainer resolves an exhausted Reviewer architecture decision. */
export async function resolveDecision(store, request, dependencies) {
    if (!isBoundedText(request.actor, 512))
        throw new Error("decision actor is required and bounded");
    if (!isBoundedText(request.reason, 2_000))
        throw new Error("decision reason is required and bounded");
    const state = await store.load();
    const job = state.activeJob;
    if (!job)
        throw new Error("no active job");
    if (job.revision !== request.expectedRevision) {
        throw new Error(`stale job revision: expected ${request.expectedRevision}, current ${job.revision}`);
    }
    if (job.state !== "blocked" || !job.incident)
        throw new Error("job is not awaiting a decision resolution");
    if (job.incident.id !== request.incidentId)
        throw new Error("incident changed before decision resolution");
    if (!job.analysis || job.analysis.id !== request.analysisId)
        throw new Error("analysis changed before decision resolution");
    if (!operatorActionsFor(job).some((action) => action.kind === "resolve_decision")) {
        throw new Error("job is not eligible for decision resolution");
    }
    const now = dependencies.clock.now();
    const approval = {
        id: dependencies.ids.next("approval"),
        jobRevision: job.revision,
        incidentId: job.incident.id,
        analysisId: job.analysis.id,
        action: "retry_fresh_worker",
        basis: "human_decision",
        actor: request.actor,
        reason: request.reason,
        createdAt: now,
        consumedAt: null,
    };
    await store.save({
        ...state,
        activeJob: evolveJob(job, now, {
            state: "recovery_approved",
            approval,
            lastError: null,
        }),
    }, job.revision);
    return approval;
}
/** Human gate: requests new analysis after a hold, but grants no retry authority. */
export async function reassessIncident(store, request, dependencies) {
    if (!isBoundedText(request.actor, 512))
        throw new Error("reassessment actor is required and bounded");
    if (!isBoundedText(request.reason, 2_000))
        throw new Error("reassessment reason is required and bounded");
    const state = await store.load();
    const job = state.activeJob;
    if (!job)
        throw new Error("no active job");
    if (job.revision !== request.expectedRevision) {
        throw new Error(`stale job revision: expected ${request.expectedRevision}, current ${job.revision}`);
    }
    if (job.state !== "blocked" || !job.incident)
        throw new Error("job is not awaiting reassessment");
    if (job.incident.id !== request.incidentId)
        throw new Error("incident changed before reassessment");
    if (!job.analysis || job.analysis.id !== request.analysisId)
        throw new Error("analysis changed before reassessment");
    if (job.analysis.incidentId !== job.incident.id)
        throw new Error("analysis is not bound to the active incident");
    const replacementClass = reassessmentClassFor(job);
    if (!replacementClass || !operatorActionsFor(job).some((action) => action.kind === "reassess")) {
        throw new Error("only an exact held infrastructure incident, HEAD-bound Reviewer block, pre-start Reviewer residue, pre-fix Worker HEAD-report mismatch, controller-recorded Analyst execution failure, or HEAD-bound CI incident within the rework limit can be reassessed");
    }
    const successor = makeIncident({
        jobId: job.id,
        jobRevision: job.revision + 1,
        lane: job.incident.lane,
        attemptId: job.incident.attemptId,
        blockClass: replacementClass,
        ...(job.incident.runtimeDiagnostic ? { runtimeDiagnostic: job.incident.runtimeDiagnostic } : {}),
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
    const reassessment = {
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
//# sourceMappingURL=recovery.js.map