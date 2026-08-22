import { basename, join, resolve } from "node:path";
import { buildExecutionSnapshot, executionResource } from "../attempt-plan.js";
import { QUALIFIED_CONTROLLED_COMPACTION_PI_VERSION } from "../compatibility.js";
import { digest, type Attempt, type ExecutionSnapshot, type HarnessState, type Job } from "../model.js";
import { piRpcAgentDir } from "../pi-rpc-spool.js";
import { message, preflightFailureResult } from "./helpers.js";
import { PI_RPC_SDK_ENTRY } from "./resources.js";
import { rpcEnabled, runtimeRole, snapshotCredentialMode, workerCompactionMode } from "./runtime-contract.js";
import type { ControllerContext } from "./context.js";
import type { TickResult } from "./types.js";
import type { HarnessConfig, RuntimePreflightPort } from "../ports.js";

export type RuntimePreflightReport = {
  version: 1;
  generatedAt: string;
  configDigest: string;
  lanes: Attempt["lane"][];
  ok: boolean;
  docker: { required: boolean; available: boolean | null };
  failure: { code: string; retryable: boolean } | null;
};

export async function configuredRuntimePreflightReport(
  config: HarnessConfig,
  preflight: RuntimePreflightPort,
  lanes: Attempt["lane"][],
  generatedAt: string,
): Promise<RuntimePreflightReport> {
  const base = {
    version: 1 as const,
    generatedAt,
    configDigest: digest(config),
    lanes: [...lanes],
    docker: { required: config.preflight?.dockerRequired === true, available: null as boolean | null },
  };
  try {
    const result = await probeRuntimePreflight(config, preflight, lanes);
    return {
      ...base,
      ok: true,
      docker: {
        ...base.docker,
        available: base.docker.required ? result.dockerHost !== null : null,
      },
      failure: null,
    };
  } catch (error) {
    const failure = preflightFailureResult(null, error);
    return {
      ...base,
      ok: false,
      failure: {
        code: failure.failureCode ?? "preflight_failed",
        retryable: failure.retryable ?? false,
      },
    };
  }
}

export async function runRuntimePreflight(
  ctx: ControllerContext,
  lanes: Attempt["lane"][],
  jobId: string | null,
  executionSnapshot?: ExecutionSnapshot,
): Promise<
  | { ok: true; dockerHost: string | null }
  | { ok: false; result: TickResult }
> {
  try {
    return { ok: true, ...(await probeRuntimePreflight(ctx.deps.config, ctx.deps.preflight, lanes, executionSnapshot)) };
  } catch (error) {
    return {
      ok: false,
      result: preflightFailureResult(jobId, error),
    };
  }
}

export async function probeRuntimePreflight(
  config: HarnessConfig,
  preflight: RuntimePreflightPort,
  lanes: Attempt["lane"][],
  executionSnapshot?: ExecutionSnapshot,
): Promise<{ dockerHost: string | null }> {
  let dockerHost: string | null = executionSnapshot?.dockerHost ?? null;
  if (!executionSnapshot && config.preflight?.dockerRequired === true) {
    dockerHost = (await preflight.probeDocker({ cwd: config.localPath })).host;
  }
  const preclaimNeedsRpc = !executionSnapshot && lanes.some((lane) => rpcEnabled(config, lane));
  const preclaimNeedsCanonicalOAuth = !executionSnapshot && lanes.some((lane) => (
    runtimeRole(config, lane).credentialMode === "canonical-oauth"
  ));
  const preclaimRuntime = preclaimNeedsRpc
    ? await preflight.inspectPi({ cwd: config.localPath, piBin: config.preflight?.piBin ?? "pi" })
    : null;
  if (!executionSnapshot && lanes.includes("worker") && rpcEnabled(config, "worker")
    && workerCompactionMode(config) === "controlled-threshold"
    && preclaimRuntime?.version !== QUALIFIED_CONTROLLED_COMPACTION_PI_VERSION) {
    throw new Error(`controlled Worker compaction requires Pi ${QUALIFIED_CONTROLLED_COMPACTION_PI_VERSION}`);
  }
  const preclaimCredentialAgentDir = preclaimNeedsRpc || preclaimNeedsCanonicalOAuth
    ? (await preflight.assertNoAmbientSystemPrompt({ cwd: config.localPath })).agentDir
    : null;
  const preclaimCredentialDomainId = preclaimNeedsCanonicalOAuth
    ? (await preflight.credentialDomain({ credentialAgentDir: preclaimCredentialAgentDir! })).credentialDomainId
    : null;
  for (const lane of lanes) {
    const useRpc = executionSnapshot?.adapter === "pi-rpc" || (!executionSnapshot && rpcEnabled(config, lane));
    const role = runtimeRole(config, lane);
    const credentialMode = executionSnapshot
      ? executionSnapshot.credentialDomainId ? "canonical-oauth" : useRpc ? snapshotCredentialMode(executionSnapshot) : undefined
      : useRpc || role.credentialMode === "canonical-oauth" ? role.credentialMode : undefined;
    const credentialAgentDir = useRpc || credentialMode === "canonical-oauth"
      ? executionSnapshot?.context?.agentDir ?? preclaimCredentialAgentDir ?? undefined
      : undefined;
    const credentialDomainId = credentialMode === "canonical-oauth"
      ? executionSnapshot?.credentialDomainId ?? preclaimCredentialDomainId ?? undefined
      : undefined;
    const modelConfigs = executionSnapshot?.resources.filter((resource) => resource.kind === "model-config") ?? [];
    if (credentialMode === "canonical-model-config" && executionSnapshot && modelConfigs.length !== 1) {
      throw new Error("Reviewer RPC snapshot must bind exactly one models.json");
    }
    const modelConfig = useRpc && credentialMode === "canonical-model-config"
      ? modelConfigs[0] ?? executionResource("model-config", join(credentialAgentDir!, "models.json"))
      : undefined;
    const rpcHost = useRpc
      ? executionSnapshot
        ? executionSnapshot.resources.find((resource) => resource.kind === "runtime" && basename(resource.path) === "pi-rpc-sdk-entry.js")
        : executionResource("runtime", PI_RPC_SDK_ENTRY)
      : undefined;
    await preflight.probeProvider({
      lane,
      cwd: config.localPath,
      roleArgv: executionSnapshot?.argv ?? role.argv,
      piBin: executionSnapshot?.executable ?? preclaimRuntime?.executable ?? config.preflight?.piBin ?? "pi",
      ...(useRpc ? { piVersion: executionSnapshot?.runtimeVersion ?? preclaimRuntime!.version } : {}),
      ...(useRpc ? { agentDir: executionSnapshot ? piRpcAgentDir(executionSnapshot) : resolve(config.stateDir, "preflight", `pi-rpc-${lane}-agent`) } : {}),
      ...(credentialAgentDir ? { credentialAgentDir } : {}),
      ...(credentialMode ? { credentialMode } : {}),
      ...(credentialDomainId ? { credentialDomainId } : {}),
      ...(credentialMode === "canonical-oauth" && (executionSnapshot?.provider ?? role.provider)
        ? { credentialProvider: executionSnapshot?.provider ?? role.provider! }
        : {}),
      ...(modelConfig ? { modelConfig } : {}),
      ...(rpcHost ? { rpcHost } : {}),
    });
  }
  return { dockerHost };
}

export async function verifyExecutionSnapshot(
  ctx: ControllerContext,
  state: HarnessState,
  job: Job,
  attempt: Attempt,
): Promise<TickResult | null> {
  const expected = attempt.executionSnapshot!;
  try {
    const ambient = await ctx.deps.preflight.assertNoAmbientSystemPrompt({ cwd: job.worktree!.path });
    if (!expected.context || ambient.agentDir !== expected.context.agentDir) {
      throw new Error("Pi agent directory changed after attempt preparation");
    }
    await ctx.deps.git.verifyTrustedContext(expected.context);
    const credentialDomainId = expected.credentialDomainId
      ? (await ctx.deps.preflight.credentialDomain({ credentialAgentDir: expected.context.agentDir })).credentialDomainId
      : undefined;
    if (expected.dockerHost !== null) {
      const docker = await ctx.deps.preflight.probeDocker({ cwd: ctx.deps.config.localPath });
      if (docker.host !== expected.dockerHost) throw new Error("Docker host changed after attempt preparation");
    }
    const runtime = await ctx.deps.preflight.inspectPi({ cwd: ctx.deps.config.localPath, piBin: expected.executable });
    const observed = buildExecutionSnapshot({
      adapter: expected.adapter,
      executable: runtime.executable,
      runtimeVersion: runtime.version,
      argv: expected.argv,
      retryMode: expected.retryMode,
      compactionMode: expected.compactionMode,
      compactionPolicy: expected.compactionPolicy,
      credentialMode: expected.credentialMode,
      ...(credentialDomainId ? { credentialDomainId } : {}),
      ...(expected.axisConcurrency ? { axisConcurrency: expected.axisConcurrency } : {}),
      ...(expected.runtimeTimeouts ? { runtimeTimeouts: expected.runtimeTimeouts } : {}),
      ...(expected.runtimeDeadlineAt !== undefined ? { runtimeDeadlineAt: expected.runtimeDeadlineAt } : {}),
      ...(expected.validationTimeoutMs !== undefined ? { validationTimeoutMs: expected.validationTimeoutMs } : {}),
      dockerHost: expected.dockerHost,
      context: expected.context,
      extraResources: expected.resources
        .filter((resource) => resource.kind === "agent" || resource.kind === "runtime" || resource.kind === "model-config")
        .map((resource) => ({ kind: resource.kind as "agent" | "runtime" | "model-config", path: resource.path })),
    });
    if (digest(observed) === digest(expected)) return null;
  } catch (error) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: attempt.lane,
      summary: `attempt execution snapshot cannot be verified: ${message(error)}`,
      attemptResult: null,
    });
  }
  return ctx.block(state, job, {
    class: "integrity_violation",
    lane: attempt.lane,
    summary: "Pi executable, version, arguments, or resources changed after attempt preparation",
    attemptResult: null,
  });
}
