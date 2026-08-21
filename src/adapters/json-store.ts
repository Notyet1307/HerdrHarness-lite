import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { assertJobInvariant, type HarnessState } from "../model.js";
import type { StateStore } from "../ports.js";

const EMPTY_STATE: HarnessState = { version: 1, activeJob: null, terminalJobs: [] };

/** Single-process/single-host durable store with CAS and an append-only audit log. */
export class JsonStateStore implements StateStore {
  private readonly statePath: string;
  private readonly eventPath: string;
  private readonly degradationPath: string;
  private readonly lockPath: string;

  constructor(private readonly stateDir: string) {
    this.statePath = join(stateDir, "state.json");
    this.eventPath = join(stateDir, "events.jsonl");
    this.degradationPath = join(stateDir, "events.degraded.json");
    this.lockPath = join(stateDir, "controller.lock");
  }

  async load(): Promise<HarnessState> {
    mkdirSync(this.stateDir, { recursive: true });
    if (!existsSync(this.statePath)) return JSON.parse(JSON.stringify(EMPTY_STATE)) as HarnessState;
    const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as HarnessState;
    validateState(parsed);
    return parsed;
  }

  async save(next: HarnessState, expectedActiveRevision: number | null): Promise<void> {
    mkdirSync(this.stateDir, { recursive: true });
    let fd: number;
    try {
      fd = openSync(this.lockPath, "wx", 0o600);
    } catch {
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

      // state.json is the authority. Once the atomic rename succeeds, an audit
      // append failure must not tell the Controller that the transition rolled
      // back and thereby invite replay of an external side effect.
      try {
        appendFileSync(
          this.eventPath,
          `${JSON.stringify({
            savedAt: new Date().toISOString(),
            expectedActiveRevision,
            activeJobId: next.activeJob?.id ?? null,
            activeRevision: next.activeJob?.revision ?? null,
            activeState: next.activeJob?.state ?? null,
          })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } catch (error) {
        try {
          writeFileSync(this.degradationPath, `${JSON.stringify({
            version: 1,
            stateCommittedAt: new Date().toISOString(),
            auditAppendError: error instanceof Error ? error.message : String(error),
          }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        } catch {
          // The authoritative transition is already committed. The Controller
          // must continue from state.json rather than replaying it.
        }
      }
    } finally {
      closeSync(fd);
      try {
        unlinkSync(this.lockPath);
      } catch {
        // A stale lock is safer than silently allowing two writers.
      }
    }
  }
}

function validateState(state: HarnessState): void {
  if (state.version !== 1 || !Array.isArray(state.terminalJobs)) throw new Error("invalid Harness state");
  if (state.activeJob) assertJobInvariant(state.activeJob);
}
