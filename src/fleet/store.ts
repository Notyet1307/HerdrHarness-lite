import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FleetRuntimeState } from "./types.js";

export class FleetStateStore {
  readonly statePath: string;
  readonly eventPath: string;
  readonly degradationPath: string;

  constructor(readonly stateDir: string) {
    this.statePath = join(stateDir, "fleet-state.json");
    this.eventPath = join(stateDir, "fleet-events.jsonl");
    this.degradationPath = join(stateDir, "fleet-events.degraded.json");
  }

  load(): FleetRuntimeState | null {
    if (!existsSync(this.statePath)) return null;
    const value = JSON.parse(readFileSync(this.statePath, "utf8")) as FleetRuntimeState;
    validateFleetState(value);
    return value;
  }

  save(next: FleetRuntimeState, event: Record<string, unknown>): void {
    validateFleetState(next);
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, this.statePath);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* Preserve the state write error. */ }
      throw error;
    }
    try {
      appendFileSync(this.eventPath, `${JSON.stringify({ at: next.updatedAt, ...event })}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      try {
        writeFileSync(this.degradationPath, `${JSON.stringify({
          version: 1,
          stateCommittedAt: next.updatedAt,
          auditAppendError: error instanceof Error ? error.message : String(error),
        }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      } catch {
        // The authoritative Fleet state is already committed; never report it as rolled back.
      }
    }
  }
}

function validateFleetState(value: FleetRuntimeState): void {
  if (!value || value.version !== 1 || typeof value.configDigest !== "string" || !value.configDigest) {
    throw new Error("invalid Fleet runtime state");
  }
  if (!value.projects || typeof value.projects !== "object" || Array.isArray(value.projects)) {
    throw new Error("invalid Fleet project runtime state");
  }
  if (Object.values(value.projects).some((project) => (
    !project || typeof project !== "object" || typeof project.configDigest !== "string" || !project.configDigest
  ))) {
    throw new Error("invalid Fleet project config identity");
  }
}
