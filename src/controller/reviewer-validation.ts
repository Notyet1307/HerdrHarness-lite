import { dirname } from "node:path";
import { attemptPlanDigest, executionPlanMatches } from "../attempt-plan.js";
import { digest, type Attempt, type HarnessState, type Job } from "../model.js";
import type { ReviewerValidationInput } from "../ports.js";
import { renderAttemptPrompt } from "../prompts.js";
import { ReviewerValidationIntegrityError, reviewerValidationResult } from "../reviewer-validation.js";
import { reviewerCheckpointIdentity } from "../reviewer-checkpoints.js";
import type { ControllerContext } from "./context.js";
import { message, validReviewerValidationArgv } from "./helpers.js";
import { verifyReviewerPreflight } from "./attempt-integrity.js";
import type { TickResult } from "./types.js";
import { DEFAULT_VALIDATION_TIMEOUT_MS, snapshotRuntimeTimeouts } from "../runtime-timeouts.js";

export async function ensureReviewerValidation(
  ctx: ControllerContext,
  state: HarnessState,
  job: Job,
  attempt: Attempt,
): Promise<
  | { ok: true; attempt: Attempt }
  | { ok: false; result: TickResult }
> {
  if (!validReviewerValidationArgv(attempt.reviewerValidationArgv)) {
    return {
      ok: false,
      result: await ctx.block(state, job, {
        class: "integrity_violation",
        lane: "reviewer",
        summary: "Reviewer attempt has no durably bound validation command",
        attemptResult: null,
      }),
    };
  }
  const integrityBlock = await verifyReviewerPreflight(ctx, state, job, attempt, attempt.expectedHeadSha, null);
  if (integrityBlock) return { ok: false, result: integrityBlock };

  try {
    const input = reviewerValidationInput(job, attempt);
    const output = attempt.reviewerValidationReceipt
      ? {
          binding: attempt.reviewerValidationReceipt,
          receipt: await ctx.deps.git.verifyReviewerValidation({ ...input, binding: attempt.reviewerValidationReceipt }),
        }
      : await ctx.deps.git.runReviewerValidation(input);
    const boundAttempt = { ...attempt, reviewerValidationReceipt: output.binding };
    const receiptResult = reviewerValidationResult(output.receipt);
    if (receiptResult.status === "infrastructure-error") {
      const boundJob = { ...job, activeAttempt: boundAttempt };
      return {
        ok: false,
        result: await ctx.block(state, boundJob, {
          class: "validation_infrastructure",
          lane: "reviewer",
          summary: receiptResult.error ?? "Reviewer validation infrastructure failed",
          attemptResult: null,
        }),
      };
    }
    const postValidationIntegrity = await verifyReviewerPreflight(
      ctx,
      state,
      { ...job, activeAttempt: boundAttempt },
      boundAttempt,
      boundAttempt.expectedHeadSha,
      null,
    );
    if (postValidationIntegrity) return { ok: false, result: postValidationIntegrity };
    return { ok: true, attempt: activateReviewerRuntime(boundAttempt, ctx.deps.clock.now()) };
  } catch (error) {
    const integrity = error instanceof ReviewerValidationIntegrityError;
    return {
      ok: false,
      result: await ctx.block(state, job, {
        class: integrity ? "integrity_violation" : "validation_infrastructure",
        lane: "reviewer",
        summary: `Reviewer validation ${integrity ? "receipt cannot be trusted" : "infrastructure failed"}: ${message(error)}`,
        attemptResult: null,
      }),
    };
  }
}

function activateReviewerRuntime(attempt: Attempt, now: string): Attempt {
  if (attempt.executionSnapshot?.runtimeDeadlineAt !== undefined) return attempt;
  if (attempt.lane !== "reviewer" || attempt.phase !== "prepared" || !attempt.reviewerValidationReceipt
    || !attempt.executionSnapshot || !attempt.contextEnvelope || !attempt.contextEnvelopeDigest
    || !executionPlanMatches(attempt) || attempt.contextEnvelopeDigest !== digest(attempt.contextEnvelope)
    || attempt.contextEnvelope.runtime.snapshotDigest !== digest(attempt.executionSnapshot)) {
    throw new ReviewerValidationIntegrityError("Reviewer runtime cannot be activated from an unbound validation Attempt");
  }
  const activatedAt = Date.parse(now);
  if (!Number.isFinite(activatedAt)) throw new ReviewerValidationIntegrityError("Reviewer runtime activation time is invalid");
  const runtimeDeadlineAt = new Date(
    activatedAt + snapshotRuntimeTimeouts(attempt.executionSnapshot, "reviewer").totalTimeoutMs,
  ).toISOString();
  const executionSnapshot = { ...attempt.executionSnapshot, runtimeDeadlineAt };
  const contextEnvelope = {
    ...attempt.contextEnvelope,
    runtime: {
      ...attempt.contextEnvelope.runtime,
      snapshotDigest: digest(executionSnapshot),
      runtimeDeadlineAt,
    },
  };
  let activated: Attempt = {
    ...attempt,
    executionSnapshot,
    contextEnvelope,
    contextEnvelopeDigest: digest(contextEnvelope),
  };
  activated = { ...activated, promptDigest: digest(renderAttemptPrompt(activated)) };
  return { ...activated, planDigest: attemptPlanDigest(activated) };
}

export async function verifyBoundReviewerValidation(
  ctx: ControllerContext,
  state: HarnessState,
  job: Job,
  attempt: Attempt,
): Promise<TickResult | null> {
  if (!attempt.reviewerValidationReceipt) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "reviewer",
      summary: "Reviewer started without a durable validation receipt",
      attemptResult: attempt.result,
    });
  }
  try {
    const receipt = await ctx.deps.git.verifyReviewerValidation({
      ...reviewerValidationInput(job, attempt),
      binding: attempt.reviewerValidationReceipt,
    });
    if (reviewerValidationResult(receipt).status === "infrastructure-error") throw new ReviewerValidationIntegrityError("infrastructure-error receipt cannot authorize Reviewer start");
    return null;
  } catch (error) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "reviewer",
      summary: `Reviewer validation receipt cannot be verified: ${message(error)}`,
      attemptResult: attempt.result,
    });
  }
}

export function reviewerValidationInput(job: Job, attempt: Attempt): ReviewerValidationInput {
  const reused = attempt.reviewerCheckpointInputs?.find((binding) => binding.stage === "validation");
  if (!reused) return reviewerOwnValidationInput(job, attempt);
  const sourceAttempt = job.attempts.find((candidate) => candidate.id === reused.sourceAttemptId);
  if (!sourceAttempt || sourceAttempt.lane !== "reviewer" || sourceAttempt.phase !== "settled") {
    throw new ReviewerValidationIntegrityError("Reviewer validation checkpoint source Attempt is missing");
  }
  return reviewerOwnValidationInput(job, sourceAttempt);
}

export function reviewerOwnValidationInput(job: Job, attempt: Attempt): ReviewerValidationInput {
  if (!job.worktree || !attempt.executionSnapshot || !attempt.expectedHeadSha || !attempt.reviewerValidationArgv) {
    throw new ReviewerValidationIntegrityError("Reviewer validation lost its Attempt binding");
  }
  const checkpointIdentity = reviewerCheckpointIdentity(job, attempt);
  const runtimeTimeouts = snapshotRuntimeTimeouts(attempt.executionSnapshot, "reviewer");
  const totalTimeoutMs = attempt.executionSnapshot.validationTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
  return {
    worktree: job.worktree,
    rootPath: dirname(attempt.resultPath),
    resultPath: attempt.resultPath,
    jobId: job.id,
    attemptId: attempt.id,
    taskDigest: job.task.digest,
    baseSha: attempt.baseSha,
    expectedHeadSha: attempt.expectedHeadSha,
    validationArgv: [...attempt.reviewerValidationArgv],
    totalTimeoutMs,
    noProgressTimeoutMs: Math.min(runtimeTimeouts.noProgressTimeoutMs, totalTimeoutMs),
    sigtermGraceMs: runtimeTimeouts.sigtermGraceMs,
    sigkillGraceMs: runtimeTimeouts.sigkillGraceMs,
    dockerHost: attempt.executionSnapshot.dockerHost,
    resourceDigest: checkpointIdentity.resourceDigest,
    checkpointIdentity,
  };
}
