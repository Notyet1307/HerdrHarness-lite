import type { Approval } from "./model.js";
import type { Clock, IdGenerator, StateStore } from "./ports.js";
export type ApprovalRequest = {
    expectedRevision: number;
    incidentId: string;
    analysisId: string;
    actor: string;
    reason: string;
};
/** Human gate: records authority, but never talks to an old agent or mutates Git. */
export declare function approveRecovery(store: StateStore, request: ApprovalRequest, dependencies: {
    clock: Clock;
    ids: IdGenerator;
}): Promise<Approval>;
