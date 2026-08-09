#!/usr/bin/env node
import { type PiRpcPlan } from "./pi-rpc-spool.js";
type JsonObject = Record<string, unknown>;
export declare class StrictJsonlDecoder {
    private buffer;
    push(chunk: string): JsonObject[];
    finish(): void;
}
export declare function validateInitialState(response: JsonObject, plan: PiRpcPlan): void;
export {};
