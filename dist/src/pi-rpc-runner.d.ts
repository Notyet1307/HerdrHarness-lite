#!/usr/bin/env node
import { type PiRpcPlan } from "./pi-rpc-spool.js";
import { type PiRpcProviderApi } from "./pi-rpc-diagnostics.js";
type JsonObject = Record<string, unknown>;
export declare class StrictJsonlDecoder {
    private buffer;
    push(chunk: string, onRecord?: (record: JsonObject) => void): JsonObject[];
    finish(): void;
}
export declare function validateInitialState(response: JsonObject, plan: PiRpcPlan): PiRpcProviderApi;
export {};
