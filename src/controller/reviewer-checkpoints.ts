import { dirname, resolve } from "node:path";
import type { Attempt, HarnessState, Job } from "../model.js";
import { reviewerCheckpointIdentity } from "../reviewer-checkpoints.js";
import type { ControllerContext } from "./context.js";
import { message, safeToken } from "./helpers.js";
import type { TickResult } from "./types.js";

export async function verifyBoundReviewerCheckpoints(
  ctx: ControllerContext,
  state: HarnessState,
  job: Job,
  attempt: Attempt,
): Promise<TickResult | null> {
  const bindings = attempt.reviewerCheckpointInputs ?? [];
  if (bindings.length === 0) return null;
  try {
    const sources = reviewerCheckpointSources(ctx, job, attempt);
    await ctx.deps.git.verifyReviewerCheckpoints({
      bindings,
      sources,
      consumerIdentity: reviewerCheckpointIdentity(job, attempt),
    });
    return null;
  } catch (error) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "reviewer",
      summary: `Reviewer checkpoint cannot be verified: ${message(error)}`,
      attemptResult: attempt.result,
    });
  }
}

export function reviewerCheckpointSources(ctx: ControllerContext, job: Job, attempt: Attempt) {
  return [...new Set((attempt.reviewerCheckpointInputs ?? []).map((binding) => binding.sourceAttemptId))].map((sourceAttemptId) => {
    const sourceAttempt = job.attempts.find((candidate) => candidate.id === sourceAttemptId);
    if (!sourceAttempt || sourceAttempt.lane !== "reviewer" || sourceAttempt.phase !== "settled") {
      throw new Error(`Reviewer checkpoint source Attempt is unavailable: ${sourceAttemptId}`);
    }
    const rootPath = resolve(ctx.deps.config.stateDir, "reviewer-attempts", safeToken(job.id), safeToken(sourceAttempt.id));
    if (dirname(sourceAttempt.resultPath) !== rootPath) {
      throw new Error(`Reviewer checkpoint source escaped Harness private state: ${sourceAttemptId}`);
    }
    return {
      rootPath,
      identity: reviewerCheckpointIdentity(job, sourceAttempt),
    };
  });
}
