#!/usr/bin/env node
type PiRpcEvent = Record<string, unknown>;
type ProjectableRuntime = {
    session: object;
};
/**
 * Projects content-heavy Pi lifecycle events onto the smaller Harness RPC
 * interface. Pi's in-memory session and extension subscribers retain the
 * original events; only the subscriber registered by runRpcMode sees these
 * bounded observations.
 */
export declare function withProjectedPiRpcEvents<T extends ProjectableRuntime>(runtime: T): T;
export declare function projectPiRpcEvent(event: PiRpcEvent): PiRpcEvent;
export {};
