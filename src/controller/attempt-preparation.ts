import { join, resolve } from "node:path";
import { attemptPlanDigest, buildExecutionSnapshot } from "../attempt-plan.js";
import { buildAttemptContextEnvelope } from "../attempt-context.js";
import { QUALIFIED_CONTROLLED_COMPACTION_PI_VERSION, WORKER_CONTROLLED_COMPACTION_POLICY } from "../compatibility.js";
import { bindPendingHandoff } from "../handoff.js";
import { digest, evolveJob, type Attempt, type ExecutionSnapshot, type HarnessState, type Job } from "../model.js";
import { renderAttemptPrompt } from "../prompts.js";
import type { ControllerContext } from "./context.js";
import { message, result, safeToken, trimSlash } from "./helpers.js";
import { BUNDLED_REVIEW_AXIS_AGENT, PI_RPC_RUNNER, PI_RPC_SDK_ENTRY } from "./resources.js";
import { rpcEnabled, runtimeRole } from "./runtime-contract.js";
import type { TickResult } from "./types.js";

export async function prepareAttempt(ctx: ControllerContext, state: HarnessState, job: Job, lane: Attempt["lane"]): Promise<TickResult> {
  if (!job.worktree) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "controller",
      summary: `${lane} lane has no worktree`,
      attemptResult: null,
    });
  }
  if (lane === "reviewer" && !job.headSha) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "controller",
      summary: "reviewer lane has no implementation HEAD",
      attemptResult: null,
    });
  }

  const attemptId = ctx.deps.ids.next(lane);
  const now = ctx.deps.clock.now();
  const attemptRoot = resolve(
    ctx.deps.config.stateDir,
    `${lane}-attempts`,
    safeToken(job.id),
    safeToken(attemptId),
  );
  let attempt: Attempt = {
    id: attemptId,
    lane,
    phase: "prepared",
    round: job.reviewRound + 1,
    baseSha: lane === "worker" ? (job.headSha ?? job.baseSha) : job.baseSha,
    expectedHeadSha: lane === "reviewer" ? job.headSha : null,
    expectedRemoteHeadSha: lane === "worker" ? (job.pullRequest?.headSha ?? null) : null,
    resultPath: lane === "reviewer"
      ? resolve(attemptRoot, "result.json")
      : `${trimSlash(job.worktree.path)}/.harness/attempt-${safeToken(attemptId)}.json`,
    ...(lane === "reviewer" ? { reviewerValidationArgv: [...ctx.deps.config.reviewerValidationArgv] } : {}),
    promptDigest: "",
    handle: null,
    result: null,
    reconciliationAttempts: 0,
    startedAt: now,
    completedAt: null,
  };
  const handoff = bindPendingHandoff(job, attempt);
  let executionSnapshot: ExecutionSnapshot;
  try {
    const ambient = await ctx.deps.preflight.assertNoAmbientSystemPrompt({ cwd: job.worktree.path });
    const context = await ctx.deps.git.prepareTrustedContext({
      localPath: ctx.deps.config.localPath,
      rootPath: attemptRoot,
      trustAnchorSha: job.baseSha,
      jobId: job.id,
      attemptId,
      lane,
      agentDir: ambient.agentDir,
    });
    const runtime = await ctx.deps.preflight.inspectPi({
      cwd: ctx.deps.config.localPath,
      piBin: ctx.deps.config.preflight?.piBin ?? "pi",
    });
    const dockerHost = ctx.deps.config.preflight?.dockerRequired === true
      ? (await ctx.deps.preflight.probeDocker({ cwd: ctx.deps.config.localPath })).host
      : null;
    const useRpc = rpcEnabled(ctx.deps.config, lane);
    if (useRpc && lane === "worker" && runtime.version !== QUALIFIED_CONTROLLED_COMPACTION_PI_VERSION) {
      throw new Error(`controlled Worker compaction requires Pi ${QUALIFIED_CONTROLLED_COMPACTION_PI_VERSION}`);
    }
    const role = runtimeRole(ctx.deps.config, lane);
    executionSnapshot = buildExecutionSnapshot({
      adapter: useRpc ? "pi-rpc" : "herdr-pi-cli",
      executable: runtime.executable,
      runtimeVersion: runtime.version,
      argv: [
        ...role.argv,
        "--append-system-prompt",
        context.bundlePath,
        ...(useRpc ? ["--mode", "rpc"] : []),
      ],
      context,
      retryMode: useRpc ? "disabled" : "runtime-default",
      compactionMode: useRpc
        ? lane === "worker" ? "controlled-threshold" : "disabled"
        : "runtime-default",
      ...(useRpc && lane === "worker"
        ? { compactionPolicy: WORKER_CONTROLLED_COMPACTION_POLICY }
        : {}),
      credentialMode: useRpc ? role.credentialMode : "runtime-default",
      dockerHost,
      extraResources: [
        ...(lane === "reviewer" ? [{ kind: "agent" as const, path: BUNDLED_REVIEW_AXIS_AGENT }] : []),
        ...(useRpc ? [
          { kind: "runtime" as const, path: PI_RPC_RUNNER },
          { kind: "runtime" as const, path: PI_RPC_SDK_ENTRY },
        ] : []),
        ...(useRpc && role.credentialMode === "canonical-model-config" ? [
          { kind: "model-config" as const, path: join(context.agentDir, "models.json") },
        ] : []),
      ],
    });
  } catch (error) {
    return result(false, "preflight_failed", job.id, message(error));
  }
  attempt = { ...attempt, executionSnapshot };
  const contextEnvelope = buildAttemptContextEnvelope({ job, attempt, executionSnapshot, handoff });
  attempt = { ...attempt, contextEnvelope, contextEnvelopeDigest: digest(contextEnvelope) };
  const prompt = renderAttemptPrompt(attempt);
  attempt = { ...attempt, promptDigest: digest(prompt) };
  attempt = { ...attempt, planDigest: attemptPlanDigest(attempt) };
  const next = evolveJob(job, now, {
    state: lane === "worker" ? "worker_running" : "reviewer_running",
    activeAttempt: attempt,
    pendingHandoff: null,
    lastError: null,
  });
  await ctx.saveJob(state, job, next);
  return result(true, "attempt_prepared", job.id, `${lane} attempt ${attempt.id} is durably prepared`);
}
