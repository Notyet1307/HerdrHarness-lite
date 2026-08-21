import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { digest, type AgentHandle, type Attempt, type AttemptResult, type ExecutionSnapshot } from "../model.js";
import { executionResourceDigest } from "../attempt-plan.js";
import type { AttemptRuntimePort, HerdrPort } from "../ports.js";
import {
  ensurePrivateDirectory,
  readJson,
  readJsonIfExists,
  rpcGeneration,
  rpcRuntimeRoot,
  sameJson,
  spoolPath,
  type PiRpcPlan,
  writeAtomicJson,
  writeExclusiveJson,
} from "../pi-rpc-spool.js";
import { assertQualifiedPiRpcVersion } from "../compatibility.js";
import {
  formatSafePiRpcDiagnostic,
  makeSafeRuntimeDiagnostic,
  PiRpcRuntimeFailure,
  safePiRpcDiagnosticFrom,
} from "../pi-rpc-diagnostics.js";
import { renderPinnedWorkerTaskData } from "../prompts.js";
import { MAX_TIMEOUT_MS, snapshotRuntimeTimeouts } from "../runtime-timeouts.js";

const READY_TIMEOUT_MS = 30_000;
const ACCEPT_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
const RUNNER_FAILURE_STAGES = new Set([
  "startup", "handshake", "await-dispatch", "dispatch", "agent-run",
  "child-shutdown", "rpc-output", "credential-postflight", "child-exit",
]);
const RUNNER_FAILURE_CLASSES = new Set([
  "rate_limit", "authentication", "context_limit", "timeout",
  "upstream_5xx", "network", "assistant_aborted", "unknown",
]);

type RuntimeReceipt = {
  version: 1;
  attemptId: string;
  generation: string;
  planDigest: string;
  ok: boolean;
  error?: string;
  failureStage?: string;
  failureClass?: string;
  failureDomain?: string;
  failureCode?: string;
  retryable?: boolean;
  diagnosticFingerprint?: string;
  httpStatus?: number;
  providerApi?: string;
  phase?: string;
  turnCount?: number;
  assistantMessageCount?: number;
  toolExecutionCount?: number;
  toolErrorCount?: number;
  transcriptSizeBucket?: string;
  childExit?: { code: number | null; signal: string | null } | null;
  assistantContentObserved?: boolean;
  toolCallObserved?: boolean;
  toolExecutionStarted?: boolean;
  durableResultPresent?: boolean;
  worktreeChanged?: boolean;
  commitCreated?: boolean;
};

type OwnerReceipt = RuntimeReceipt & { runnerPid: number };
type ReadyReceipt = RuntimeReceipt & {
  piPid?: number;
  autoRetryDisableAccepted: true;
  autoCompactionEnabled: false;
  compactionMode: ExecutionSnapshot["compactionMode"];
  compactionPolicy?: ExecutionSnapshot["compactionPolicy"];
  credentialMode: ExecutionSnapshot["credentialMode"];
  isolatedAgentDir: string;
};

type RuntimeProgressReceipt = {
  version: 1;
  attemptId: string;
  generation: string;
  planDigest: string;
  lastProgressAt: string;
  lastProgressType: string;
  eventCount: number;
  elapsedMs: number;
  resultPresent: boolean;
  runnerPid: number;
  childPid: number | null;
  digest: string;
};

export class PiRpcRuntime implements AttemptRuntimePort {
  constructor(private readonly host: Pick<HerdrPort, "runInPane"> & Partial<Pick<HerdrPort, "close">>) {}

  async startAgent(input: { handle: AgentHandle; attempt: Attempt; cwd: string; argv: string[] }): Promise<void> {
    const plan = this.plan(input);
    let remainingTotalMs: number;
    try {
      remainingTotalMs = remainingAttemptTimeout(input.attempt);
    } catch (error) {
      if (existsSync(spoolPath(plan.runtimeRoot, "owner.json"))) await this.cleanupRuntime(plan, input.handle, "attempt_deadline");
      else await this.closePane(input.handle);
      throw error;
    }
    const runnerPath = boundRuntimeResource(plan, "pi-rpc-runner.js");
    const sdkEntryPath = boundRuntimeResource(plan, "pi-rpc-sdk-entry.js");
    ensurePrivateDirectory(plan.runtimeRoot);
    const planPath = spoolPath(plan.runtimeRoot, "plan.json");
    const existingPlan = readJsonIfExists<PiRpcPlan>(planPath);
    if (existingPlan && !sameJson(existingPlan, plan)) throw new Error("Pi RPC runtime plan changed after preparation");
    if (!existingPlan) writeExclusiveJson(planPath, plan);

    const readyPath = spoolPath(plan.runtimeRoot, "ready.json");
    const ready = readJsonIfExists<ReadyReceipt>(readyPath);
    if (ready) {
      assertReceipt(ready, plan, "ready");
      if (!ready.ok) {
        if (!await this.cleanupRuntime(plan, input.handle, "runtime_stall")) throw terminalMissingFailure();
        throw runtimeFailure(ready, "Pi RPC runner is not ready");
      }
      assertRuntimePolicy(ready, plan);
      return;
    }
    const terminal = readJsonIfExists<RuntimeReceipt>(spoolPath(plan.runtimeRoot, "terminal.json"));
    if (terminal) {
      if (!await this.cleanupRuntime(plan, input.handle, "runtime_stall")) throw terminalMissingFailure();
      throw runtimeFailure(terminal, "Pi RPC runner terminated before ready");
    }

    if (!existsSync(spoolPath(plan.runtimeRoot, "owner.json"))) {
      await this.host.runInPane({
        handle: input.handle,
        command: process.execPath,
        argv: [runnerPath, "--sdk-entry", sdkEntryPath, "--plan", planPath],
        timeoutMs: Math.min(READY_TIMEOUT_MS, remainingTotalMs),
      });
    }
    let observed: ReadyReceipt;
    try {
      observed = await waitForReceipt(plan, "ready.json", Math.min(READY_TIMEOUT_MS, remainingTotalMs)) as ReadyReceipt;
    } catch {
      const failure = deadlineObservationFailure(plan);
      if (!await this.cleanupRuntime(plan, input.handle, failure.diagnostic.code ?? "runtime_stall")) {
        throw terminalMissingFailure();
      }
      throw failure;
    }
    assertReceipt(observed, plan, "ready");
    if (!observed.ok) {
      if (!await this.cleanupRuntime(plan, input.handle, "runtime_stall")) throw terminalMissingFailure();
      throw runtimeFailure(observed, "Pi RPC runner is not ready");
    }
    assertRuntimePolicy(observed, plan);
  }

  async prompt(input: {
    handle: AgentHandle;
    attempt: Attempt;
    dispatchId: string;
    skill: "implement" | "code-review";
    text: string;
  }): Promise<void> {
    const plan = this.plan({
      handle: input.handle,
      attempt: input.attempt,
      cwd: "",
      argv: input.attempt.executionSnapshot?.argv ?? [],
    }, false);
    const expectedSkill = input.attempt.lane === "worker" ? "implement" : "code-review";
    let remainingTotalMs: number;
    try {
      remainingTotalMs = remainingAttemptTimeout(input.attempt);
    } catch (error) {
      await this.cleanupRuntime(plan, input.handle, "attempt_deadline");
      throw error;
    }
    if (input.skill !== expectedSkill) {
      await this.cleanupRuntime(plan, input.handle, "policy_violation");
      throw new Error(`Pi RPC ${input.attempt.lane} dispatch requires ${expectedSkill}`);
    }
    if (digest(input.text) !== input.attempt.promptDigest) {
      await this.cleanupRuntime(plan, input.handle, "policy_violation");
      throw new Error("Pi RPC prompt body differs from the immutable prompt digest");
    }
    const dispatch = {
      version: 1,
      attemptId: plan.attemptId,
      generation: plan.generation,
      planDigest: plan.planDigest,
      dispatchId: input.dispatchId,
      promptDigest: input.attempt.promptDigest,
      message: `/skill:${input.skill} [harness-dispatch:${input.dispatchId}]\n${input.text}`,
    };
    const path = spoolPath(plan.runtimeRoot, "dispatch.json");
    const existing = readJsonIfExists<typeof dispatch>(path);
    if (existing && !sameJson(existing, dispatch)) {
      await this.cleanupRuntime(plan, input.handle, "policy_violation");
      throw new Error("Pi RPC dispatch identity changed after persistence");
    }
    if (!existing) writeExclusiveJson(path, dispatch);

    let accepted: RuntimeReceipt;
    try {
      accepted = await waitForReceipt(plan, "accepted.json", Math.min(ACCEPT_TIMEOUT_MS, remainingTotalMs));
    } catch {
      const failure = deadlineObservationFailure(plan);
      if (!await this.cleanupRuntime(plan, input.handle, failure.diagnostic.code ?? "runtime_stall")) {
        throw terminalMissingFailure();
      }
      throw failure;
    }
    assertReceipt(accepted, plan, "accepted");
    if (!accepted.ok) {
      if (!await this.cleanupRuntime(plan, input.handle, "runtime_stall")) throw terminalMissingFailure();
      throw new Error(`Pi RPC prompt was rejected: ${accepted.error ?? "unknown failure"}`);
    }
    if ((accepted as RuntimeReceipt & { dispatchId?: string }).dispatchId !== input.dispatchId) {
      await this.cleanupRuntime(plan, input.handle, "policy_violation");
      throw new Error("Pi RPC accepted receipt has a different dispatch identity");
    }
  }

  async wait(input: {
    handle: AgentHandle;
    attempt: Attempt;
    resultPath: string;
    expectedJobId: string;
    expectedAttemptId: string;
    expectedLane: Attempt["lane"];
  }): Promise<{ agentStatus: "done" | "blocked"; result: AttemptResult | null; diagnostic: string | null }> {
    const plan = this.plan({
      handle: input.handle,
      attempt: input.attempt,
      cwd: "",
      argv: input.attempt.executionSnapshot?.argv ?? [],
    }, false);
    if (!existsSync(spoolPath(plan.runtimeRoot, "dispatch.json"))) {
      await this.cleanupRuntime(plan, input.handle, "policy_violation");
      throw new Error("Pi RPC running Attempt has no durable dispatch intent; prompt will not be replayed");
    }
    let terminal: RuntimeReceipt;
    try {
      terminal = await waitForReceipt(plan, "terminal.json", terminalTimeoutMs(plan));
    } catch {
      const failure = deadlineObservationFailure(plan);
      if (!await this.cleanupRuntime(plan, input.handle, failure.diagnostic.code ?? "runtime_stall")) {
        throw terminalMissingFailure();
      }
      throw failure;
    }
    assertReceipt(terminal, plan, "terminal");
    let terminated: RuntimeReceipt;
    try {
      terminated = await waitForReceipt(plan, "terminated.json", terminationTimeoutMs(plan));
    } catch {
      if (!await this.cleanupRuntime(plan, input.handle, "runtime_stall")) throw terminalMissingFailure();
      const fallback = readJsonIfExists<RuntimeReceipt>(spoolPath(plan.runtimeRoot, "terminated.json"));
      if (!fallback) throw terminalMissingFailure();
      terminated = fallback;
    }
    assertReceipt(terminated, plan, "terminated");
    if (!terminated.ok) {
      await this.closePane(input.handle);
      throw new Error(`Pi RPC termination is not confirmed: ${terminated.error ?? "unknown failure"}`);
    }
    if (!terminal.ok) {
      await this.closePane(input.handle);
      throw runtimeFailure(terminal, "Pi RPC policy/runtime failure");
    }
    const result = existsSync(input.resultPath)
      ? JSON.parse(readFileSync(input.resultPath, "utf8")) as AttemptResult
      : null;
    if (!result) {
      const diagnostic = makeSafeRuntimeDiagnostic({
        domain: "acceptance",
        code: "result_missing",
        stage: "result-validation",
        failureDomain: "result",
        failureCode: "result_missing",
        retryable: false,
      });
      await this.closePane(input.handle);
      throw new PiRpcRuntimeFailure(
        `Pi RPC settled without a durable result (${formatSafePiRpcDiagnostic(diagnostic)})`,
        diagnostic,
      );
    }
    return {
      agentStatus: "done",
      result,
      diagnostic: null,
    };
  }

  async terminate(input: {
    handle: AgentHandle;
    attempt: Attempt;
    reason: "completed" | "recovery" | "cancelled";
  }): Promise<void> {
    const plan = this.plan({
      handle: input.handle,
      attempt: input.attempt,
      cwd: "",
      argv: input.attempt.executionSnapshot?.argv ?? [],
    }, false);
    const already = readJsonIfExists<RuntimeReceipt>(spoolPath(plan.runtimeRoot, "terminated.json"));
    if (already) {
      assertReceipt(already, plan, "terminated");
      if (!already.ok) {
        await this.closePane(input.handle);
        throw new Error(`Pi RPC termination failed: ${already.error ?? "unknown failure"}`);
      }
      await this.closePane(input.handle);
      return;
    }
    if (!await this.cleanupRuntime(plan, input.handle, input.reason)) {
      throw new Error("Pi RPC termination failed: child and runner exit are not confirmed");
    }
  }

  private async closePane(handle: AgentHandle): Promise<void> {
    if (this.host.close) await this.host.close(handle);
  }

  private async cleanupRuntime(plan: PiRpcPlan, handle: AgentHandle, reason: string): Promise<boolean> {
    const existing = readJsonIfExists<RuntimeReceipt>(spoolPath(plan.runtimeRoot, "terminated.json"));
    if (existing) {
      assertReceipt(existing, plan, "terminated");
      await this.closePane(handle);
      return existing.ok;
    }
    writeTerminateIntent(plan, reason);
    if (!existsSync(spoolPath(plan.runtimeRoot, "owner.json"))) {
      const confirmed = await forceRuntimeCleanup(plan);
      await this.closePane(handle);
      return confirmed;
    }
    let confirmed = false;
    try {
      const acknowledged = await waitForReceipt(plan, "terminating.json", runtimeTimeouts(plan).sigtermGraceMs);
      assertReceipt(acknowledged, plan, "terminating");
      const terminated = await waitForReceipt(plan, "terminated.json", terminationTimeoutMs(plan));
      assertReceipt(terminated, plan, "terminated");
      confirmed = terminated.ok;
    } catch {
      confirmed = await forceRuntimeCleanup(plan);
    }
    await this.closePane(handle);
    return confirmed;
  }

  private plan(
    input: { handle: AgentHandle; attempt: Attempt; cwd: string; argv: string[] },
    requireLaunchIdentity = true,
  ): PiRpcPlan {
    const snapshot = input.attempt.executionSnapshot;
    if (snapshot?.adapter !== "pi-rpc" || !input.attempt.planDigest) {
      throw new Error("Pi RPC received an unbound Attempt");
    }
    assertQualifiedPiRpcVersion(snapshot.runtimeVersion);
    const runtimeRoot = rpcRuntimeRoot(snapshot);
    const persisted = readJsonIfExists<PiRpcPlan>(spoolPath(runtimeRoot, "plan.json"));
    if (!requireLaunchIdentity) {
      if (!persisted) throw new Error("Pi RPC runtime has no durable plan");
      if (
        persisted.attemptId !== input.attempt.id
        || persisted.planDigest !== input.attempt.planDigest
        || persisted.promptDigest !== input.attempt.promptDigest
        || !sameJson(persisted.handle, input.handle)
      ) {
        throw new Error("Pi RPC runtime identity differs from the ledger Attempt");
      }
      return persisted;
    }
    if (!input.cwd || !sameJson(input.argv, snapshot.argv)) throw new Error("Pi RPC launch differs from the execution snapshot");
    const pinnedContent = snapshot.context?.lane === "worker" && snapshot.compactionMode === "controlled-threshold"
      ? renderPinnedWorkerTaskData(input.attempt)
      : null;
    return {
      version: 1,
      attemptId: input.attempt.id,
      generation: rpcGeneration(input.attempt.id, input.attempt.planDigest, input.handle),
      planDigest: input.attempt.planDigest,
      promptDigest: input.attempt.promptDigest,
      handle: input.handle,
      cwd: input.cwd,
      resultPath: input.attempt.resultPath,
      runtimeRoot,
      ...(pinnedContent ? {
        pinnedTaskData: { version: 1, digest: digest(pinnedContent), content: pinnedContent },
      } : {}),
      snapshot: snapshot as PiRpcPlan["snapshot"],
    };
  }
}

async function waitForReceipt(plan: PiRpcPlan, name: string, timeoutMs: number): Promise<RuntimeReceipt> {
  const started = Date.now();
  for (;;) {
    const receipt = readJsonIfExists<RuntimeReceipt>(spoolPath(plan.runtimeRoot, name));
    if (receipt) return receipt;
    const terminal = ["ready.json", "accepted.json", "terminating.json"].includes(name)
      ? readJsonIfExists<RuntimeReceipt>(spoolPath(plan.runtimeRoot, "terminal.json"))
      : null;
    if (terminal && !terminal.ok) return terminal;
    const owner = readJsonIfExists<OwnerReceipt>(spoolPath(plan.runtimeRoot, "owner.json"));
    if (owner && !processAlive(owner.runnerPid)) throw new Error(`Pi RPC runner exited before ${name}`);
    if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for Pi RPC ${name}`);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, POLL_MS));
  }
}

function runtimeTimeouts(plan: PiRpcPlan) {
  return snapshotRuntimeTimeouts(plan.snapshot, plan.snapshot.context!.lane);
}

function remainingAttemptTimeout(attempt: Attempt): number {
  const snapshot = attempt.executionSnapshot;
  if (!snapshot) throw new Error("Pi RPC Attempt has no execution snapshot");
  const started = Date.parse(attempt.startedAt);
  if (!Number.isFinite(started)) throw new Error("Pi RPC Attempt has an invalid start time");
  const deadline = snapshot.runtimeDeadlineAt ? Date.parse(snapshot.runtimeDeadlineAt) : started + snapshotRuntimeTimeouts(snapshot, attempt.lane).totalTimeoutMs;
  if (!Number.isFinite(deadline)) throw new Error("Pi RPC Attempt has an invalid runtime deadline");
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const diagnostic = makeSafeRuntimeDiagnostic({
      domain: "execution",
      code: "attempt_deadline",
      stage: "startup",
      failureDomain: "runtime",
      failureCode: "attempt_deadline",
      retryable: false,
    });
    throw new PiRpcRuntimeFailure("Pi RPC Attempt ended with attempt_deadline before launch or dispatch", diagnostic);
  }
  return remaining;
}

function terminationTimeoutMs(plan: PiRpcPlan): number {
  const timeouts = runtimeTimeouts(plan);
  return Math.min(MAX_TIMEOUT_MS, timeouts.sigtermGraceMs + (3 * timeouts.sigkillGraceMs) + (2 * POLL_MS));
}

function terminalTimeoutMs(plan: PiRpcPlan): number {
  const totalTimeoutMs = runtimeTimeouts(plan).totalTimeoutMs;
  const elapsedMs = readRuntimeProgress(plan)?.elapsedMs ?? 0;
  const remaining = plan.snapshot.runtimeDeadlineAt
    ? Date.parse(plan.snapshot.runtimeDeadlineAt) - Date.now()
    : totalTimeoutMs - elapsedMs;
  return Math.max(POLL_MS, Math.min(MAX_TIMEOUT_MS, remaining + terminationTimeoutMs(plan)));
}

function writeTerminateIntent(plan: PiRpcPlan, reason: string): void {
  const intent = {
    version: 1,
    attemptId: plan.attemptId,
    generation: plan.generation,
    planDigest: plan.planDigest,
    reason,
  };
  const path = spoolPath(plan.runtimeRoot, "terminate.json");
  const existing = readJsonIfExists<typeof intent>(path);
  if (existing) {
    if (
      existing.version !== intent.version
      || existing.attemptId !== intent.attemptId
      || existing.generation !== intent.generation
      || existing.planDigest !== intent.planDigest
      || typeof existing.reason !== "string"
    ) throw new Error("Pi RPC terminate intent changed after persistence");
    return;
  }
  writeExclusiveJson(path, intent);
}

function deadlineObservationFailure(plan: PiRpcPlan): PiRpcRuntimeFailure {
  const timeouts = runtimeTimeouts(plan);
  const progress = readRuntimeProgress(plan);
  const code = (plan.snapshot.runtimeDeadlineAt && Date.now() >= Date.parse(plan.snapshot.runtimeDeadlineAt))
    || (progress && progress.elapsedMs >= timeouts.totalTimeoutMs)
    ? "attempt_deadline"
    : "runtime_stall";
  const diagnostic = makeSafeRuntimeDiagnostic({
    domain: code === "runtime_stall" ? "observation" : "execution",
    code,
    stage: "terminal-observation",
    failureDomain: "runtime",
    failureCode: code,
    retryable: false,
  });
  return new PiRpcRuntimeFailure(`Pi RPC terminal observation exceeded the ${code}`, diagnostic);
}

function terminalMissingFailure(): PiRpcRuntimeFailure {
  const diagnostic = makeSafeRuntimeDiagnostic({
    domain: "observation",
    code: "rpc_terminal_missing",
    stage: "terminal-observation",
    failureDomain: "runtime",
    failureCode: "rpc_terminal_missing",
    retryable: false,
  });
  return new PiRpcRuntimeFailure("Pi RPC rpc_terminal_missing: terminated receipt or process cleanup is not confirmed", diagnostic);
}

function readRuntimeProgress(plan: PiRpcPlan): RuntimeProgressReceipt | null {
  const value = readJsonIfExists<RuntimeProgressReceipt>(spoolPath(plan.runtimeRoot, "runtime-progress.json"));
  if (!value) return null;
  const { digest: claimedDigest, ...body } = value;
  if (
    Object.keys(value).sort().join(",") !== "attemptId,childPid,digest,elapsedMs,eventCount,generation,lastProgressAt,lastProgressType,planDigest,resultPresent,runnerPid,version"
    ||
    value.version !== 1
    || value.attemptId !== plan.attemptId
    || value.generation !== plan.generation
    || value.planDigest !== plan.planDigest
    || !Number.isFinite(Date.parse(value.lastProgressAt))
    || !/^[a-z][a-z0-9_]{0,63}$/.test(value.lastProgressType)
    || !Number.isSafeInteger(value.eventCount) || value.eventCount < 0
    || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0
    || typeof value.resultPresent !== "boolean"
    || !validPid(value.runnerPid)
    || (value.childPid !== null && !validPid(value.childPid))
    || !/^[0-9a-f]{64}$/.test(claimedDigest)
    || digest(body) !== claimedDigest
  ) return null;
  return value;
}

async function forceRuntimeCleanup(plan: PiRpcPlan): Promise<boolean> {
  const owner = readJsonIfExists<OwnerReceipt>(spoolPath(plan.runtimeRoot, "owner.json"));
  const ready = readJsonIfExists<ReadyReceipt>(spoolPath(plan.runtimeRoot, "ready.json"));
  const progress = readRuntimeProgress(plan);
  try {
    if (owner) assertReceipt(owner, plan, "owner");
    if (ready) assertReceipt(ready, plan, "ready");
  } catch {
    return false;
  }
  const runnerPid = owner && validPid(owner.runnerPid) && owner.runnerPid !== process.pid ? owner.runnerPid : null;
  if (ready && validPid(ready.piPid) && progress?.childPid !== null && progress?.childPid !== undefined && progress.childPid !== ready.piPid) {
    return false;
  }
  const childPid = progress?.childPid ?? (ready && validPid(ready.piPid) ? ready.piPid : null);
  const childIdentityComplete = owner === null || progress !== null || (ready !== null && validPid(ready.piPid));
  const timeouts = runtimeTimeouts(plan);
  if (!runnerPid && !childPid) {
    if (!childIdentityComplete) return false;
    writeFallbackTerminated(plan);
    return true;
  }
  try {
    const runnerOwned = !runnerPid || !processAlive(runnerPid) || processCommandMatches(runnerPid, [
      boundRuntimeResource(plan, "pi-rpc-runner.js"),
      spoolPath(plan.runtimeRoot, "plan.json"),
    ]);
    const childOwned = !childPid || !processAlive(childPid) || processCommandMatches(childPid, [
      boundRuntimeResource(plan, "pi-rpc-sdk-entry.js"),
      spoolPath(plan.runtimeRoot, "pi-agent"),
    ]);
    if (!runnerOwned || !childOwned) return false;
  } catch {
    return false;
  }
  if (childPid && processGroupAlive(childPid)) signalGroup(childPid, "SIGTERM");
  if (runnerPid && processAlive(runnerPid)) signalPid(runnerPid, "SIGTERM");
  await delay(timeouts.sigtermGraceMs);
  if (childPid && processGroupAlive(childPid)) signalGroup(childPid, "SIGKILL");
  if (runnerPid && processAlive(runnerPid)) signalPid(runnerPid, "SIGKILL");
  await delay(timeouts.sigkillGraceMs);
  const confirmed = childIdentityComplete
    && (!childPid || !processGroupAlive(childPid))
    && (!runnerPid || !processAlive(runnerPid));
  if (confirmed) writeFallbackTerminated(plan);
  return confirmed;
}

function writeFallbackTerminated(plan: PiRpcPlan): void {
  if (existsSync(spoolPath(plan.runtimeRoot, "terminated.json"))) return;
  writeAtomicJson(spoolPath(plan.runtimeRoot, "terminated.json"), {
    version: 1,
    attemptId: plan.attemptId,
    generation: plan.generation,
    planDigest: plan.planDigest,
    ok: true,
    reason: "controller fallback process exit confirmed",
    source: "controller-fallback",
  });
}

function validPid(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try { process.kill(-pid, signal); } catch { /* Already exited. */ }
}

function signalPid(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try { process.kill(pid, signal); } catch { /* Already exited. */ }
}

function processCommandMatches(pid: number, expectedTokens: string[]): boolean {
  const result = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return false;
  const command = result.stdout.trim();
  return command.length > 0 && expectedTokens.every((token) => command.includes(token));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function assertReceipt(receipt: RuntimeReceipt, plan: PiRpcPlan, label: string): void {
  if (
    receipt.version !== 1
    || receipt.attemptId !== plan.attemptId
    || receipt.generation !== plan.generation
    || receipt.planDigest !== plan.planDigest
  ) throw new Error(`Pi RPC ${label} receipt has a different identity`);
  try {
    safePiRpcDiagnosticFrom(receipt);
  } catch {
    throw new Error(`Pi RPC ${label} receipt has an invalid runtime diagnostic`);
  }
}

function runtimeFailure(receipt: RuntimeReceipt, prefix: string): Error {
  const diagnostic = safePiRpcDiagnosticFrom(receipt);
  const safeError = safeReceiptError(receipt.error);
  if (diagnostic) {
    return new PiRpcRuntimeFailure(
      `${prefix}: ${safeError} (${formatSafePiRpcDiagnostic(diagnostic)})`,
      diagnostic,
    );
  }
  const details: string[] = [];
  if (receipt.failureClass && RUNNER_FAILURE_CLASSES.has(receipt.failureClass)) {
    details.push(`class=${receipt.failureClass}`);
    if (typeof receipt.retryable === "boolean") details.push(`retryable=${receipt.retryable ? "yes" : "no"}`);
  }
  if (receipt.failureStage && RUNNER_FAILURE_STAGES.has(receipt.failureStage)) details.push(`stage=${receipt.failureStage}`);
  const exit = receipt.childExit;
  if (exit && Number.isInteger(exit.code) && exit.code! >= 0 && exit.code! <= 255 && exit.signal === null) {
    details.push(`child=exit:${exit.code}`);
  } else if (exit && exit.code === null && typeof exit.signal === "string" && /^SIG[A-Z0-9]+$/.test(exit.signal)) {
    details.push(`child=signal:${exit.signal}`);
  } else if (exit && exit.code === null && exit.signal === null) {
    details.push("child=unknown");
  }
  if (typeof receipt.diagnosticFingerprint === "string" && /^[0-9a-f]{64}$/.test(receipt.diagnosticFingerprint)) {
    details.push(`fingerprint=${receipt.diagnosticFingerprint.slice(0, 12)}`);
  }
  return new Error(`${prefix}: ${safeError}${details.length ? ` (${details.join(", ")})` : ""}`);
}

function safeReceiptError(value: unknown): string {
  if (value === "Pi RPC assistant ended with error" || value === "Pi RPC assistant ended with aborted") return value;
  if (value === "Pi RPC runner failed") return value;
  return "Pi RPC runtime failed";
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertRuntimePolicy(receipt: ReadyReceipt, plan: PiRpcPlan): void {
  if (
    receipt.autoRetryDisableAccepted !== true
    || receipt.autoCompactionEnabled !== false
    || receipt.compactionMode !== plan.snapshot.compactionMode
    || !sameJson(receipt.compactionPolicy, plan.snapshot.compactionPolicy)
    || receipt.credentialMode !== plan.snapshot.credentialMode
    || receipt.isolatedAgentDir !== join(plan.runtimeRoot, "pi-agent")
  ) {
    throw new Error("Pi RPC ready receipt did not prove retry, compaction, and credential isolation");
  }
}

function boundRuntimeResource(plan: PiRpcPlan, name: string): string {
  const matches = plan.snapshot.resources.filter((resource) => resource.kind === "runtime" && basename(resource.path) === name);
  if (matches.length !== 1) throw new Error(`Pi RPC snapshot must bind exactly one ${name}`);
  const resource = matches[0]!;
  if (executionResourceDigest(dirname(resource.path)) !== resource.digest) {
    throw new Error(`Pi RPC runtime resource changed after preparation: ${name}`);
  }
  return resource.path;
}
