import { type EvidenceItem, type EvidenceRequest, type Job } from "../model.js";
import type { EvidencePort } from "../ports.js";
import { type CommandRunner } from "./command.js";
/** Read-only, bounded evidence collector. It never executes Analyst-supplied shell. */
export declare class LocalEvidence implements EvidencePort {
    private readonly runner;
    private readonly stateDir;
    constructor(runner?: CommandRunner, stateDir?: string | null);
    initial(job: Job): Promise<{
        items: EvidenceItem[];
        missing: string[];
    }>;
    collect(job: Job, requests: EvidenceRequest[]): Promise<EvidenceItem[]>;
    private collectOne;
    private runGit;
    private worktreeProgress;
    private attemptRuntime;
    private attemptHistory;
    private controllerHealth;
    private runtimeDirectory;
}
