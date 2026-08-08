import type { Approval, Cancellation, Reassessment } from "./model.js";
import type { Clock, IdGenerator, StateStore } from "./ports.js";
export type ApprovalRequest = {
    expectedRevision: number;
    incidentId: string;
    analysisId: string;
    actor: string;
    reason: string;
};
export type ReassessmentRequest = ApprovalRequest;
export type CancellationRequest = ApprovalRequest;
/** Human gate: retires one exact held pre-PR job without weakening its incident. */
export declare function cancelHeldJob(store: StateStore, request: CancellationRequest, dependencies: {
    clock: Clock;
    ids: IdGenerator;
}): Promise<Cancellation>;
/** Human gate: records authority, but never talks to an old agent or mutates Git. */
export declare function approveRecovery(store: StateStore, request: ApprovalRequest, dependencies: {
    clock: Clock;
    ids: IdGenerator;
}): Promise<Approval>;
/** Human gate for one narrow case: a maintainer resolves an exhausted Reviewer architecture decision. */
export declare function resolveDecision(store: StateStore, request: ApprovalRequest, dependencies: {
    clock: Clock;
    ids: IdGenerator;
}): Promise<Approval>;
/** Human gate: requests new analysis after a hold, but grants no retry authority. */
export declare function reassessIncident(store: StateStore, request: ReassessmentRequest, dependencies: {
    clock: Clock;
    ids: IdGenerator;
}): Promise<Reassessment>;
