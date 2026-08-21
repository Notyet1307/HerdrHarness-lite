import { type Attempt, type AttemptResult, type HarnessState, type Job } from "../model.js";
import { pathIsWithin } from "../path-safety.js";
import type { ControllerContext } from "./context.js";
import type { TickResult } from "./types.js";

export async function verifyReviewerIntegrity(
  ctx: ControllerContext,
  state: HarnessState,
  job: Job,
  attempt: Attempt,
  reportedHeadSha: string | null,
  attemptResult: AttemptResult | null,
): Promise<TickResult | null> {
  if (!job.worktree || !job.headSha) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "reviewer",
      summary: "reviewer lane lost its expected worktree or implementation HEAD",
      attemptResult,
    });
  }
  const verification = await ctx.deps.git.verifyReviewer({
    worktree: job.worktree,
    expectedHeadSha: job.headSha,
    reportedHeadSha,
    allowedResultPaths: [...job.attempts.map((settled) => settled.resultPath), attempt.resultPath]
      .filter((path) => pathIsWithin(job.worktree!.path, path)),
  });
  if (verification.ok) return null;
  return ctx.block(state, job, {
    class: verification.class,
    lane: "reviewer",
    summary: `Reviewer boundary violation: ${verification.reason}`,
    attemptResult,
  });
}

export async function verifyReviewerPreflight(
  ctx: ControllerContext,
  state: HarnessState,
  job: Job,
  attempt: Attempt,
  reportedHeadSha: string | null,
  attemptResult: AttemptResult | null,
): Promise<TickResult | null> {
  if (!job.worktree || !job.headSha) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "reviewer",
      summary: "reviewer lane lost its expected worktree or implementation HEAD",
      attemptResult,
    });
  }
  const verification = await ctx.deps.git.verifyReviewer({
    worktree: job.worktree,
    expectedHeadSha: job.headSha,
    reportedHeadSha,
    allowedResultPaths: [...job.attempts.map((settled) => settled.resultPath), attempt.resultPath]
      .filter((path) => pathIsWithin(job.worktree!.path, path)),
  });
  if (verification.ok) return null;
  const preflightResidue = verification.kind === "worktree_dirty" && attempt.handle === null;
  return ctx.block(state, job, {
    class: preflightResidue ? "reviewer_preflight_dirty" : verification.class,
    lane: "reviewer",
    summary: preflightResidue
      ? `Worktree residue existed before Reviewer start: ${verification.reason}`
      : `Reviewer boundary violation: ${verification.reason}`,
    attemptResult,
  });
}
