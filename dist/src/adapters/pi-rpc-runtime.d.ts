import { type AgentHandle, type Attempt, type AttemptResult } from "../model.js";
import type { AttemptRuntimePort, HerdrPort } from "../ports.js";
export declare class PiRpcRuntime implements AttemptRuntimePort {
    private readonly host;
    private readonly runnerPath;
    constructor(host: Pick<HerdrPort, "runInPane">, runnerPath?: string);
    startAgent(input: {
        handle: AgentHandle;
        attempt: Attempt;
        cwd: string;
        argv: string[];
    }): Promise<void>;
    prompt(input: {
        handle: AgentHandle;
        attempt: Attempt;
        dispatchId: string;
        skill: "implement" | "code-review";
        text: string;
    }): Promise<void>;
    wait(input: {
        handle: AgentHandle;
        attempt: Attempt;
        resultPath: string;
        expectedJobId: string;
        expectedAttemptId: string;
        expectedLane: Attempt["lane"];
    }): Promise<{
        agentStatus: "done" | "blocked";
        result: AttemptResult | null;
        diagnostic: string | null;
    }>;
    terminate(input: {
        handle: AgentHandle;
        attempt: Attempt;
        reason: "completed" | "recovery" | "cancelled";
    }): Promise<void>;
    private plan;
}
