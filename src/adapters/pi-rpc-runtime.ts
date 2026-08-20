import { existsSync, readFileSync } from "node:fs";
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
  writeExclusiveJson,
} from "../pi-rpc-spool.js";
import { assertQualifiedPiRpcVersion } from "../compatibility.js";
import {
  formatSafePiRpcDiagnostic,
  PiRpcRuntimeFailure,
  safePiRpcDiagnosticFrom,
} from "../pi-rpc-diagnostics.js";
import { renderPinnedWorkerTaskData } from "../prompts.js";

const READY_TIMEOUT_MS = 30_000;
const ACCEPT_TIMEOUT_MS = 30_000;
const TERMINATE_TIMEOUT_MS = 30_000;
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
};

type OwnerReceipt = RuntimeReceipt & { runnerPid: number };
type ReadyReceipt = RuntimeReceipt & {
  autoRetryDisableAccepted: true;
  autoCompactionEnabled: false;
  compactionMode: ExecutionSnapshot["compactionMode"];
  compactionPolicy?: ExecutionSnapshot["compactionPolicy"];
  credentialMode: ExecutionSnapshot["credentialMode"];
  isolatedAgentDir: string;
};

export class PiRpcRuntime implements AttemptRuntimePort {
  constructor(private readonly host: Pick<HerdrPort, "runInPane">) {}

  async startAgent(input: { handle: AgentHandle; attempt: Attempt; cwd: string; argv: string[] }): Promise<void> {
    const plan = this.plan(input);
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
      if (!ready.ok) throw runtimeFailure(ready, "Pi RPC runner is not ready");
      assertRuntimePolicy(ready, plan);
      return;
    }
    const terminal = readJsonIfExists<RuntimeReceipt>(spoolPath(plan.runtimeRoot, "terminal.json"));
    if (terminal) throw runtimeFailure(terminal, "Pi RPC runner terminated before ready");

    if (!existsSync(spoolPath(plan.runtimeRoot, "owner.json"))) {
      await this.host.runInPane({
        handle: input.handle,
        command: process.execPath,
        argv: [runnerPath, "--sdk-entry", sdkEntryPath, "--plan", planPath],
      });
    }
    const observed = waitForReceipt(plan, "ready.json", READY_TIMEOUT_MS) as ReadyReceipt;
    assertReceipt(observed, plan, "ready");
    if (!observed.ok) throw runtimeFailure(observed, "Pi RPC runner is not ready");
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
    if (input.skill !== expectedSkill) throw new Error(`Pi RPC ${input.attempt.lane} dispatch requires ${expectedSkill}`);
    if (digest(input.text) !== input.attempt.promptDigest) throw new Error("Pi RPC prompt body differs from the immutable prompt digest");
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
    if (existing && !sameJson(existing, dispatch)) throw new Error("Pi RPC dispatch identity changed after persistence");
    if (!existing) writeExclusiveJson(path, dispatch);

    const accepted = waitForReceipt(plan, "accepted.json", ACCEPT_TIMEOUT_MS);
    assertReceipt(accepted, plan, "accepted");
    if (!accepted.ok) throw new Error(`Pi RPC prompt was rejected: ${accepted.error ?? "unknown failure"}`);
    if ((accepted as RuntimeReceipt & { dispatchId?: string }).dispatchId !== input.dispatchId) {
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
      throw new Error("Pi RPC running Attempt has no durable dispatch intent; prompt will not be replayed");
    }
    const terminal = waitForReceipt(plan, "terminal.json", null);
    assertReceipt(terminal, plan, "terminal");
    if (!terminal.ok) throw runtimeFailure(terminal, "Pi RPC policy/runtime failure");
    const terminated = waitForReceipt(plan, "terminated.json", TERMINATE_TIMEOUT_MS);
    assertReceipt(terminated, plan, "terminated");
    if (!terminated.ok) throw new Error(`Pi RPC termination is not confirmed: ${terminated.error ?? "unknown failure"}`);
    const result = existsSync(input.resultPath)
      ? JSON.parse(readFileSync(input.resultPath, "utf8")) as AttemptResult
      : null;
    return {
      agentStatus: "done",
      result,
      diagnostic: result ? null : `Pi RPC settled without a durable result; events: ${spoolPath(plan.runtimeRoot, "runtime-events.jsonl")}`,
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
      if (!already.ok) throw new Error(`Pi RPC termination failed: ${already.error ?? "unknown failure"}`);
      return;
    }
    const intent = {
      version: 1,
      attemptId: plan.attemptId,
      generation: plan.generation,
      planDigest: plan.planDigest,
      reason: input.reason,
    };
    const path = spoolPath(plan.runtimeRoot, "terminate.json");
    const existing = readJsonIfExists<typeof intent>(path);
    if (existing && !sameJson(existing, intent)) throw new Error("Pi RPC terminate intent changed after persistence");
    if (!existing) writeExclusiveJson(path, intent);
    const receipt = waitForReceipt(plan, "terminated.json", TERMINATE_TIMEOUT_MS);
    assertReceipt(receipt, plan, "terminated");
    if (!receipt.ok) throw new Error(`Pi RPC termination failed: ${receipt.error ?? "unknown failure"}`);
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

function waitForReceipt(plan: PiRpcPlan, name: string, timeoutMs: number | null): RuntimeReceipt {
  const started = Date.now();
  for (;;) {
    const receipt = readJsonIfExists<RuntimeReceipt>(spoolPath(plan.runtimeRoot, name));
    if (receipt) return receipt;
    const terminal = name === "terminal.json" ? null : readJsonIfExists<RuntimeReceipt>(spoolPath(plan.runtimeRoot, "terminal.json"));
    if (terminal && !terminal.ok) return terminal;
    const owner = readJsonIfExists<OwnerReceipt>(spoolPath(plan.runtimeRoot, "owner.json"));
    if (owner && !processAlive(owner.runnerPid)) throw new Error(`Pi RPC runner exited before ${name}`);
    if (timeoutMs !== null && Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for Pi RPC ${name}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
  }
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
