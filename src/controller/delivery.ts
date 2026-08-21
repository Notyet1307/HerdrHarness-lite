import { evolveJob, MAX_CI_REWORKS, type HarnessState, type Job, type CiFailure } from "../model.js";
import type { ControllerContext } from "./context.js";
import { isFailedCheck, message, result, summarizeCiFailure } from "./helpers.js";
import type { TickResult } from "./types.js";

export async function publish(ctx: ControllerContext, state: HarnessState, job: Job): Promise<TickResult> {
  if (!job.headSha) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "controller",
      summary: "publish lane has no reviewed HEAD",
      attemptResult: null,
    });
  }
  const refreshed = await refreshBaseForReview(ctx, state, job, false, "publish_retry");
  if (refreshed) return refreshed;
  let pullRequest;
  try {
    pullRequest = await ctx.deps.github.publish({
      repo: job.task.repo,
      issueNumber: job.task.issueNumber,
      branch: job.branch,
      baseRef: ctx.deps.config.baseRef,
      headSha: job.headSha,
      title: job.task.title,
      worktreePath: job.worktree?.path ?? ctx.deps.config.localPath,
    });
  } catch (error) {
    return result(false, "publish_retry", job.id, `publish is retryable and not yet confirmed: ${message(error)}`);
  }
  if (pullRequest.headSha !== job.headSha) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "controller",
      summary: `PR head ${pullRequest.headSha} differs from reviewed head ${job.headSha}`,
      attemptResult: null,
    });
  }
  const next = evolveJob(job, ctx.deps.clock.now(), {
    state: "awaiting_merge",
    pullRequest,
    ciFailure: null,
    lastError: null,
  });
  await ctx.saveJob(state, job, next);
  return result(
    true,
    "published",
    job.id,
    ctx.deps.config.autoMerge
      ? `PR #${pullRequest.number} published with native auto-merge requested`
      : `PR #${pullRequest.number} published; merge remains external`,
  );
}

export async function observeMerge(ctx: ControllerContext, state: HarnessState, job: Job): Promise<TickResult> {
  if (!job.pullRequest) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "controller",
      summary: "awaiting_merge has no pull request identity",
      attemptResult: null,
    });
  }
  let observation;
  try {
    observation = await ctx.deps.github.observePullRequest(job.task.repo, job.pullRequest);
  } catch (error) {
    return result(false, "waiting_for_merge", job.id, `PR observation is retryable: ${message(error)}`);
  }
  if (observation.status === "open") {
    if (observation.requiredChecks.some((check) => check.bucket === "pending")) {
      return result(true, "waiting_for_merge", job.id, `PR #${job.pullRequest.number} required checks are still pending`);
    }
    const failedChecks = observation.requiredChecks.filter(isFailedCheck);
    if (failedChecks.length > 0) {
      if (observation.autoMergeEnabled) {
        try {
          await ctx.deps.github.suspendAutoMerge(job.task.repo, job.pullRequest);
        } catch (error) {
          return result(
            false,
            "waiting_for_merge",
            job.id,
            `required CI failed but auto-merge suspension is not confirmed: ${message(error)}`,
          );
        }
      }
      const ciFailure: CiFailure = {
        headSha: job.pullRequest.headSha,
        observedAt: ctx.deps.clock.now(),
        checks: failedChecks,
      };
      return ctx.block(state, job, {
        class: (job.ciReworkCount ?? 0) >= MAX_CI_REWORKS ? "ci_rework_exhausted" : "ci_failure",
        lane: "controller",
        summary: summarizeCiFailure(job.pullRequest.number, ciFailure),
        attemptResult: null,
        ciFailure,
      });
    }
    const refreshed = await refreshBaseForReview(ctx,
      state,
      job,
      observation.autoMergeEnabled,
      "waiting_for_merge",
    );
    if (refreshed) return refreshed;
    return result(true, "waiting_for_merge", job.id, `PR #${job.pullRequest.number} is still open`);
  }
  if (observation.status === "closed_unmerged") {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "controller",
      summary: `PR #${job.pullRequest.number} closed without merge`,
      attemptResult: null,
    });
  }
  const next = evolveJob(job, ctx.deps.clock.now(), { state: "done", lastError: null });
  await ctx.saveJob(state, job, next);
  return result(true, "merged", job.id, `PR #${job.pullRequest.number} merged`);
}

export async function refreshBaseForReview(
  ctx: ControllerContext,
  state: HarnessState,
  job: Job,
  autoMergeEnabled: boolean,
  retryAction: "publish_retry" | "waiting_for_merge",
): Promise<TickResult | null> {
  if (!job.worktree || !job.headSha) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "controller",
      summary: "base refresh requires a worktree and reviewed HEAD",
      attemptResult: null,
    });
  }

  let latestBaseSha: string;
  try {
    latestBaseSha = await ctx.deps.git.refreshBase(ctx.deps.config.localPath, ctx.deps.config.baseRef);
  } catch (error) {
    return result(false, retryAction, job.id, `base refresh is retryable: ${message(error)}`);
  }
  if (latestBaseSha === job.baseSha) return null;

  if (autoMergeEnabled && job.pullRequest) {
    try {
      await ctx.deps.github.suspendAutoMerge(job.task.repo, job.pullRequest);
    } catch (error) {
      try {
        const observation = await ctx.deps.github.observePullRequest(job.task.repo, job.pullRequest);
        if (observation.status === "merged") {
          const next = evolveJob(job, ctx.deps.clock.now(), { state: "done", lastError: null });
          await ctx.saveJob(state, job, next);
          return result(true, "merged", job.id, `PR #${job.pullRequest.number} merged`);
        }
      } catch {
        // Preserve the suspension failure below when merged state cannot be proved.
      }
      return result(false, retryAction, job.id, `base moved but auto-merge suspension is not confirmed: ${message(error)}`);
    }
  }

  let verification;
  try {
    verification = await ctx.deps.git.syncBase({
      worktree: job.worktree,
      branch: job.branch,
      baseRef: ctx.deps.config.baseRef,
      expectedHeadSha: job.headSha,
      expectedRemoteHeadSha: job.pullRequest?.headSha ?? null,
      latestBaseSha,
    });
  } catch (error) {
    return result(false, retryAction, job.id, `base refresh is retryable: ${message(error)}`);
  }
  if (!verification.ok) {
    return ctx.block(state, job, {
      class: verification.class,
      lane: "controller",
      summary: verification.reason,
      attemptResult: null,
    });
  }

  const next = evolveJob(job, ctx.deps.clock.now(), {
    state: "reviewer_ready",
    baseSha: latestBaseSha,
    headSha: verification.headSha,
    activeAttempt: null,
    ciFailure: null,
    lastError: null,
  });
  await ctx.saveJob(state, job, next);
  return result(
    true,
    "base_refreshed",
    job.id,
    `base advanced to ${latestBaseSha}; refreshed HEAD ${verification.headSha} requires fresh review`,
  );
}
