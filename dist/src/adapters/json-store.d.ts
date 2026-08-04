import { type HarnessState } from "../model.js";
import type { StateStore } from "../ports.js";
/** Single-process/single-host durable store with CAS and an append-only audit log. */
export declare class JsonStateStore implements StateStore {
    private readonly stateDir;
    private readonly statePath;
    private readonly eventPath;
    private readonly lockPath;
    constructor(stateDir: string);
    load(): Promise<HarnessState>;
    save(next: HarnessState, expectedActiveRevision: number | null): Promise<void>;
}
