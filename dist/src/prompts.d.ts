import type { Attempt, Job } from "./model.js";
export declare function workerPrompt(job: Job, attempt: Attempt): string;
export declare function reviewerPrompt(job: Job, attempt: Attempt): string;
