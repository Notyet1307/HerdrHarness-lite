import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { assertJobInvariant } from "../model.js";
const EMPTY_STATE = { version: 1, activeJob: null, terminalJobs: [] };
/** Single-process/single-host durable store with CAS and an append-only audit log. */
export class JsonStateStore {
    stateDir;
    statePath;
    eventPath;
    lockPath;
    constructor(stateDir) {
        this.stateDir = stateDir;
        this.statePath = join(stateDir, "state.json");
        this.eventPath = join(stateDir, "events.jsonl");
        this.lockPath = join(stateDir, "controller.lock");
    }
    async load() {
        mkdirSync(this.stateDir, { recursive: true });
        if (!existsSync(this.statePath))
            return JSON.parse(JSON.stringify(EMPTY_STATE));
        const parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
        validateState(parsed);
        return parsed;
    }
    async save(next, expectedActiveRevision) {
        mkdirSync(this.stateDir, { recursive: true });
        let fd;
        try {
            fd = openSync(this.lockPath, "wx", 0o600);
        }
        catch {
            throw new Error(`controller lock is held: ${this.lockPath}`);
        }
        try {
            const current = await this.load();
            const currentRevision = current.activeJob?.revision ?? null;
            if (currentRevision !== expectedActiveRevision) {
                throw new Error(`state CAS failed: expected revision ${expectedActiveRevision}, current ${currentRevision}`);
            }
            validateState(next);
            const temp = `${this.statePath}.tmp`;
            writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
            renameSync(temp, this.statePath);
            appendFileSync(this.eventPath, `${JSON.stringify({
                savedAt: new Date().toISOString(),
                expectedActiveRevision,
                activeJobId: next.activeJob?.id ?? null,
                activeRevision: next.activeJob?.revision ?? null,
                activeState: next.activeJob?.state ?? null,
            })}\n`, { encoding: "utf8", mode: 0o600 });
        }
        finally {
            closeSync(fd);
            try {
                unlinkSync(this.lockPath);
            }
            catch {
                // A stale lock is safer than silently allowing two writers.
            }
        }
    }
}
function validateState(state) {
    if (state.version !== 1 || !Array.isArray(state.terminalJobs))
        throw new Error("invalid Harness state");
    if (state.activeJob)
        assertJobInvariant(state.activeJob);
}
//# sourceMappingURL=json-store.js.map