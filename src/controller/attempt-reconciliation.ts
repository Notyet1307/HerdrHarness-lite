import { automaticRecoveryCandidateForAttempt } from "../policy.js";
import { evolveJob, MAX_ATTEMPT_RECONCILIATIONS, type Attempt, type HarnessState, type Job } from "../model.js";
import type { SafeRuntimeDiagnostic } from "../pi-rpc-diagnostics.js";
import type { ControllerContext } from "./context.js";
import { result } from "./helpers.js";
import type { TickResult } from "./types.js";

export async function reconcileAttemptOrBlock(
  ctx: ControllerContext,
  state: HarnessState,
  job: Job,
  attempt: Attempt,
  summary: string,
  runtimeDiagnostic: SafeRuntimeDiagnostic | null = null,
): Promise<TickResult> {
  const retries = attempt.reconciliationAttempts ?? 0;
  if (retries >= MAX_ATTEMPT_RECONCILIATIONS) {
    const automaticRecovery = automaticRecoveryCandidateForAttempt(job, attempt);
    return ctx.block(state, job, {
      class: "infrastructure_exhausted",
      lane: attempt.lane,
      summary,
      attemptResult: null,
      ...(runtimeDiagnostic ? { runtimeDiagnostic } : {}),
      ...(automaticRecovery ? { automaticRecovery } : {}),
    });
  }
  const next = evolveJob(job, ctx.deps.clock.now(), {
    activeAttempt: { ...attempt, reconciliationAttempts: retries + 1 },
    lastError: summary,
  });
  await ctx.saveJob(state, job, next);
  return result(true, "attempt_reconciling", job.id, `${summary}; observing the same attempt once more`);
}
