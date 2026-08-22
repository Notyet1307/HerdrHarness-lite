import { existsSync } from "node:fs";
import { evolveJob, type AnalystAdvice, type AutomaticRecovery, type HarnessState, type Job } from "../model.js";
import { automaticRecoveryFor } from "../policy.js";
import { runtimeSideEffectBoundaryFrom } from "../pi-rpc-diagnostics.js";
import type { ControllerContext } from "./context.js";
import { message, result } from "./helpers.js";
import type { TickResult } from "./types.js";

export async function authorizeAutomaticRecovery(
  ctx: ControllerContext,
  state: HarnessState,
  job: Job,
  advice: AnalystAdvice | null,
  automatic: NonNullable<ReturnType<typeof automaticRecoveryFor>>,
  now: string,
): Promise<TickResult> {
  if (advice === null && automatic.rule !== "provider_pre_side_effect_transient") {
    throw new Error("only deterministic pre-side-effect Provider recovery may omit Analyst advice");
  }
  const providerAudit = automatic.rule === "provider_pre_side_effect_transient"
    ? {
        scopeFingerprint: automatic.scopeFingerprint,
        lane: automatic.lane,
        headSha: automatic.headSha,
        provider: automatic.provider,
        failureCode: automatic.failureCode,
        notBefore: automatic.notBefore,
      }
    : {};
  const approval: AutomaticRecovery = {
    id: ctx.deps.ids.next("approval"),
    jobRevision: job.revision,
    incidentId: job.incident!.id,
    analysisId: advice?.id ?? null,
    action: automatic.action,
    basis: "policy_rule",
    policyRule: automatic.rule,
    fingerprint: automatic.fingerprint,
    attemptId: automatic.attemptId,
    ...providerAudit,
    actor: "harness:auto-recovery",
    reason: automatic.rule,
    createdAt: now,
    consumedAt: null,
  };
  const next = evolveJob(job, now, {
    state: "recovery_approved",
    analysis: advice,
    approval,
    automaticRecoveries: [...(job.automaticRecoveries ?? []), approval],
  });
  await ctx.saveJob(state, job, next);
  return result(true, "auto_recovery_authorized", job.id, `${automatic.rule} authorized one fresh ${automatic.action}`);
}

export async function verifyProviderRecoveryBoundary(
  ctx: ControllerContext,
  state: HarnessState,
  job: Job,
): Promise<TickResult | null> {
  if (job.approval?.basis !== "policy_rule" || job.approval.policyRule !== "provider_pre_side_effect_transient") {
    return null;
  }
  const attempt = job.activeAttempt;
  const candidate = job.incident?.automaticRecovery;
  const boundary = job.incident?.runtimeDiagnostic
    ? runtimeSideEffectBoundaryFrom(job.incident.runtimeDiagnostic)
    : null;
  if (
    candidate?.rule !== "provider_pre_side_effect_transient"
    || !attempt
    || !job.worktree
    || !boundary
    || job.incident?.attemptId !== attempt.id
    || job.incident.lane !== attempt.lane
    || candidate.lane !== attempt.lane
    || candidate.headSha !== (attempt.expectedHeadSha ?? attempt.baseSha)
    || candidate.provider !== attempt.executionSnapshot?.provider
    || candidate.failureCode !== job.incident.runtimeDiagnostic?.failureCode
    || boundary.toolExecutionStarted
    || boundary.durableResultPresent
    || boundary.worktreeChanged
    || boundary.commitCreated
    || existsSync(attempt.resultPath)
  ) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: attempt?.lane ?? "controller",
      summary: "automatic Provider retry crossed or lost its pre-side-effect boundary",
      attemptResult: attempt?.result ?? null,
    });
  }
  let observed;
  try {
    observed = await ctx.deps.git.inspectAttemptSideEffects({
      worktree: job.worktree,
      expectedHeadSha: attempt.expectedHeadSha ?? attempt.baseSha,
      allowedResultPaths: [...job.attempts.map((entry) => entry.resultPath), attempt.resultPath],
    });
  } catch (error) {
    return result(false, "recovery_applied", job.id, `automatic Provider retry Git check is retryable: ${message(error)}`);
  }
  if (!observed.worktreeChanged && !observed.commitCreated) return null;
  return ctx.block(state, job, {
    class: "integrity_violation",
    lane: attempt.lane,
    summary: "automatic Provider retry found worktree or commit side effects after the runtime receipt",
    attemptResult: attempt.result,
  });
}
