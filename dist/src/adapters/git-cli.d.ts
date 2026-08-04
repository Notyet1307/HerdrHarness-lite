import type { GitPort, ReviewerVerification, WorkerVerification } from "../ports.js";
import { type CommandRunner } from "./command.js";
export declare class GitCli implements GitPort {
    private readonly runner;
    constructor(runner?: CommandRunner);
    refreshBase(localPath: string, baseRef: string): Promise<string>;
    verifyWorker(input: {
        worktree: {
            path: string;
            branch: string;
            workspaceId: string;
        };
        branch: string;
        baseSha: string;
        reportedHeadSha: string;
    }): Promise<WorkerVerification>;
    verifyReviewer(input: {
        worktree: {
            path: string;
            branch: string;
            workspaceId: string;
        };
        expectedHeadSha: string;
        reportedHeadSha: string | null;
        allowedResultPaths: string[];
    }): Promise<ReviewerVerification>;
    private git;
}
