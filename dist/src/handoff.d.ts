import { type AnalystAdvice, type Approval, type Attempt, type Incident, type Job, type ReviewerResult, type TypedHandoff } from "./model.js";
export declare function reviewChangesHandoff(input: {
    job: Job;
    attempt: Attempt;
    result: ReviewerResult;
    createdAt: string;
}): TypedHandoff;
export declare function approvedRecoveryHandoff(input: {
    job: Job;
    incident: Incident;
    analysis: AnalystAdvice;
    approval: Approval;
    createdAt: string;
}): TypedHandoff;
export declare function bindPendingHandoff(job: Job, attempt: Attempt): TypedHandoff | null;
