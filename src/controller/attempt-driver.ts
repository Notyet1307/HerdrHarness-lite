import { join, resolve } from "node:path";
import { executionPlanMatches } from "../attempt-plan.js";
import { digest, evolveJob, type Attempt, type HarnessState, type Job } from "../model.js";
import { renderAttemptPrompt } from "../prompts.js";
import { safePiRpcDiagnosticFromError } from "../pi-rpc-diagnostics.js";
import {
  REVIEWER_CONTEXT_BUDGET_BYTES,
  REVIEWER_CONTEXT_BUDGET_RESERVE_BYTES,
  ReviewerContextBudgetExceededError,
} from "../reviewer-context-budget.js";
import { ReviewerValidationIntegrityError } from "../reviewer-validation.js";
import type { ControllerContext } from "./context.js";
import { message, result, safeToken } from "./helpers.js";
import {
  PI_AGENT_DIR_ENV,
  BUNDLED_CODE_REVIEW_SKILL,
  REVIEW_CANONICAL_AGENT_DIR_ENV,
  REVIEW_DESCRIPTOR_ENV,
  REVIEW_SUBAGENT_CEILING,
  REVIEW_SUBAGENT_CEILING_ENV,
  WORKER_DESCRIPTOR_ENV,
} from "./resources.js";
import { ponytailEnvironment } from "./runtime-contract.js";
import { runRuntimePreflight, verifyExecutionSnapshot } from "./runtime-preflight.js";
import { verifyReviewerIntegrity, verifyReviewerPreflight } from "./attempt-integrity.js";
import { reconcileAttemptOrBlock } from "./attempt-reconciliation.js";
import { finishObservedAttempt } from "./attempt-settlement.js";
import { ensureReviewerValidation, reviewerValidationInput, verifyBoundReviewerValidation } from "./reviewer-validation.js";
import type { TickResult } from "./types.js";

export async function driveAttempt(ctx: ControllerContext, state: HarnessState, job: Job, lane: Attempt["lane"]): Promise<TickResult> {
  const attempt = job.activeAttempt;
  if (!attempt || attempt.lane !== lane || !job.worktree) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "controller",
      summary: `${lane} state has incomplete attempt provenance`,
      attemptResult: null,
    });
  }

  if (!attempt.executionSnapshot || !attempt.planDigest) {
    if (attempt.phase !== "running") {
      return ctx.block(state, job, {
        class: "integrity_violation",
        lane,
        summary: "legacy attempt has no immutable execution plan and cannot produce new runtime side effects",
        attemptResult: null,
      });
    }
  } else if (!executionPlanMatches(attempt)) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane,
      summary: "attempt execution plan changed after preparation",
      attemptResult: null,
    });
  } else if ((!attempt.executionSnapshot.context || !attempt.contextEnvelope || !attempt.contextEnvelopeDigest) && attempt.phase !== "running") {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane,
      summary: "attempt has no explicit trusted context envelope and cannot produce new runtime side effects",
      attemptResult: null,
    });
  } else if (attempt.phase !== "running") {
    const integrityBlock = await verifyExecutionSnapshot(ctx, state, job, attempt);
    if (integrityBlock) return integrityBlock;
  }
  if (lane === "reviewer" && (attempt.phase !== "prepared" || attempt.reviewerValidationReceipt !== undefined)) {
    const validationBlock = await verifyBoundReviewerValidation(ctx, state, job, attempt);
    if (validationBlock) return validationBlock;
  }

  if (attempt.phase === "prepared" && lane === "reviewer" && !attempt.reviewerValidationReceipt) {
    const validation = await ensureReviewerValidation(ctx, state, job, attempt);
    if (!validation.ok) return validation.result;
    const postValidationIntegrity = await verifyExecutionSnapshot(
      ctx,
      state,
      { ...job, activeAttempt: validation.attempt },
      validation.attempt,
    );
    if (postValidationIntegrity) return postValidationIntegrity;
    const next = evolveJob(job, ctx.deps.clock.now(), {
      activeAttempt: validation.attempt,
      lastError: null,
    });
    await ctx.saveJob(state, job, next);
    return result(true, "reviewer_validation_ready", job.id, `reviewer attempt ${attempt.id} has a durable exact-HEAD validation receipt`);
  }

  if (attempt.phase === "prepared") {
    const preparedAttempt = attempt;
    if (lane === "reviewer") {
      const worktreeBlock = await verifyReviewerPreflight(
        ctx,
        state,
        job,
        preparedAttempt,
        preparedAttempt.expectedHeadSha,
        null,
      );
      if (worktreeBlock) return worktreeBlock;
    }
    const preflight = await runRuntimePreflight(ctx, [lane], job.id, preparedAttempt.executionSnapshot);
    if (preflight.ok === false) return preflight.result;
    let handle;
    try {
      let cwd = job.worktree.path;
      let env: Record<string, string> = lane === "worker"
        ? {
            PYTHONDONTWRITEBYTECODE: "1",
            [PI_AGENT_DIR_ENV]: preparedAttempt.executionSnapshot!.context!.agentDir,
            DOCKER_HOST: preflight.dockerHost ?? "",
            ...ponytailEnvironment(preparedAttempt.executionSnapshot!),
          }
        : {};
      if (lane === "worker") {
        const channel = await ctx.deps.git.prepareWorkerResult({
          worktree: job.worktree,
          rootPath: resolve(ctx.deps.config.stateDir, "worker-attempts", safeToken(job.id), safeToken(preparedAttempt.id)),
          resultPath: preparedAttempt.resultPath,
          jobId: job.id,
          attemptId: preparedAttempt.id,
        });
        env[WORKER_DESCRIPTOR_ENV] = channel.descriptorPath;
      }
      if (lane === "reviewer") {
        if (!preparedAttempt.expectedHeadSha || !preparedAttempt.reviewerValidationReceipt) throw new Error("Reviewer attempt has no validation-bound expected HEAD");
        const reviewAxisAgents = preparedAttempt.executionSnapshot!.resources.filter((resource) => resource.kind === "agent");
        if (reviewAxisAgents.length !== 1) throw new Error("Reviewer execution snapshot must bind exactly one child agent");
        const reviewerPrompt = renderAttemptPrompt(preparedAttempt);
        const validationInput = reviewerValidationInput(job, preparedAttempt);
        const workspace = await ctx.deps.git.prepareReviewer({
          ...validationInput,
          validationReceipt: preparedAttempt.reviewerValidationReceipt,
          reviewAxisAgent: reviewAxisAgents[0]!,
          piExecutable: preparedAttempt.executionSnapshot!.executable,
          piRuntimeVersion: preparedAttempt.executionSnapshot!.runtimeVersion,
          piAgentDir: preparedAttempt.executionSnapshot!.context!.agentDir,
          prompt: reviewerPrompt,
          trustedContextPath: attempt.executionSnapshot!.context!.bundlePath,
          reviewerSkillPath: join(BUNDLED_CODE_REVIEW_SKILL, "SKILL.md"),
          contextBudgetBytes: REVIEWER_CONTEXT_BUDGET_BYTES,
          contextBudgetReserveBytes: REVIEWER_CONTEXT_BUDGET_RESERVE_BYTES,
        });
        cwd = workspace.reviewPath;
        env = {
          [REVIEW_DESCRIPTOR_ENV]: workspace.descriptorPath,
          [REVIEW_SUBAGENT_CEILING_ENV]: REVIEW_SUBAGENT_CEILING,
          [PI_AGENT_DIR_ENV]: preparedAttempt.executionSnapshot!.context!.agentDir,
          [REVIEW_CANONICAL_AGENT_DIR_ENV]: preparedAttempt.executionSnapshot!.context!.agentDir,
        };
      }
      handle = await ctx.deps.herdr.createAttemptPane({
        worktree: job.worktree,
        attempt: preparedAttempt,
        cwd,
        env,
      });
    } catch (error) {
      if (error instanceof ReviewerValidationIntegrityError) {
        return ctx.block(state, { ...job, activeAttempt: preparedAttempt }, {
          class: "integrity_violation",
          lane: "reviewer",
          summary: error.message,
          attemptResult: null,
        });
      }
      if (error instanceof ReviewerContextBudgetExceededError) {
        return ctx.block(state, { ...job, activeAttempt: preparedAttempt }, {
          class: "review_uncertain",
          lane: "reviewer",
          summary: error.message,
          attemptResult: null,
        });
      }
      return reconcileAttemptOrBlock(ctx, state, job, preparedAttempt, `Herdr ${lane} pane creation failed: ${message(error)}`);
    }
    const ready: Attempt = { ...preparedAttempt, phase: "pane_ready", handle, reconciliationAttempts: 0 };
    const next = evolveJob(job, ctx.deps.clock.now(), { activeAttempt: ready, lastError: null });
    await ctx.saveJob(state, job, next);
    return result(true, "attempt_pane_ready", job.id, `${lane} attempt ${preparedAttempt.id} has a durable owned pane`);
  }

  if (attempt.phase === "pane_ready" && attempt.handle) {
    try {
      await ctx.runtimeFor(attempt).startAgent({
        handle: attempt.handle,
        attempt,
        cwd: ctx.attemptCwd(job, attempt),
        argv: attempt.executionSnapshot!.argv,
      });
    } catch (error) {
      return reconcileAttemptOrBlock(ctx,
        state,
        job,
        attempt,
        `Herdr ${lane} start failed: ${message(error)}`,
        safePiRpcDiagnosticFromError(error),
      );
    }
    const ready: Attempt = { ...attempt, phase: "agent_ready", reconciliationAttempts: 0 };
    const next = evolveJob(job, ctx.deps.clock.now(), { activeAttempt: ready, lastError: null });
    await ctx.saveJob(state, job, next);
    return result(true, "attempt_agent_ready", job.id, `${lane} attempt ${attempt.id} has a durable fresh Pi agent`);
  }

  if (attempt.phase === "agent_ready" && attempt.handle) {
    const prompt = renderAttemptPrompt(attempt);
    if (digest(prompt) !== attempt.promptDigest) {
      return ctx.block(state, job, {
        class: "integrity_violation",
        lane,
        summary: "prompt changed after attempt preparation",
        attemptResult: null,
      });
    }
    const running: Attempt = { ...attempt, phase: "running", reconciliationAttempts: 0 };
    const next = evolveJob(job, ctx.deps.clock.now(), { activeAttempt: running, lastError: null });
    await ctx.saveJob(state, job, next);
    try {
      await ctx.runtimeFor(attempt).prompt({
        handle: attempt.handle,
        attempt,
        dispatchId: attempt.id,
        skill: lane === "worker" ? "implement" : "code-review",
        text: prompt,
      });
    } catch (error) {
      return result(
        false,
        "attempt_dispatched",
        job.id,
        `Herdr ${lane} dispatch outcome is uncertain and will only be observed: ${message(error)}`,
      );
    }
    return result(true, "attempt_dispatched", job.id, `${lane} attempt ${attempt.id} dispatched exactly once`);
  }

  if (attempt.phase !== "running" || !attempt.handle) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "controller",
      summary: `${lane} attempt has an invalid lifecycle phase`,
      attemptResult: null,
    });
  }

  let observation;
  try {
    observation = await ctx.runtimeFor(attempt).wait({
      handle: attempt.handle,
      attempt,
      resultPath: attempt.resultPath,
      expectedJobId: job.id,
      expectedAttemptId: attempt.id,
      expectedLane: lane,
    });
  } catch (error) {
    if (lane === "reviewer") {
      const integrityBlock = await verifyReviewerIntegrity(ctx, state, job, attempt, null, null);
      if (integrityBlock) return integrityBlock;
    }
    return reconcileAttemptOrBlock(ctx,
      state,
      job,
      attempt,
      `Herdr ${lane} wait failed: ${message(error)}`,
      safePiRpcDiagnosticFromError(error),
    );
  }

  return finishObservedAttempt(ctx, state, job, attempt, observation);
}
