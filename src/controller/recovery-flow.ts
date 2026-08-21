import { approvedRecoveryHandoff } from "../handoff.js";
import { evolveJob, isRetryAction, MAX_CI_REWORKS, type AnalystAdvice, type AutomaticRecovery, type CiFailure, type HarnessState, type Incident, type Job } from "../model.js";
import { allowedActionsFor, automaticRecoveryFor, buildEvidencePack, isAutomaticRecoveryApproval, isDecisionResolutionEligible } from "../policy.js";
import type { ControllerContext } from "./context.js";
import { finishObservedAttempt } from "./attempt-settlement.js";
import { verifyReviewerPreflight } from "./attempt-integrity.js";
import { ciChecksDigest, dedupeEvidence, isFailedCheck, message, result, settleAttempt, summarizeCiFailure } from "./helpers.js";
import type { TickResult } from "./types.js";

export async function diagnoseOrWait(ctx: ControllerContext, state: HarnessState, job: Job): Promise<TickResult> {
  const lateResult = await reconcileLateAttemptResult(ctx, state, job);
  if (lateResult) return lateResult;
  const recovered = await reconcileBlockedCi(ctx, state, job);
  if (recovered) return recovered;
  if (!job.incident) throw new Error("blocked job has no incident");
  if (job.analysis) {
    return result(true, "waiting_for_approval", job.id, `analysis ${job.analysis.id} is ready; human approval is required`);
  }
  if (!job.analyst) {
    return result(true, "waiting_for_approval", job.id, "Analyst is unavailable; incident can only be held or cancelled");
  }
  let advice: AnalystAdvice;
  try {
    advice = await runDiagnosis(ctx, job, job.incident);
  } catch (error) {
    advice = {
      id: ctx.deps.ids.next("analysis"),
      incidentId: job.incident.id,
      evidenceDigest: job.incident.evidenceDigest,
      action: "hold",
      summary: `Analyst diagnosis failed closed: ${message(error)}`,
      resolutionBrief: "",
      evidenceRefs: [],
      unknowns: [message(error)],
      createdAt: ctx.deps.clock.now(),
    };
  }
  const now = ctx.deps.clock.now();
  const automatic = automaticRecoveryFor(job, advice);
  if (automatic) {
    const approval: AutomaticRecovery = {
      id: ctx.deps.ids.next("approval"),
      jobRevision: job.revision,
      incidentId: job.incident.id,
      analysisId: advice.id,
      action: automatic.action,
      basis: "policy_rule",
      policyRule: automatic.rule,
      fingerprint: automatic.fingerprint,
      attemptId: automatic.attemptId,
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
  const next = evolveJob(job, now, { analysis: advice });
  await ctx.saveJob(state, job, next);
  return result(true, "analysis_recorded", job.id, `Analyst advice ${advice.id} recorded with action=${advice.action}`);
}

export async function reconcileLateAttemptResult(ctx: ControllerContext, state: HarnessState, job: Job): Promise<TickResult | null> {
  const attempt = job.activeAttempt;
  if (
    job.incident?.class !== "infrastructure_exhausted"
    || !attempt
    || job.incident.attemptId !== attempt.id
    || job.incident.lane !== attempt.lane
    || attempt.phase !== "settled"
    || attempt.result !== null
    || !attempt.handle
  ) return null;

  let observation;
  try {
    observation = await ctx.runtimeFor(attempt).wait({
      handle: attempt.handle,
      attempt,
      resultPath: attempt.resultPath,
      expectedJobId: job.id,
      expectedAttemptId: attempt.id,
      expectedLane: attempt.lane,
    });
  } catch {
    return null;
  }
  if (observation.result === null) return null;

  const reconciledJob: Job = {
    ...job,
    incident: null,
    analysis: null,
    approval: null,
    lastError: null,
  };
  return finishObservedAttempt(ctx, state, reconciledJob, attempt, observation);
}

export async function reconcileBlockedCi(ctx: ControllerContext, state: HarnessState, job: Job): Promise<TickResult | null> {
  if (
    (job.incident?.class !== "ci_failure" && job.incident?.class !== "ci_rework_exhausted") ||
    !job.pullRequest ||
    !job.ciFailure ||
    job.headSha !== job.pullRequest.headSha ||
    job.ciFailure.headSha !== job.pullRequest.headSha
  ) return null;

  let observation;
  try {
    observation = await ctx.deps.github.observePullRequest(job.task.repo, job.pullRequest);
  } catch (error) {
    return result(false, "waiting_for_approval", job.id, `exact-HEAD CI reconciliation is retryable: ${message(error)}`);
  }
  if (observation.status === "merged") {
    const next = evolveJob(job, ctx.deps.clock.now(), {
      state: "done",
      incident: null,
      analysis: null,
      ciFailure: null,
      lastError: null,
    });
    await ctx.saveJob(state, job, next);
    return result(true, "merged", job.id, `PR #${job.pullRequest.number} merged while CI recovery was held`);
  }
  const failedChecks = observation.requiredChecks.filter(isFailedCheck);
  if (
    observation.status === "open" &&
    failedChecks.length > 0 &&
    ciChecksDigest(failedChecks) !== ciChecksDigest(job.ciFailure.checks)
  ) {
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
  if (
    observation.status !== "open" ||
    observation.requiredChecks.length === 0 ||
    observation.requiredChecks.some((check) => check.bucket !== "pass" && check.bucket !== "skipping")
  ) return null;

  const next = evolveJob(job, ctx.deps.clock.now(), {
    state: "publish_ready",
    incident: null,
    analysis: null,
    ciFailure: null,
    lastError: null,
  });
  await ctx.saveJob(state, job, next);
  return result(
    true,
    "ci_recovered",
    job.id,
    `PR #${job.pullRequest.number} required checks recovered on unchanged HEAD ${job.pullRequest.headSha}`,
  );
}

export async function runDiagnosis(ctx: ControllerContext, job: Job, incident: Incident): Promise<AnalystAdvice> {
  const initial = await ctx.deps.evidence.initial(job);
  let items = dedupeEvidence(initial.items);
  let missing = [...initial.missing];
  let pack = buildEvidencePack({
    incident,
    jobId: job.id,
    jobRevision: job.revision,
    taskDigest: job.task.digest,
    items,
    missing,
  });

  for (let turn = 1; turn <= ctx.deps.config.maxAnalystTurns; turn += 1) {
    const output = await ctx.deps.analyst.turn({ session: job.analyst!, job, evidence: pack, turn });
    if (output.kind === "need_evidence") {
      if (output.requests.length === 0 || output.requests.length > 4) {
        throw new Error("Analyst requested an invalid number of evidence items");
      }
      const collected = await ctx.deps.evidence.collect(job, output.requests);
      items = dedupeEvidence([...items, ...collected]);
      missing = missing.filter((entry) => !collected.some((item) => item.source === entry));
      pack = buildEvidencePack({
        incident,
        jobId: job.id,
        jobRevision: job.revision,
        taskDigest: job.task.digest,
        items,
        missing,
      });
      continue;
    }

    let action = output.action;
    const unknowns = [...output.unknowns];
    if (!incident.allowedActions.includes(action)) {
      unknowns.push(`action ${action} is forbidden for incident class ${incident.class}`);
      action = "hold";
    }
    if (action !== "hold" && !output.resolutionBrief.trim()) {
      unknowns.push("retry recommendation has no bounded resolution brief");
      action = "hold";
    }
    const knownRefs = new Set(pack.items.map((item) => item.ref));
    const diagnosisRefs = output.diagnosis?.hypotheses.flatMap((hypothesis) => hypothesis.evidenceRefs) ?? [];
    if ([...output.evidenceRefs, ...diagnosisRefs].some((ref) => !knownRefs.has(ref))) {
      unknowns.push("Analyst cited evidence outside the bounded pack");
      action = "hold";
    }
    const createdAt = ctx.deps.clock.now();
    return {
      id: ctx.deps.ids.next("analysis"),
      incidentId: incident.id,
      evidenceDigest: pack.digest,
      action,
      summary: output.summary,
      resolutionBrief: action === "hold" ? "" : output.resolutionBrief,
      evidenceRefs: output.evidenceRefs.filter((ref) => knownRefs.has(ref)),
      unknowns,
      ...(output.diagnosis
        ? {
            diagnosis: {
              ...output.diagnosis,
              hypotheses: output.diagnosis.hypotheses.map((hypothesis) => ({
                ...hypothesis,
                evidenceRefs: hypothesis.evidenceRefs.filter((ref) => knownRefs.has(ref)),
              })),
            },
          }
        : {}),
      createdAt,
    };
  }

  return {
    id: ctx.deps.ids.next("analysis"),
    incidentId: incident.id,
    evidenceDigest: pack.digest,
    action: "hold",
    summary: "自动诊断未完成：在允许的证据轮数内仍缺少关键证据。",
    resolutionBrief: "",
    evidenceRefs: pack.items.map((item) => item.ref),
    unknowns: ["所需证据超出 Harness 本轮允许的收集范围"],
    createdAt: ctx.deps.clock.now(),
  };
}

export async function applyRecovery(ctx: ControllerContext, state: HarnessState, job: Job): Promise<TickResult> {
  const lateResult = await reconcileLateAttemptResult(ctx, state, job);
  if (lateResult) return lateResult;
  const approval = job.approval;
  const analysis = job.analysis;
  const incident = job.incident;
  if (!approval || !analysis || !incident) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "controller",
      summary: "approved recovery lost its incident or analysis binding",
      attemptResult: null,
    });
  }
  const humanDecision = approval.basis === "human_decision";
  const policyDecision = approval.basis === "policy_rule";
  if (
    approval.jobRevision >= job.revision ||
    approval.incidentId !== incident.id ||
    approval.analysisId !== analysis.id ||
    !isRetryAction(approval.action) ||
    (humanDecision ? !isDecisionResolutionEligible(job) : approval.action !== analysis.action) ||
    (policyDecision && !isAutomaticRecoveryApproval(job, approval)) ||
    !incident.allowedActions.includes(approval.action) ||
    !allowedActionsFor(incident.class, incident.lane).includes(approval.action)
  ) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "controller",
      summary: "approval binding is stale or inconsistent",
      attemptResult: null,
    });
  }

  const ciRecovery = approval.action === "retry_fresh_worker" && incident.class === "ci_failure";
  if (ciRecovery) {
    if (
      incident.lane !== "controller" ||
      incident.attemptId !== null ||
      job.activeAttempt !== null ||
      !job.pullRequest ||
      !job.ciFailure ||
      job.ciFailure.headSha !== job.pullRequest.headSha ||
      job.headSha !== job.pullRequest.headSha ||
      (job.ciReworkCount ?? 0) >= MAX_CI_REWORKS
    ) {
      return ctx.block(state, job, {
        class: "integrity_violation",
        lane: "controller",
        summary: "fresh Worker CI recovery lost its exact PR or Git binding",
        attemptResult: null,
      });
    }
    let observation;
    try {
      observation = await ctx.deps.github.observePullRequest(job.task.repo, job.pullRequest);
      if (observation.status !== "open") throw new Error(`PR is ${observation.status}`);
      if (observation.autoMergeEnabled) await ctx.deps.github.suspendAutoMerge(job.task.repo, job.pullRequest);
    } catch (error) {
      return result(false, "recovery_applied", job.id, `CI recovery safety check is retryable: ${message(error)}`);
    }
  }

  if (approval.action === "retry_fresh_reviewer") {
    if (
      (incident.class !== "infrastructure_exhausted" && incident.class !== "reviewer_preflight_dirty") ||
      incident.lane !== "reviewer" ||
      job.activeAttempt?.lane !== "reviewer" ||
      incident.attemptId !== job.activeAttempt.id
    ) {
      return ctx.block(state, job, {
        class: "integrity_violation",
        lane: "controller",
        summary: "fresh Reviewer recovery lost its exact incident or Git binding",
        attemptResult: job.activeAttempt?.result ?? null,
      });
    }
    const integrityBlock = await verifyReviewerPreflight(ctx,
      state,
      job,
      job.activeAttempt,
      job.headSha,
      job.activeAttempt.result,
    );
    if (integrityBlock) return integrityBlock;
  }

  if (job.activeAttempt?.handle) {
    try {
      await ctx.closeAttempt(job.activeAttempt, "recovery");
    } catch (error) {
      return result(false, "recovery_applied", job.id, `old agent could not be closed safely: ${message(error)}`);
    }
  }
  const now = ctx.deps.clock.now();
  const attempts = job.activeAttempt
    ? [...job.attempts, settleAttempt(job.activeAttempt, job.activeAttempt.result, now)]
    : job.attempts;
  const consumed = { ...approval, consumedAt: now };
  const automaticRecoveries = policyDecision
    ? (job.automaticRecoveries ?? []).map((entry) => entry.id === approval.id ? { ...entry, consumedAt: now } : entry)
    : job.automaticRecoveries;
  const pendingHandoff = approvedRecoveryHandoff({
    job,
    incident,
    analysis,
    approval,
    createdAt: now,
  });
  const next = evolveJob(job, now, {
    state: approval.action === "retry_fresh_reviewer" ? "reviewer_ready" : "worker_ready",
    activeAttempt: null,
    attempts,
    pendingHandoff,
    incident: null,
    analysis: null,
    approval: consumed,
    ...(automaticRecoveries ? { automaticRecoveries } : {}),
    ...(ciRecovery ? { ciReworkCount: (job.ciReworkCount ?? 0) + 1 } : {}),
    lastError: null,
  });
  await ctx.saveJob(state, job, next);
  const lane = approval.action === "retry_fresh_reviewer" ? "Reviewer" : "Worker";
  return result(true, "recovery_applied", job.id, `${policyDecision ? "policy authorization" : "approval"} consumed; a fresh ${lane} attempt is now required`);
}
