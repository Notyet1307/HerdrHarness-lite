import type { ExecutionContext, ExecutionResource } from "../model.js";
import type { BaseSyncVerification, GitPort, ReviewerVerification, WorkerVerification } from "../ports.js";
import { type CommandRunner } from "./command.js";
export declare class GitCli implements GitPort {
    private readonly runner;
    constructor(runner?: CommandRunner);
    refreshBase(localPath: string, baseRef: string): Promise<string>;
    syncBase(input: {
        worktree: {
            path: string;
            branch: string;
            workspaceId: string;
        };
        branch: string;
        baseRef: string;
        expectedHeadSha: string;
        expectedRemoteHeadSha: string | null;
        latestBaseSha: string;
    }): Promise<BaseSyncVerification>;
    verifyWorker(input: {
        worktree: {
            path: string;
            branch: string;
            workspaceId: string;
        };
        branch: string;
        baseSha: string;
        reportedHeadSha: string;
        expectedRemoteHeadSha: string | null;
        allowedResultPaths: string[];
    }): Promise<WorkerVerification>;
    prepareWorkerResult(input: {
        worktree: {
            path: string;
            branch: string;
            workspaceId: string;
        };
        rootPath: string;
        resultPath: string;
        jobId: string;
        attemptId: string;
    }): Promise<{
        descriptorPath: string;
    }>;
    prepareTrustedContext(input: {
        localPath: string;
        rootPath: string;
        trustAnchorSha: string;
        jobId: string;
        attemptId: string;
        lane: "worker" | "reviewer";
        agentDir: string;
    }): Promise<ExecutionContext>;
    verifyTrustedContext(context: ExecutionContext): Promise<void>;
    prepareReviewer(input: {
        worktree: {
            path: string;
            branch: string;
            workspaceId: string;
        };
        rootPath: string;
        resultPath: string;
        jobId: string;
        attemptId: string;
        baseSha: string;
        expectedHeadSha: string;
        validationArgv: string[];
        dockerHost: string | null;
        reviewAxisAgent: ExecutionResource;
        piExecutable: string;
        piRuntimeVersion: string;
    }): Promise<{
        reviewPath: string;
        descriptorPath: string;
        evidencePath: string;
    }>;
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
