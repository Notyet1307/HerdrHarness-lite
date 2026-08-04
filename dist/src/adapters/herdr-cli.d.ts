import type { AgentHandle, AgentStatus, AttemptResult, WorktreeHandle } from "../model.js";
import type { HerdrPort } from "../ports.js";
import { type CommandRunner } from "./command.js";
/**
 * Thin Herdr adapter. It intentionally uses Herdr's native worktree/tab/agent
 * primitives instead of reproducing pane discovery and lifecycle polling.
 */
export declare class HerdrCli implements HerdrPort {
    private readonly runner;
    private readonly bin;
    private readonly session;
    constructor(options: {
        bin?: string;
        session: string;
        runner?: CommandRunner;
    });
    createWorktree(input: {
        sourcePath: string;
        branch: string;
        baseRef: string;
        path: string;
        label: string;
    }): Promise<WorktreeHandle>;
    createAttemptPane(input: {
        worktree: WorktreeHandle;
        attempt: {
            id: string;
            lane: "worker" | "reviewer";
        };
    }): Promise<AgentHandle>;
    private findAttemptPane;
    startAgent(input: {
        handle: AgentHandle;
        argv: string[];
    }): Promise<void>;
    prompt(input: {
        handle: AgentHandle;
        dispatchId: string;
        skill: "implement" | "code-review";
        text: string;
    }): Promise<void>;
    wait(input: {
        handle: AgentHandle;
        resultPath: string;
        expectedJobId: string;
        expectedAttemptId: string;
        expectedLane: "worker" | "reviewer";
    }): Promise<{
        agentStatus: AgentStatus;
        result: AttemptResult | null;
        diagnostic: string | null;
    }>;
    close(handle: AgentHandle): Promise<void>;
    private tryGetAgent;
    private inspectAgent;
    private invoke;
    private args;
}
