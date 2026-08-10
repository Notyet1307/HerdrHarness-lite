import type { Attempt, AttemptResult, AnalystAdvice, Approval, AutomaticRecoveryCandidate, BlockClass, EvidencePack, HarnessState, Incident, Job, JobState, RecoveryAction } from "./model.js";
import type { Clock, IdGenerator } from "./ports.js";
export declare function allowedActionsFor(blockClass: BlockClass, lane: Incident["lane"]): RecoveryAction[];
export declare function automaticRecoveryCandidateForAttempt(job: Job, attempt: Attempt): AutomaticRecoveryCandidate | undefined;
export declare function automaticRecoveryFor(job: Job, advice: AnalystAdvice): (AutomaticRecoveryCandidate & {
    action: Exclude<RecoveryAction, "hold">;
    attemptId: string;
}) | null;
export declare function isAutomaticRecoveryApproval(job: Job, approval: Approval): boolean;
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
export declare function projectOperatorState(state: HarnessState): OperatorProjection;
export declare function operatorActionsFor(job: Job): OperatorAction[];
export declare function reassessmentClassFor(job: Job): BlockClass | null;
/** Exact evidence boundary for a maintainer resolving an exhausted Reviewer architecture decision. */
export declare function isDecisionResolutionEligible(job: Job): boolean;
export declare function isControllerAnalystFailure(advice: AnalystAdvice): boolean;
export declare function makeIncident(input: {
    jobId: string;
    jobRevision: number;
    lane: Incident["lane"];
    attemptId: string | null;
    blockClass: BlockClass;
    summary: string;
    automaticRecovery?: AutomaticRecoveryCandidate;
    clock: Clock;
    ids: IdGenerator;
}): Incident;
export declare function validateAttemptResult(jobId: string, attempt: Attempt, result: AttemptResult | null): {
    ok: true;
    result: AttemptResult;
} | {
    ok: false;
    reason: string;
};
export declare function buildEvidencePack(input: {
    incident: Incident;
    jobId: string;
    jobRevision: number;
    taskDigest: string;
    items: EvidencePack["items"];
    missing: string[];
}): EvidencePack;
