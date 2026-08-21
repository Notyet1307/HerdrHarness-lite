import { reviewChangesHandoff } from "../handoff.js";
import { evolveJob, type AgentStatus, type Attempt, type AttemptResult, type HarnessState, type Job, type ReviewerResult, type WorkerResult } from "../model.js";
import { validateAttemptResult } from "../policy.js";
import { pathIsWithin } from "../path-safety.js";
import { makeSafeRuntimeDiagnostic } from "../pi-rpc-diagnostics.js";
import type { ControllerContext } from "./context.js";
import { reconcileAttemptOrBlock } from "./attempt-reconciliation.js";
import { verifyReviewerIntegrity } from "./attempt-integrity.js";
import { verifyBoundReviewerValidation } from "./reviewer-validation.js";
import { message, result, settleAttempt, withHerdrDiagnostic } from "./helpers.js";
import type { TickResult } from "./types.js";

export async function finishObservedAttempt(
  ctx: ControllerContext,
  state: HarnessState,
  job: Job,
  attempt: Attempt,
  observation: { agentStatus: AgentStatus; result: AttemptResult | null; diagnostic: string | null },
): Promise<TickResult> {
  if (attempt.lane === "reviewer") {
    const validationBlock = await verifyBoundReviewerValidation(ctx, state, job, attempt);
    if (validationBlock) return validationBlock;
    const reportedHeadSha = observation.result?.lane === "reviewer"
      ? (observation.result.reviewedHeadSha ?? null)
      : null;
    const integrityBlock = await verifyReviewerIntegrity(ctx, state, job, attempt, reportedHeadSha, observation.result);
    if (integrityBlock) return integrityBlock;
  }

  const validated = validateAttemptResult(job.id, attempt, observation.result);
  if (!validated.ok) {
    const summary = withHerdrDiagnostic(validated.reason, observation.diagnostic);
    const runtimeDiagnostic = resultDiagnostic(observation.result === null ? "result_missing" : "result_identity");
    if (observation.result === null && observation.agentStatus !== "blocked") {
      return reconcileAttemptOrBlock(ctx, state, job, attempt, summary, runtimeDiagnostic);
    }
    return ctx.block(state, job, {
      class: observation.agentStatus === "blocked"
        ? "agent_blocked"
        : "integrity_violation",
      lane: attempt.lane,
      summary,
      attemptResult: observation.result,
      runtimeDiagnostic,
    });
  }
  if (attempt.lane === "worker") {
    return finishWorker(ctx, state, job, attempt, validated.result as WorkerResult, observation.diagnostic);
  }
  return finishReviewer(ctx, state, job, attempt, validated.result as ReviewerResult, observation.diagnostic);
}

export async function finishWorker(
  ctx: ControllerContext,
  state: HarnessState,
  job: Job,
  attempt: Attempt,
  worker: WorkerResult,
  diagnostic: string | null,
): Promise<TickResult> {
  if (worker.status === "blocked") {
    return ctx.block(state, job, {
      class: "agent_decision",
      lane: "worker",
      summary: withHerdrDiagnostic(worker.summary, diagnostic),
      attemptResult: worker,
    });
  }
  if (worker.status === "failed") {
    return ctx.block(state, job, {
      class: "agent_blocked",
      lane: "worker",
      summary: withHerdrDiagnostic(worker.summary, diagnostic),
      attemptResult: worker,
    });
  }
  if (!worker.headSha || !job.worktree) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "worker",
      summary: "worker completion lacks verifiable Git provenance",
      attemptResult: worker,
      runtimeDiagnostic: resultDiagnostic("result_identity"),
    });
  }

  const verification = await ctx.deps.git.verifyWorker({
    worktree: job.worktree,
    branch: job.branch,
    baseSha: attempt.baseSha,
    reportedHeadSha: worker.headSha,
    expectedRemoteHeadSha: attempt.expectedRemoteHeadSha ?? null,
    allowedResultPaths: [...job.attempts.map((settled) => settled.resultPath), attempt.resultPath]
      .filter((path) => pathIsWithin(job.worktree!.path, path)),
  });
  if (!verification.ok) {
    return ctx.block(state, job, {
      class: verification.class,
      lane: "worker",
      summary: verification.reason,
      attemptResult: worker,
      runtimeDiagnostic: gitDiagnostic(),
    });
  }

  const cleanup = await closeCompletedAttempt(ctx, job, attempt);
  if (cleanup) return cleanup;

  const settled = settleAttempt(attempt, worker, ctx.deps.clock.now());
  const next = evolveJob(job, ctx.deps.clock.now(), {
    state: "reviewer_ready",
    headSha: verification.headSha,
    activeAttempt: null,
    attempts: [...job.attempts, settled],
    pendingHandoff: null,
    lastError: null,
  });
  await ctx.saveJob(state, job, next);
  return result(true, "attempt_completed", job.id, `worker completed at ${verification.headSha}; fresh review required`);
}

export async function finishReviewer(
  ctx: ControllerContext,
  state: HarnessState,
  job: Job,
  attempt: Attempt,
  review: ReviewerResult,
  diagnostic: string | null,
): Promise<TickResult> {
  if (review.status === "blocked" || review.status === "failed") {
    return ctx.block(state, job, {
      class: "review_uncertain",
      lane: "reviewer",
      summary: withHerdrDiagnostic(review.summary, diagnostic),
      attemptResult: review,
    });
  }
  if (!job.worktree || !job.headSha || !review.reviewedHeadSha) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "reviewer",
      summary: "review result lacks a bound implementation HEAD",
      attemptResult: review,
      runtimeDiagnostic: resultDiagnostic("result_identity"),
    });
  }
  const settled = settleAttempt(attempt, review, ctx.deps.clock.now());
  if (review.status === "pass") {
    const cleanup = await closeCompletedAttempt(ctx, job, attempt);
    if (cleanup) return cleanup;
    const next = evolveJob(job, ctx.deps.clock.now(), {
      state: "publish_ready",
      activeAttempt: null,
      attempts: [...job.attempts, settled],
      reviewRound: attempt.round,
      lastError: null,
    });
    await ctx.saveJob(state, job, next);
    return result(true, "attempt_completed", job.id, `independent review passed at round ${attempt.round}`);
  }

  if (review.findings.length === 0) {
    return ctx.block(state, job, {
      class: "review_uncertain",
      lane: "reviewer",
      summary: "review requested changes without actionable findings",
      attemptResult: review,
    });
  }
  if (attempt.round >= job.maxReviewRounds) {
    return ctx.block(state, job, {
      class: "review_uncertain",
      lane: "reviewer",
      summary: `review rounds exhausted at ${attempt.round}: ${review.summary}`,
      attemptResult: review,
    });
  }

  const cleanup = await closeCompletedAttempt(ctx, job, attempt);
  if (cleanup) return cleanup;

  const pendingHandoff = reviewChangesHandoff({
    job,
    attempt,
    result: review,
    createdAt: ctx.deps.clock.now(),
  });
  const next = evolveJob(job, ctx.deps.clock.now(), {
    state: "worker_ready",
    activeAttempt: null,
    attempts: [...job.attempts, settled],
    reviewRound: attempt.round,
    pendingHandoff,
    lastError: review.summary,
  });
  await ctx.saveJob(state, job, next);
  return result(true, "attempt_completed", job.id, "review findings routed to a fresh worker attempt");
}

export async function closeCompletedAttempt(ctx: ControllerContext, job: Job, attempt: Attempt): Promise<TickResult | null> {
  if (!attempt.handle) {
    return result(false, "attempt_completed", job.id, `${attempt.lane} pane identity is missing; completion was not recorded`);
  }
  try {
    await ctx.closeAttempt(attempt, "completed");
    return null;
  } catch (error) {
    return result(false, "attempt_completed", job.id, `${attempt.lane} pane close is not confirmed: ${message(error)}`);
  }
}

function resultDiagnostic(code: "result_missing" | "result_identity") {
  return makeSafeRuntimeDiagnostic({
    domain: "acceptance",
    code,
    stage: "result-validation",
    failureDomain: "result",
    failureCode: code,
    retryable: false,
  });
}

function gitDiagnostic() {
  return makeSafeRuntimeDiagnostic({
    domain: "acceptance",
    code: "git_integrity",
    stage: "git-verification",
    failureDomain: "git",
    failureCode: "git_integrity",
    retryable: false,
  });
}
