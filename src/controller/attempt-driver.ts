import { dirname, resolve } from "node:path";
import { executionPlanMatches } from "../attempt-plan.js";
import { digest, evolveJob, type Attempt, type HarnessState, type Job } from "../model.js";
import { renderAttemptPrompt } from "../prompts.js";
import { safePiRpcDiagnosticFromError } from "../pi-rpc-diagnostics.js";
import type { ControllerContext } from "./context.js";
import { message, result, safeToken, validReviewerValidationArgv } from "./helpers.js";
import {
  PI_AGENT_DIR_ENV,
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

  if (attempt.phase === "prepared") {
    if (lane === "reviewer") {
      const integrityBlock = await verifyReviewerPreflight(ctx,
        state,
        job,
        attempt,
        attempt.expectedHeadSha,
        null,
      );
      if (integrityBlock) return integrityBlock;
    }
    const preflight = await runRuntimePreflight(ctx, [lane], job.id, attempt.executionSnapshot);
    if (preflight.ok === false) return preflight.result;
    let handle;
    try {
      let cwd = job.worktree.path;
      let env: Record<string, string> = lane === "worker"
        ? {
            PYTHONDONTWRITEBYTECODE: "1",
            [PI_AGENT_DIR_ENV]: attempt.executionSnapshot!.context!.agentDir,
            DOCKER_HOST: preflight.dockerHost ?? "",
            ...ponytailEnvironment(attempt.executionSnapshot!),
          }
        : {};
      if (lane === "worker") {
        const channel = await ctx.deps.git.prepareWorkerResult({
          worktree: job.worktree,
          rootPath: resolve(ctx.deps.config.stateDir, "worker-attempts", safeToken(job.id), safeToken(attempt.id)),
          resultPath: attempt.resultPath,
          jobId: job.id,
          attemptId: attempt.id,
        });
        env[WORKER_DESCRIPTOR_ENV] = channel.descriptorPath;
      }
      if (lane === "reviewer") {
        if (!attempt.expectedHeadSha) throw new Error("Reviewer attempt has no expected HEAD");
        if (!validReviewerValidationArgv(attempt.reviewerValidationArgv)) {
          return ctx.block(state, job, {
            class: "integrity_violation",
            lane,
            summary: "Reviewer attempt has no durably bound validation command",
            attemptResult: null,
          });
        }
        const reviewAxisAgents = attempt.executionSnapshot!.resources.filter((resource) => resource.kind === "agent");
        if (reviewAxisAgents.length !== 1) throw new Error("Reviewer execution snapshot must bind exactly one child agent");
        const workspace = await ctx.deps.git.prepareReviewer({
          worktree: job.worktree,
          rootPath: dirname(attempt.resultPath),
          resultPath: attempt.resultPath,
          jobId: job.id,
          attemptId: attempt.id,
          baseSha: attempt.baseSha,
          expectedHeadSha: attempt.expectedHeadSha,
          validationArgv: attempt.reviewerValidationArgv,
          dockerHost: preflight.dockerHost,
          reviewAxisAgent: reviewAxisAgents[0]!,
          piExecutable: attempt.executionSnapshot!.executable,
          piRuntimeVersion: attempt.executionSnapshot!.runtimeVersion,
          piAgentDir: attempt.executionSnapshot!.context!.agentDir,
        });
        cwd = workspace.reviewPath;
        env = {
          [REVIEW_DESCRIPTOR_ENV]: workspace.descriptorPath,
          [REVIEW_SUBAGENT_CEILING_ENV]: REVIEW_SUBAGENT_CEILING,
          [PI_AGENT_DIR_ENV]: attempt.executionSnapshot!.context!.agentDir,
          [REVIEW_CANONICAL_AGENT_DIR_ENV]: attempt.executionSnapshot!.context!.agentDir,
          DOCKER_HOST: preflight.dockerHost ?? "",
        };
      }
      handle = await ctx.deps.herdr.createAttemptPane({
        worktree: job.worktree,
        attempt,
        cwd,
        env,
      });
    } catch (error) {
      return reconcileAttemptOrBlock(ctx, state, job, attempt, `Herdr ${lane} pane creation failed: ${message(error)}`);
    }
    const ready: Attempt = { ...attempt, phase: "pane_ready", handle, reconciliationAttempts: 0 };
    const next = evolveJob(job, ctx.deps.clock.now(), { activeAttempt: ready, lastError: null });
    await ctx.saveJob(state, job, next);
    return result(true, "attempt_pane_ready", job.id, `${lane} attempt ${attempt.id} has a durable owned pane`);
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
