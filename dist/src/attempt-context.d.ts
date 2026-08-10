import { type Attempt, type AttemptContextEnvelope, type ExecutionSnapshot, type Job, type TypedHandoff } from "./model.js";
export declare function buildAttemptContextEnvelope(input: {
    job: Job;
    attempt: Attempt;
    executionSnapshot: ExecutionSnapshot;
    handoff: TypedHandoff | null;
}): AttemptContextEnvelope;
