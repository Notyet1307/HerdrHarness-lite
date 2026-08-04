import type { Attempt, AttemptResult, BlockClass, EvidencePack, Incident, RecoveryAction } from "./model.js";
import type { Clock, IdGenerator } from "./ports.js";
export declare function allowedActionsFor(blockClass: BlockClass): RecoveryAction[];
export declare function makeIncident(input: {
    jobId: string;
    jobRevision: number;
    lane: Incident["lane"];
    attemptId: string | null;
    blockClass: BlockClass;
    summary: string;
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
