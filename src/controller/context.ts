import { dirname, resolve } from "node:path";
import { assertJobInvariant, evolveJob, type Attempt, type AttemptResult, type AutomaticRecoveryCandidate, type CiFailure, type HarnessState, type Incident, type Job } from "../model.js";
import { makeIncident } from "../policy.js";
import type { AttemptRuntimePort } from "../ports.js";
import type { SafeRuntimeDiagnostic } from "../pi-rpc-diagnostics.js";
import { result } from "./helpers.js";
import type { ControllerDependencies, TickResult } from "./types.js";

export type BlockInput = {
  class: Incident["class"];
  lane: Incident["lane"];
  summary: string;
  attemptResult: AttemptResult | null;
  ciFailure?: CiFailure;
  automaticRecovery?: AutomaticRecoveryCandidate;
  runtimeDiagnostic?: SafeRuntimeDiagnostic;
};

export class ControllerContext {
  constructor(readonly deps: ControllerDependencies) {}

  async block(state: HarnessState, job: Job, input: BlockInput): Promise<TickResult> {
    const now = this.deps.clock.now();
    const activeAttempt = job.activeAttempt
      ? {
          ...job.activeAttempt,
          phase: "settled" as const,
          result: input.attemptResult,
          completedAt: now,
        }
      : null;
    const incident = makeIncident({
      jobId: job.id,
      jobRevision: job.revision + 1,
      lane: input.lane,
      attemptId: activeAttempt?.id ?? null,
      blockClass: input.class,
      summary: input.summary,
      ...(input.automaticRecovery ? { automaticRecovery: input.automaticRecovery } : {}),
      ...(input.runtimeDiagnostic ? { runtimeDiagnostic: input.runtimeDiagnostic } : {}),
      clock: this.deps.clock,
      ids: this.deps.ids,
    });
    const next = evolveJob(job, now, {
      state: "blocked",
      activeAttempt,
      incident,
      analysis: null,
      approval: null,
      ...(input.ciFailure ? { ciFailure: input.ciFailure } : {}),
      lastError: input.summary,
    });
    await this.saveJob(state, job, next);
    return result(false, "blocked", job.id, `${input.class}: ${input.summary}`);
  }

  async saveJob(state: HarnessState, current: Job, next: Job): Promise<void> {
    assertJobInvariant(next);
    await this.deps.store.save({ ...state, activeJob: next }, current.revision);
  }

  runtimeFor(attempt: Attempt): AttemptRuntimePort {
    if (attempt.executionSnapshot?.adapter === "pi-rpc") {
      if (!this.deps.piRpc) throw new Error("Pi RPC adapter is unavailable");
      return this.deps.piRpc;
    }
    return this.deps.herdr;
  }

  attemptCwd(job: Job, attempt: Attempt): string {
    if (!job.worktree) throw new Error("attempt has no worktree cwd");
    return attempt.lane === "worker" ? job.worktree.path : resolve(dirname(attempt.resultPath), "workspace", "source");
  }

  async closeAttempt(attempt: Attempt, reason: "completed" | "recovery" | "cancelled"): Promise<void> {
    if (!attempt.handle) throw new Error("attempt has no pane identity");
    const runtime = this.runtimeFor(attempt);
    if (runtime.terminate) await runtime.terminate({ handle: attempt.handle, attempt, reason });
    await this.deps.herdr.close(attempt.handle);
  }
}
