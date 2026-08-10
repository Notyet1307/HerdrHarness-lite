import { type AgentHandle, type ExecutionSnapshot } from "./model.js";
export type PiRpcPlan = {
    version: 1;
    attemptId: string;
    generation: string;
    planDigest: string;
    promptDigest: string;
    handle: AgentHandle;
    cwd: string;
    resultPath: string;
    runtimeRoot: string;
    snapshot: ExecutionSnapshot & {
        adapter: "pi-rpc";
    };
};
export declare function rpcRuntimeRoot(snapshot: ExecutionSnapshot): string;
export declare function rpcGeneration(attemptId: string, planDigest: string, handle: AgentHandle): string;
export declare function spoolPath(root: string, name: string): string;
export declare function ensurePrivateDirectory(path: string): void;
export declare function preparePiRpcAgentDir(snapshot: ExecutionSnapshot): string;
export declare function piRpcAgentDir(snapshot: ExecutionSnapshot): string;
export declare function preparePiRpcAgentDirAt(isolated: string): string;
export declare function writeExclusiveJson(path: string, value: unknown): void;
export declare function writeAtomicJson(path: string, value: unknown): void;
export declare function readJson<T>(path: string): T;
export declare function readJsonIfExists<T>(path: string): T | null;
export declare function sameJson(left: unknown, right: unknown): boolean;
