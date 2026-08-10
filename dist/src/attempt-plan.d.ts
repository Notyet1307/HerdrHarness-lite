import { type Attempt, type AttemptRuntimeAdapter, type ExecutionContext, type ExecutionSnapshot } from "./model.js";
export declare function buildExecutionSnapshot(input: {
    adapter: AttemptRuntimeAdapter;
    executable: string;
    runtimeVersion: string;
    argv: string[];
    retryMode?: ExecutionSnapshot["retryMode"];
    compactionMode?: ExecutionSnapshot["compactionMode"];
    dockerHost?: string | null;
    context?: ExecutionContext;
    extraResources?: Array<{
        kind: "agent" | "runtime";
        path: string;
    }>;
}): ExecutionSnapshot;
export declare function attemptPlanDigest(attempt: Attempt): string;
export declare function executionPlanMatches(attempt: Attempt): boolean;
export declare function executionResourceDigest(path: string): string;
