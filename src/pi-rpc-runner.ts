#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
import { digest, type RuntimeTimeouts } from "./model.js";
import { executionResource, executionResourceDigest } from "./attempt-plan.js";
import {
  readJson,
  readJsonIfExists,
  preparePiRpcAgentDir,
  sameJson,
  spoolPath,
  type PiRpcPlan,
  writeAtomicJson,
  writeExclusiveJson,
} from "./pi-rpc-spool.js";
import {
  isQualifiedPiRpcVersion,
  isSupportedPonytailExtension,
  isWorkerControlledCompactionPolicy,
  QUALIFIED_CONTROLLED_COMPACTION_PI_VERSION,
} from "./compatibility.js";
import {
  classifyProviderFailure,
  classifyProviderContinuationLost,
  classifyPiRpcRunnerFailure,
  failurePhase,
  makeSafeRuntimeDiagnostic,
  piRpcRunnerError,
  providerApi,
  type PiRpcProviderApi,
  type SafeRuntimeDiagnostic,
} from "./pi-rpc-diagnostics.js";
import { snapshotRuntimeTimeouts, validTimeoutMs } from "./runtime-timeouts.js";

const MAX_RPC_LINE_BYTES = 1024 * 1024;
const MAX_EVENT_LOG_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
const PROGRESS_WRITE_INTERVAL_MS = 1_000;
const REVIEW_ORIGINAL_AGENT_DIR_ENV = "HERDR_HARNESS_REVIEW_CANONICAL_PI_AGENT_DIR";
const KNOWN_EVENT_TYPES = new Set([
  "agent_start", "agent_end", "agent_settled",
  "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "bash_execution_update", "queue_update",
  "auto_retry_start", "auto_retry_end",
  "compaction_start", "compaction_end",
  "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
  "extension_ui_request", "extension_ui_response",
]);

type JsonObject = Record<string, unknown>;
type Child = ReturnType<typeof spawn>;
type ChildExit = { code: number | null; signal: string | null };
type AssistantFailure = { error: string; diagnostic: SafeRuntimeDiagnostic };
type DeadlineFailure = "runtime_stall" | "attempt_deadline";
type ProgressType =
  | "runner_started"
  | "dispatch_accepted"
  | "assistant_message_start"
  | "assistant_message_update"
  | "assistant_message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "compaction_start"
  | "compaction_end"
  | "provider_retry_progress"
  | "durable_result"
  | "agent_settled"
  | "terminal_receipt";

export class StrictJsonlDecoder {
  private buffer = "";

  push(chunk: string, onRecord?: (record: JsonObject) => void): JsonObject[] {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_RPC_LINE_BYTES && !this.buffer.includes("\n")) {
      throw piRpcRunnerError("rpc_protocol", "rpc_event_oversize", false);
    }
    const records: JsonObject[] = [];
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_RPC_LINE_BYTES) {
        throw piRpcRunnerError("rpc_protocol", "rpc_event_oversize", false);
      }
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw piRpcRunnerError("rpc_protocol", "rpc_invalid_json", false);
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw piRpcRunnerError("rpc_protocol", "rpc_record_not_object", false);
      }
      const record = value as JsonObject;
      records.push(record);
      onRecord?.(record);
    }
    return records;
  }

  finish(): void {
    if (this.buffer.trim()) throw piRpcRunnerError("rpc_protocol", "rpc_incomplete_jsonl", false);
  }
}

class RpcClient {
  private readonly decoder = new StrictJsonlDecoder();
  private readonly pending = new Map<string, {
    command: string;
    resolve: (value: JsonObject) => void;
    reject: (error: Error) => void;
  }>();
  private sequence = 0;
  private fatalError: Error | null = null;
  private stdoutEnded = false;
  readonly exit: Promise<{ code: number | null; signal: string | null }>;
  readonly outputEnded: Promise<void>;

  constructor(private readonly child: Child, private readonly onEvent: (event: JsonObject) => void) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: unknown) => {
      try {
        this.decoder.push(String(chunk), (record) => this.accept(record));
      } catch (error) {
        this.fail(error);
      }
    });
    this.outputEnded = new Promise((resolveEnd) => {
      child.stdout.on("end", () => {
        try {
          this.decoder.finish();
        } catch (error) {
          this.fail(error);
        }
        this.stdoutEnded = true;
        resolveEnd();
      });
    });
    this.exit = new Promise((resolveExit) => {
      child.on("exit", (code: number | null, signal: string | null) => resolveExit({ code, signal }));
      child.on("error", (error: Error) => {
        this.fail(error);
        resolveExit({ code: null, signal: null });
      });
    });
  }

  get failure(): Error | null {
    return this.fatalError;
  }

  get outputFinished(): boolean {
    return this.stdoutEnded;
  }

  async command(type: string, fields: JsonObject = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<JsonObject> {
    if (this.fatalError) throw this.fatalError;
    const id = `runner-${++this.sequence}`;
    const response = new Promise<JsonObject>((resolveResponse, reject) => {
      this.pending.set(id, { command: type, resolve: resolveResponse, reject });
    });
    this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    return withTimeout(response, timeoutMs);
  }

  private accept(record: JsonObject): void {
    if (record.type !== "response") {
      if (typeof record.type !== "string") throw piRpcRunnerError("rpc_protocol", "rpc_event_missing_type", false);
      this.onEvent(record);
      return;
    }
    const id = record.id;
    const command = record.command;
    if (typeof id !== "string" || typeof command !== "string") {
      throw piRpcRunnerError("rpc_protocol", "rpc_response_missing_identity", false);
    }
    const pending = this.pending.get(id);
    if (!pending) throw piRpcRunnerError("rpc_protocol", "rpc_unknown_response_id", false);
    this.pending.delete(id);
    if (pending.command !== command) {
      const error = piRpcRunnerError("rpc_protocol", "rpc_command_mismatch", false);
      pending.reject(error);
      throw error;
    }
    if (record.success !== true) {
      pending.reject(piRpcRunnerError("rpc_protocol", "rpc_command_failed", false));
      return;
    }
    pending.resolve(record);
  }

  private fail(error: unknown): void {
    if (this.fatalError) return;
    this.fatalError = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.pending.values()) pending.reject(this.fatalError);
    this.pending.clear();
  }
}

async function main(argv: string[]): Promise<void> {
  const planPath = flag(argv, "--plan");
  if (!planPath) throw new Error("--plan is required");
  const sdkEntryPath = flag(argv, "--sdk-entry") ?? resolve(import.meta.dirname, "pi-rpc-sdk-entry.js");
  const plan = readJson<PiRpcPlan>(planPath);
  validatePlan(plan);
  const expectedRunner = boundRuntimeResource(plan, "pi-rpc-runner.js");
  const expectedSdkEntry = boundRuntimeResource(plan, "pi-rpc-sdk-entry.js");
  if (!process.argv[1] || realpathSync(process.argv[1]) !== expectedRunner || resolve(sdkEntryPath) !== expectedSdkEntry) {
    throw new Error("Pi RPC runner or SDK host differs from the execution snapshot");
  }
  const identity = receiptIdentity(plan);
  const lane = plan.snapshot.context!.lane as "worker" | "reviewer";
  const timeouts = snapshotRuntimeTimeouts(plan.snapshot, lane);
  const runtimeStartedAt = Date.now();
  const runtimeDeadlineAt = plan.snapshot.runtimeDeadlineAt
    ? Date.parse(plan.snapshot.runtimeDeadlineAt)
    : runtimeStartedAt + timeouts.totalTimeoutMs;
  const attemptStartedAt = plan.snapshot.runtimeDeadlineAt
    ? runtimeDeadlineAt - timeouts.totalTimeoutMs
    : runtimeStartedAt;
  writeExclusiveJson(spoolPath(plan.runtimeRoot, "owner.json"), {
    ...identity,
    ok: true,
    runnerPid: process.pid,
    handle: plan.handle,
  });

  let child: Child | null = null;
  let client: RpcClient | null = null;
  let settled = false;
  let policyViolation: string | null = null;
  let assistantFailure: AssistantFailure | null = null;
  let failureStage = "startup";
  let childExit: ChildExit | null = null;
  let agentStarts = 0;
  let eventBytes = 0;
  let logTruncated = false;
  let eventCount = 0;
  let lastEventType: string | null = null;
  let agentEndObserved = false;
  let effectiveProviderApi: PiRpcProviderApi = "unknown";
  let turnCount = 0;
  let assistantMessageCount = 0;
  let toolExecutionCount = 0;
  let toolErrorCount = 0;
  let transcriptBytes = 0;
  let controlledCompactionPhase: "idle" | "started" | "completed" = "idle";
  let controlledCompactionReceipt: JsonObject | null = null;
  let assistantMessageActive = false;
  let lastProgressAt = runtimeStartedAt;
  let lastProgressType: ProgressType = "runner_started";
  let lastProgressWriteAt = 0;
  let resultPresent = existsSync(plan.resultPath);
  let deadlineFailure: DeadlineFailure | null = null;
  let noProgressDeadlineActive = false;

  const persistProgress = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastProgressWriteAt < PROGRESS_WRITE_INTERVAL_MS) return;
    const body = {
      ...identity,
      lastProgressAt: new Date(lastProgressAt).toISOString(),
      lastProgressType,
      eventCount,
      elapsedMs: Math.max(0, now - attemptStartedAt),
      resultPresent,
      runnerPid: process.pid,
      childPid: child?.pid ?? null,
    };
    writeAtomicJson(spoolPath(plan.runtimeRoot, "runtime-progress.json"), { ...body, digest: digest(body) });
    lastProgressWriteAt = now;
  };
  const markProgress = (type: ProgressType): void => {
    lastProgressAt = Date.now();
    lastProgressType = type;
    persistProgress();
  };
  const observeDurableResult = (): void => {
    if (resultPresent || !existsSync(plan.resultPath)) return;
    resultPresent = true;
    markProgress("durable_result");
  };
  const expiredDeadline = (): DeadlineFailure | null => {
    const now = Date.now();
    if (now >= runtimeDeadlineAt) return "attempt_deadline";
    if (noProgressDeadlineActive && now - lastProgressAt >= timeouts.noProgressTimeoutMs) return "runtime_stall";
    return null;
  };
  const ensureTerminateIntent = (reason: DeadlineFailure | "policy_violation"): void => {
    const path = spoolPath(plan.runtimeRoot, "terminate.json");
    if (existsSync(path)) {
      assertTerminateIntent(plan);
      return;
    }
    writeExclusiveJson(path, { ...identity, reason });
  };
  persistProgress(true);

  const persistEvent = (event: JsonObject): void => {
    const reportedType = typeof event.type === "string" ? event.type : "";
    const type = KNOWN_EVENT_TYPES.has(reportedType) ? reportedType : "unknown";
    eventCount += 1;
    lastEventType = type;
    const eventMessage = object(event.message);
    if (type === "message_start") assistantMessageActive = eventMessage.role === "assistant";
    if (assistantMessageActive && type === "message_start") markProgress("assistant_message_start");
    if (assistantMessageActive && type === "message_update") markProgress("assistant_message_update");
    if ((assistantMessageActive || eventMessage.role === "assistant") && type === "message_end") {
      markProgress("assistant_message_end");
      assistantMessageActive = false;
    }
    if (type === "tool_execution_start") markProgress("tool_execution_start");
    if (type === "tool_execution_update" || type === "bash_execution_update") markProgress("tool_execution_update");
    if (type === "tool_execution_end") markProgress("tool_execution_end");
    if (type === "compaction_start") markProgress("compaction_start");
    if (type === "compaction_end") markProgress("compaction_end");
    if ([
      "auto_retry_start", "auto_retry_end", "summarization_retry_scheduled",
      "summarization_retry_attempt_start", "summarization_retry_finished",
    ].includes(type)) markProgress("provider_retry_progress");
    if (type === "agent_settled") markProgress("agent_settled");
    if (type === "agent_end") agentEndObserved = true;
    if (type === "turn_start") turnCount += 1;
    if (["message_end", "tool_execution_end", "turn_end"].includes(type)) {
      transcriptBytes = Math.min(4 * 1024 * 1024, transcriptBytes + observedPayloadBytes(event));
    }
    if (["message_update", "tool_execution_update", "bash_execution_update"].includes(type)) return;
    const summary: JsonObject = { type, digest: observedPayloadDigest(event) };
    const message = type === "message_end" ? eventMessage : {};
    if (message.role === "assistant") assistantMessageCount += 1;
    if (type === "tool_execution_end") {
      toolExecutionCount += 1;
      if (event.isError === true) toolErrorCount += 1;
    }
    if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
      summary.role = "assistant";
      summary.stopReason = message.stopReason;
      assistantFailure = {
        error: `Pi RPC assistant ended with ${message.stopReason}`,
        diagnostic: classifyProviderFailure(message.stopReason, message.errorMessage, {
          providerApi: effectiveProviderApi,
          phase: failurePhase(toolExecutionCount, toolErrorCount),
          turnCount,
          assistantMessageCount,
          toolExecutionCount,
          toolErrorCount,
          transcriptBytes,
        }),
      };
    }
    if (type === "agent_end") summary.willRetry = event.willRetry === true;
    if (type === "tool_execution_start" || type === "tool_execution_end") {
      summary.isError = event.isError === true;
    }
    const line = `${JSON.stringify(summary)}\n`;
    if (eventBytes + Buffer.byteLength(line, "utf8") <= MAX_EVENT_LOG_BYTES) {
      appendFileSync(spoolPath(plan.runtimeRoot, "runtime-events.jsonl"), line, { encoding: "utf8", mode: 0o600 });
      eventBytes += Buffer.byteLength(line, "utf8");
    } else if (!logTruncated) {
      const marker = `${JSON.stringify({ type: "log_truncated" })}\n`;
      appendFileSync(spoolPath(plan.runtimeRoot, "runtime-events.jsonl"), marker, { encoding: "utf8", mode: 0o600 });
      logTruncated = true;
    }
    if (type === "agent_start" && ++agentStarts > 1) policyViolation = "multiple agent_start events";
    if (type === "agent_end" && event.willRetry === true) policyViolation = "agent_end requested an automatic retry";
    if (type === "unknown") policyViolation = "unknown Pi RPC event";
    if (type === "extension_ui_request" && !allowedReviewerLifecycleCleanup(plan, event, settled, agentStarts)) {
      policyViolation = "forbidden Pi RPC control event";
    }
    if (type === "compaction_start" || type === "compaction_end") {
      const accepted = acceptControlledCompactionEvent(plan, event, controlledCompactionPhase);
      controlledCompactionPhase = accepted.phase;
      if (accepted.receipt) controlledCompactionReceipt = accepted.receipt;
      if (accepted.error) policyViolation = accepted.error;
    }
    if ([
      "auto_retry_start", "auto_retry_end", "queue_update",
      "extension_ui_response",
      "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
    ].includes(type)) {
      policyViolation = "forbidden Pi RPC control event";
    }
    if (type === "agent_settled") {
      if (controlledCompactionPhase === "started") policyViolation = "controlled compaction did not finish before settlement";
      settled = true;
    }
  };

  try {
    const isolatedAgentDir = preparePiRpcAgentDir(plan.snapshot);
    const pinnedTaskDataPath = preparePinnedTaskData(plan);
    child = spawn(process.execPath, [
      sdkEntryPath,
      "--pi-executable", plan.snapshot.executable,
      "--expected-version", plan.snapshot.runtimeVersion,
      ...credentialHostArgs(plan),
      "--private-agent-dir", isolatedAgentDir,
      ...runtimeControlHostArgs(plan, pinnedTaskDataPath),
      "--",
      ...plan.snapshot.argv,
    ], {
      cwd: plan.cwd,
      detached: true,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: isolatedAgentDir,
        ...(plan.snapshot.context!.lane === "reviewer"
          ? { [REVIEW_ORIGINAL_AGENT_DIR_ENV]: plan.snapshot.context!.agentDir }
          : {}),
        ...(hasSupportedPonytail(plan) ? {
          PONYTAIL_DEFAULT_MODE: "full",
          PONYTAIL_HIDE_STATUS: "1",
          PONYTAIL_QUIET_STARTUP: "1",
        } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    persistProgress(true);
    child.stderr.on("data", () => { /* Drain without persisting untrusted Provider diagnostics. */ });
    client = new RpcClient(child, persistEvent);
    const command = async (type: string, fields: JsonObject = {}): Promise<JsonObject> => {
      const remaining = runtimeDeadlineAt - Date.now();
      if (remaining <= 0) {
        deadlineFailure = "attempt_deadline";
        ensureTerminateIntent(deadlineFailure);
        throw piRpcRunnerError("runtime", deadlineFailure, false);
      }
      try {
        return await client!.command(type, fields, Math.min(COMMAND_TIMEOUT_MS, remaining));
      } catch (error) {
        if (Date.now() >= runtimeDeadlineAt) {
          deadlineFailure = "attempt_deadline";
          ensureTerminateIntent(deadlineFailure);
          throw piRpcRunnerError("runtime", deadlineFailure, false);
        }
        throw error;
      }
    };

    failureStage = "handshake";
    const initialState = requireResponse(await command("get_state"), "get_state");
    effectiveProviderApi = validateInitialState(initialState, plan);
    const commands = requireResponse(await command("get_commands"), "get_commands");
    validateCommands(commands, plan);
    requireResponse(await command("set_auto_retry", { enabled: false }), "set_auto_retry");
    requireResponse(await command("set_auto_compaction", { enabled: false }), "set_auto_compaction");
    const controlledState = requireResponse(await command("get_state"), "get_state");
    if (object(controlledState.data).autoCompactionEnabled !== false) throw new Error("Pi RPC auto-compaction did not disable");
    preparePiRpcAgentDir(plan.snapshot);
    writeAtomicJson(spoolPath(plan.runtimeRoot, "ready.json"), {
      ...identity,
      ok: true,
      piPid: child.pid,
      autoRetryDisableAccepted: true,
      autoCompactionEnabled: false,
      compactionMode: plan.snapshot.compactionMode,
      ...(plan.snapshot.compactionPolicy ? { compactionPolicy: plan.snapshot.compactionPolicy } : {}),
      credentialMode: plan.snapshot.credentialMode,
      isolatedAgentDir,
    });

    failureStage = "await-dispatch";
    const dispatch = await waitForDispatch(plan, client, () => {
      observeDurableResult();
      persistProgress();
      const expired = expiredDeadline();
      if (expired) {
        deadlineFailure = expired;
        ensureTerminateIntent(expired);
        persistProgress(true);
      }
      return expired;
    });
    if (!dispatch) {
      if (!existsSync(spoolPath(plan.runtimeRoot, "terminating.json"))) {
        writeExclusiveJson(spoolPath(plan.runtimeRoot, "terminating.json"), {
          ...identity,
          ok: true,
          reason: "controller_request",
        });
      }
      await stopChild(child, client, timeouts);
      preparePiRpcAgentDir(plan.snapshot);
      const diagnostic = makeSafeRuntimeDiagnostic({
        domain: "execution",
        code: "runtime_terminated",
        stage: "await-dispatch",
        failureDomain: "runtime",
        failureCode: "runtime_terminated",
        retryable: false,
      });
      writeAtomicJson(spoolPath(plan.runtimeRoot, "terminal.json"), {
        ...identity,
        ok: false,
        error: "terminated before dispatch",
        ...diagnostic,
      });
      writeAtomicJson(spoolPath(plan.runtimeRoot, "terminated.json"), { ...identity, ok: true, reason: "pre-dispatch termination" });
      return;
    }
    failureStage = "dispatch";
    credentialHostArgs(plan);
    requireResponse(await command("prompt", { message: dispatch.message }), "prompt");
    writeAtomicJson(spoolPath(plan.runtimeRoot, "accepted.json"), { ...identity, ok: true, dispatchId: dispatch.dispatchId });
    noProgressDeadlineActive = true;
    markProgress("dispatch_accepted");
    persistProgress(true);

    failureStage = "agent-run";
    let terminationRequested = false;
    let shutdownGraceMs = timeouts.sigtermGraceMs;
    for (;;) {
      deadlineFailure ??= expiredDeadline();
      if (deadlineFailure) ensureTerminateIntent(deadlineFailure);
      if (settled && !deadlineFailure) break;
      const exited = await Promise.race([client.exit.then((value) => ({ exited: value })), delay(POLL_MS).then(() => null)]);
      if (exited && !settled) {
        throw piRpcRunnerError("child_process", "child_exit_before_settled", true);
      }
      if (client.failure) throw client.failure;
      observeDurableResult();
      persistProgress();
      deadlineFailure ??= expiredDeadline();
      if (deadlineFailure) ensureTerminateIntent(deadlineFailure);
      terminationRequested = terminationRequested || assertTerminateIntent(plan);
      if (policyViolation) ensureTerminateIntent("policy_violation");
      if (policyViolation || terminationRequested) {
        if (!existsSync(spoolPath(plan.runtimeRoot, "terminating.json"))) {
          writeExclusiveJson(spoolPath(plan.runtimeRoot, "terminating.json"), {
            ...identity,
            ok: true,
            reason: deadlineFailure ?? (policyViolation ? "policy_violation" : "controller_request"),
          });
        }
        try {
          requireResponse(await client.command("abort", {}, timeouts.sigtermGraceMs), "abort");
        } catch {
          // The bounded signal escalation below owns cleanup after an unresponsive abort.
        }
        shutdownGraceMs = settled ? timeouts.sigkillGraceMs : 0;
        break;
      }
    }
    failureStage = "child-shutdown";
    childExit = await stopChild(child, client, timeouts, shutdownGraceMs);
    failureStage = "rpc-output";
    if (client.failure) throw client.failure;
    failureStage = "credential-postflight";
    credentialHostArgs(plan);
    preparePiRpcAgentDir(plan.snapshot);
    preparePinnedTaskData(plan);
    const assistantTerminalFailure = assistantFailure as AssistantFailure | null;
    const terminalError = deadlineFailure ?? policyViolation ?? assistantTerminalFailure?.error ?? null;
    const ok = terminalError === null && !terminationRequested && settled;
    const terminalDiagnostic = !ok && !assistantTerminalFailure
      ? deadlineFailure
        ? makeSafeRuntimeDiagnostic({
            domain: deadlineFailure === "runtime_stall" ? "observation" : "execution",
            code: deadlineFailure,
            stage: "agent-run",
            failureDomain: "runtime",
            failureCode: deadlineFailure,
            retryable: false,
          })
        : policyViolation === "controlled compaction failed"
        ? makeSafeRuntimeDiagnostic({
            domain: "execution",
            code: "compaction_failure",
            stage: "compaction",
            failureDomain: "compaction",
            failureCode: "compaction_failure",
            retryable: false,
          })
        : policyViolation
          ? makeSafeRuntimeDiagnostic({
              domain: "execution",
              code: "policy_violation",
              stage: "agent-run",
              failureDomain: "policy",
              failureCode: "policy_violation",
              retryable: false,
            })
          : makeSafeRuntimeDiagnostic({
              domain: "execution",
              code: "runtime_terminated",
              stage: "agent-run",
              failureDomain: "runtime",
              failureCode: "runtime_terminated",
              retryable: false,
            })
      : assistantTerminalFailure?.diagnostic ?? null;
    failureStage = "child-exit";
    if (ok && (childExit.code !== 0 || childExit.signal !== null)) {
      throw piRpcRunnerError("child_process", "child_exit_after_settled", false);
    }
    observeDurableResult();
    markProgress("terminal_receipt");
    persistProgress(true);
    writeAtomicJson(spoolPath(plan.runtimeRoot, "terminal.json"), {
      ...identity,
      ok,
      ...(!ok ? { error: terminalError ?? "runtime terminated by Controller" } : {}),
      ...(terminalDiagnostic ? withChildExit(terminalDiagnostic, childExit) : {}),
      agentSettled: settled,
      ...(controlledCompactionReceipt ? { controlledCompaction: controlledCompactionReceipt } : {}),
    });
    writeAtomicJson(spoolPath(plan.runtimeRoot, "terminated.json"), { ...identity, ok: true, reason: "settled and child exited" });
  } catch (error) {
    const primaryFailure = classifyPiRpcRunnerFailure(error, failureStage);
    if (assertTerminateIntent(plan)
      && !existsSync(spoolPath(plan.runtimeRoot, "terminating.json"))) {
      writeExclusiveJson(spoolPath(plan.runtimeRoot, "terminating.json"), {
        ...identity,
        ok: true,
        reason: deadlineFailure ?? "runner_failure",
      });
    }
    let cleanupFailure: ReturnType<typeof classifyPiRpcRunnerFailure> | null = null;
    if (child && client) {
      try {
        childExit ??= await stopChild(child, client, timeouts);
      } catch (stopError) {
        cleanupFailure = classifyPiRpcRunnerFailure(stopError, "child-shutdown");
      }
    } else if (child) {
      signalChildTree(child, "SIGKILL");
      cleanupFailure = classifyPiRpcRunnerFailure(
        piRpcRunnerError("child_process", "child_shutdown_unconfirmed", false),
        "child-shutdown",
      );
    }
    const diagnostic = primaryFailure.failureCode === "child_exit_before_settled"
      && toolExecutionCount > 0
      && lastEventType === "tool_execution_end"
      ? classifyProviderContinuationLost({
          providerApi: effectiveProviderApi,
          phase: failurePhase(toolExecutionCount, toolErrorCount),
          turnCount,
          assistantMessageCount,
          toolExecutionCount,
          toolErrorCount,
          transcriptBytes,
        }, childExit)
      : makeSafeRuntimeDiagnostic({ ...primaryFailure, childExit });
    const cleanupDiagnostic = cleanupFailure
      ? makeSafeRuntimeDiagnostic({
          ...cleanupFailure,
          domain: "observation",
          code: "rpc_terminal_missing",
          stage: "child-shutdown",
          retryable: false,
          childExit,
        })
      : null;
    observeDurableResult();
    markProgress("terminal_receipt");
    persistProgress(true);
    writeAtomicJson(spoolPath(plan.runtimeRoot, "terminal.json"), {
      ...identity,
      ok: false,
      error: "Pi RPC runner failed",
      ...diagnostic,
      agentSettled: settled,
      agentEndObserved,
      lastEventType,
      eventCount,
      ...(controlledCompactionReceipt ? { controlledCompaction: controlledCompactionReceipt } : {}),
      stdoutEnded: client?.outputFinished ?? false,
      ...(cleanupFailure ? { cleanupFailureCode: cleanupFailure.failureCode } : {}),
    });
    writeAtomicJson(spoolPath(plan.runtimeRoot, "terminated.json"), {
      ...identity,
      ok: cleanupFailure === null,
      reason: cleanupFailure === null ? "runner failure child exit confirmed" : "runner failure child exit unconfirmed",
      ...(cleanupFailure ? { error: "Pi RPC child exit unconfirmed", cleanupFailureCode: cleanupFailure.failureCode, ...cleanupDiagnostic } : {}),
    });
    throw new Error("Pi RPC runner failed");
  }
}

function observedPayloadBytes(event: JsonObject): number {
  const projected = event.payloadBytes;
  return typeof projected === "number" && Number.isSafeInteger(projected) && projected >= 0
    ? projected
    : Buffer.byteLength(JSON.stringify(event), "utf8");
}

function withChildExit(diagnostic: SafeRuntimeDiagnostic, childExit: ChildExit): SafeRuntimeDiagnostic {
  if (!diagnostic.domain || !diagnostic.code || !diagnostic.stage) {
    throw new Error("current runtime diagnostic has no stable classification");
  }
  const { diagnosticFingerprint: _fingerprint, ...fields } = diagnostic;
  return makeSafeRuntimeDiagnostic({
    ...fields,
    domain: diagnostic.domain,
    code: diagnostic.code,
    stage: diagnostic.stage,
    childExit,
  });
}

function observedPayloadDigest(event: JsonObject): string {
  const projected = event.payloadDigest;
  return typeof projected === "string" && /^[0-9a-f]{64}$/u.test(projected) ? projected : digest(event);
}

async function waitForDispatch(
  plan: PiRpcPlan,
  client: RpcClient,
  deadline: () => DeadlineFailure | null,
): Promise<{ dispatchId: string; message: string } | null> {
  for (;;) {
    if (assertTerminateIntent(plan)) return null;
    const expired = deadline();
    if (expired) throw piRpcRunnerError("runtime", expired, false);
    if (existsSync(spoolPath(plan.runtimeRoot, "dispatch.json"))) {
      const value = readJson<JsonObject>(spoolPath(plan.runtimeRoot, "dispatch.json"));
      if (
        value.version !== 1
        || value.attemptId !== plan.attemptId
        || value.generation !== plan.generation
        || value.planDigest !== plan.planDigest
        || value.dispatchId !== plan.attemptId
        || value.promptDigest !== plan.promptDigest
        || typeof value.message !== "string"
      ) throw new Error("Pi RPC dispatch has a different identity");
      const skill = plan.snapshot.context!.lane === "worker" ? "implement" : "code-review";
      const prefix = `/skill:${skill} [harness-dispatch:${value.dispatchId}]\n`;
      if (!value.message.startsWith(prefix) || digest(value.message.slice(prefix.length)) !== plan.promptDigest) {
        throw new Error("Pi RPC dispatch body differs from the immutable prompt digest");
      }
      return { dispatchId: value.dispatchId, message: value.message };
    }
    const exited = await Promise.race([client.exit.then(() => true), delay(POLL_MS).then(() => false)]);
    if (exited) throw new Error("Pi RPC exited before dispatch");
    if (client.failure) throw client.failure;
  }
}

export function validateInitialState(response: JsonObject, plan: PiRpcPlan): PiRpcProviderApi {
  const state = object(response.data);
  if (state.isStreaming !== false || state.isCompacting === true || Number(state.messageCount) !== 0 || Number(state.pendingMessageCount) !== 0) {
    throw new Error("Pi RPC did not start as a fresh idle session");
  }
  if (state.sessionFile) throw new Error("Pi RPC created a persistent session despite --no-session");
  if (state.thinkingLevel !== plan.snapshot.thinking) throw new Error("Pi RPC thinking level differs from the execution snapshot");
  const model = object(state.model);
  if (model.provider !== plan.snapshot.provider) throw new Error("Pi RPC provider differs from the execution snapshot");
  if (model.id !== plan.snapshot.model) throw new Error("Pi RPC model differs from the execution snapshot");
  return providerApi(model.api);
}

function validateCommands(response: JsonObject, plan: PiRpcPlan): void {
  const commands = Array.isArray(object(response.data).commands) ? object(response.data).commands as unknown[] : [];
  const entries = commands.map(object);
  const expectedSkills = new Set(plan.snapshot.resources
    .filter((resource) => resource.kind === "skill")
    .map((resource) => `skill:${basename(resource.path) === "SKILL.md" ? basename(dirname(resource.path)) : basename(resource.path)}`));
  const loadedSkills = new Set(entries.filter((entry) => entry.source === "skill").map((entry) => String(entry.name)));
  for (const expected of expectedSkills) if (!loadedSkills.has(expected)) throw new Error(`Pi RPC did not load ${expected}`);
  if (entries.some((entry) => entry.source === "prompt")) throw new Error("Pi RPC loaded an ambient prompt template");
  for (const loaded of loadedSkills) if (!expectedSkills.has(loaded)) throw new Error(`Pi RPC loaded an ambient skill: ${loaded}`);
}

function validatePlan(plan: PiRpcPlan): void {
  const lane = plan.snapshot.context?.lane;
  const validCredentialMode = lane === "worker"
    ? plan.snapshot.credentialMode === "canonical-oauth"
    : lane === "reviewer"
      && (plan.snapshot.credentialMode === "canonical-oauth" || plan.snapshot.credentialMode === "canonical-model-config");
  const validCompaction = lane === "worker"
    ? plan.snapshot.runtimeVersion === QUALIFIED_CONTROLLED_COMPACTION_PI_VERSION
      && plan.snapshot.compactionMode === "controlled-threshold"
      && isWorkerControlledCompactionPolicy(plan.snapshot.compactionPolicy)
      && plan.pinnedTaskData?.version === 1
      && /^[0-9a-f]{64}$/i.test(plan.pinnedTaskData.digest)
      && digest(plan.pinnedTaskData.content) === plan.pinnedTaskData.digest
    : lane === "reviewer"
      && plan.snapshot.compactionMode === "disabled"
      && plan.snapshot.compactionPolicy === undefined
      && plan.pinnedTaskData === undefined;
  if (
    plan.version !== 1
    || !plan.attemptId
    || !plan.generation
    || !/^[0-9a-f]{64}$/i.test(plan.planDigest)
    || !/^[0-9a-f]{64}$/i.test(plan.promptDigest)
    || plan.snapshot.adapter !== "pi-rpc"
    || !isQualifiedPiRpcVersion(plan.snapshot.runtimeVersion)
    || plan.snapshot.retryMode !== "disabled"
    || (plan.snapshot.runtimeTimeouts !== undefined && !validRuntimeTimeouts(plan.snapshot.runtimeTimeouts))
    || (plan.snapshot.runtimeDeadlineAt !== undefined && !Number.isFinite(Date.parse(plan.snapshot.runtimeDeadlineAt)))
    || (plan.snapshot.validationTimeoutMs !== undefined && !validTimeoutMs(plan.snapshot.validationTimeoutMs))
    || !validCompaction
    || (lane !== "worker" && lane !== "reviewer")
    || !validCredentialMode
    || !plan.snapshot.provider
    || !plan.snapshot.model
    || !plan.snapshot.context?.agentDir
    || !plan.snapshot.argv.includes("--no-session")
    || !plan.snapshot.argv.includes("--mode")
    || !plan.snapshot.argv.includes("rpc")
  ) throw new Error("invalid Pi RPC runtime plan");
  credentialHostArgs(plan);
}

function validRuntimeTimeouts(value: RuntimeTimeouts): boolean {
  return Object.keys(value).sort().join(",") === "noProgressTimeoutMs,sigkillGraceMs,sigtermGraceMs,totalTimeoutMs"
    && validTimeoutMs(value.totalTimeoutMs)
    && validTimeoutMs(value.noProgressTimeoutMs)
    && value.noProgressTimeoutMs <= value.totalTimeoutMs
    && validTimeoutMs(value.sigtermGraceMs)
    && validTimeoutMs(value.sigkillGraceMs);
}

function acceptControlledCompactionEvent(
  plan: PiRpcPlan,
  event: JsonObject,
  phase: "idle" | "started" | "completed",
): { phase: "idle" | "started" | "completed"; receipt: JsonObject | null; error: string | null } {
  const policy = plan.snapshot.compactionPolicy;
  const type = event.type;
  const baseValid = plan.snapshot.context?.lane === "worker"
    && plan.snapshot.compactionMode === "controlled-threshold"
    && isWorkerControlledCompactionPolicy(policy)
    && event.source === "harness-controlled"
    && event.reason === "threshold"
    && event.count === 1
    && event.triggerPercent === policy?.triggerPercent
    && event.willRetry === false
    && typeof event.payloadDigest === "string"
    && /^[0-9a-f]{64}$/.test(event.payloadDigest)
    && Number.isSafeInteger(event.payloadBytes)
    && Number(event.payloadBytes) >= 0;
  if (!baseValid) return { phase, receipt: null, error: "invalid controlled compaction event" };
  if (type === "compaction_start") {
    const allowed = new Set([
      "type", "source", "reason", "count", "triggerPercent", "contextTokens", "contextWindow", "willRetry",
      "payloadBytes", "payloadDigest",
    ]);
    const contextTokens = Number(event.contextTokens);
    const contextWindow = Number(event.contextWindow);
    if (phase !== "idle" || Object.keys(event).some((key) => !allowed.has(key))
      || !Number.isSafeInteger(contextTokens) || contextTokens <= 0
      || !Number.isSafeInteger(contextWindow) || contextWindow <= 0
      || contextTokens * 100 < contextWindow * policy!.triggerPercent) {
      return { phase, receipt: null, error: "invalid controlled compaction start" };
    }
    return { phase: "started", receipt: null, error: null };
  }
  const allowed = new Set([
    "type", "source", "reason", "count", "triggerPercent", "contextTokens", "contextWindow", "willRetry", "outcome", "tokensBefore",
    "estimatedTokensAfter", "summaryDigest", "payloadBytes", "payloadDigest",
  ]);
  const tokensBefore = Number(event.tokensBefore);
  const estimatedTokensAfter = Number(event.estimatedTokensAfter);
  const contextTokens = Number(event.contextTokens);
  const contextWindow = Number(event.contextWindow);
  if (type !== "compaction_end" || phase !== "started" || Object.keys(event).some((key) => !allowed.has(key))) {
    return { phase, receipt: null, error: "controlled compaction changed shape" };
  }
  if (event.outcome === "failed") {
    const failureKeys = new Set([
      "type", "source", "reason", "count", "triggerPercent", "contextTokens", "contextWindow", "willRetry", "outcome", "payloadBytes", "payloadDigest",
    ]);
    if (Object.keys(event).some((key) => !failureKeys.has(key))
      || !Number.isSafeInteger(contextTokens) || contextTokens <= 0
      || !Number.isSafeInteger(contextWindow) || contextWindow <= 0
      || contextTokens * 100 < contextWindow * policy!.triggerPercent) {
      return { phase, receipt: null, error: "controlled compaction failure changed shape" };
    }
    return {
      phase: "completed",
      receipt: {
        count: 1,
        triggerPercent: policy!.triggerPercent,
        contextTokens,
        contextWindow,
        outcome: "failed",
        willRetry: false,
      },
      error: "controlled compaction failed",
    };
  }
  if (event.outcome !== "completed"
    || !Number.isSafeInteger(contextTokens) || contextTokens <= 0
    || !Number.isSafeInteger(contextWindow) || contextWindow <= 0
    || contextTokens * 100 < contextWindow * policy!.triggerPercent
    || !Number.isSafeInteger(tokensBefore) || tokensBefore < 0
    || !Number.isSafeInteger(estimatedTokensAfter) || estimatedTokensAfter < 0
    || typeof event.summaryDigest !== "string" || !/^[0-9a-f]{64}$/.test(event.summaryDigest)) {
    return { phase, receipt: null, error: "controlled compaction completion changed shape" };
  }
  return {
    phase: "completed",
    receipt: {
      count: 1,
      triggerPercent: policy!.triggerPercent,
      contextTokens,
      contextWindow,
      outcome: "completed",
      tokensBefore,
      estimatedTokensAfter,
      summaryDigest: event.summaryDigest,
      willRetry: false,
    },
    error: null,
  };
}

function preparePinnedTaskData(plan: PiRpcPlan): string | null {
  if (!plan.pinnedTaskData) return null;
  const path = spoolPath(plan.runtimeRoot, "pinned-task-data.json");
  const value = {
    version: 1,
    attemptId: plan.attemptId,
    planDigest: plan.planDigest,
    digest: plan.pinnedTaskData.digest,
    content: plan.pinnedTaskData.content,
  };
  const existing = readJsonIfExists<typeof value>(path);
  if (existing && !sameJson(existing, value)) throw new Error("Pi RPC pinned task data changed after preparation");
  if (!existing) writeExclusiveJson(path, value);
  return path;
}

function runtimeControlHostArgs(plan: PiRpcPlan, pinnedTaskDataPath: string | null): string[] {
  if (plan.snapshot.context?.lane !== "worker") return [];
  if (!pinnedTaskDataPath || !plan.pinnedTaskData || !plan.snapshot.compactionPolicy) {
    throw new Error("controlled Worker runtime has no pinned task data or compaction policy");
  }
  return [
    "--pinned-task-data-path", pinnedTaskDataPath,
    "--pinned-task-data-digest", plan.pinnedTaskData.digest,
    "--controlled-compaction-policy", JSON.stringify(plan.snapshot.compactionPolicy),
  ];
}

function hasSupportedPonytail(plan: PiRpcPlan): boolean {
  return plan.snapshot.context?.lane === "worker"
    && plan.snapshot.resources.some((resource) => (
      resource.kind === "extension" && isSupportedPonytailExtension(resource.path)
    ));
}

function allowedReviewerLifecycleCleanup(plan: PiRpcPlan, event: JsonObject, settled: boolean, agentStarts: number): boolean {
  const allowedKeys = new Set(["type", "id", "method", "widgetKey"]);
  return (agentStarts === 0 || settled)
    && plan.snapshot.context?.lane === "reviewer"
    && typeof event.id === "string"
    && event.id.length > 0
    && event.method === "setWidget"
    && event.widgetKey === "subagent-async"
    && Object.keys(event).every((key) => allowedKeys.has(key));
}

function credentialHostArgs(plan: PiRpcPlan): string[] {
  const agentDir = plan.snapshot.context?.agentDir;
  if (!agentDir) throw new Error("Pi RPC plan has no canonical credential agent directory");
  const modelConfigs = plan.snapshot.resources.filter((resource) => resource.kind === "model-config");
  if (plan.snapshot.credentialMode === "canonical-oauth") {
    if (modelConfigs.length !== 0) throw new Error("subscription OAuth RPC must not bind models.json");
    return ["--credential-mode", "canonical-oauth", "--credential-agent-dir", agentDir];
  }
  if (plan.snapshot.credentialMode !== "canonical-model-config" || modelConfigs.length !== 1) {
    throw new Error("custom-model RPC must bind exactly one models.json");
  }
  const modelConfig = modelConfigs[0]!;
  const observed = executionResource("model-config", modelConfig.path);
  if (basename(modelConfig.path) !== "models.json" || observed.path !== modelConfig.path || observed.digest !== modelConfig.digest) {
    throw new Error("Pi RPC models.json changed after Attempt preparation");
  }
  return [
    "--credential-mode", "canonical-model-config",
    "--credential-agent-dir", agentDir,
    "--model-config-path", modelConfig.path,
    "--model-config-digest", modelConfig.digest,
  ];
}

function boundRuntimeResource(plan: PiRpcPlan, name: string): string {
  const matches = plan.snapshot.resources.filter((resource) => resource.kind === "runtime" && basename(resource.path) === name);
  if (matches.length !== 1) throw new Error(`Pi RPC plan must bind exactly one ${name}`);
  const resource = matches[0]!;
  if (executionResourceDigest(dirname(resource.path)) !== resource.digest) {
    throw new Error(`Pi RPC runtime resource changed after preparation: ${name}`);
  }
  return resource.path;
}

function requireResponse(response: JsonObject, command: string): JsonObject {
  if (response.type !== "response" || response.command !== command || response.success !== true) {
    throw new Error(`invalid Pi RPC ${command} response`);
  }
  return response;
}

async function stopChild(
  child: Child,
  client: RpcClient,
  timeouts: RuntimeTimeouts,
  gracefulWaitMs = timeouts.sigtermGraceMs,
): Promise<ChildExit> {
  child.stdin.end();
  if (!await exitsWithin(client.exit, gracefulWaitMs)) {
    signalChildTree(child, "SIGTERM");
    if (!await exitsWithin(client.exit, timeouts.sigkillGraceMs)) {
      signalChildTree(child, "SIGKILL");
      if (!await exitsWithin(client.exit, timeouts.sigkillGraceMs)) {
        throw piRpcRunnerError("child_process", "child_shutdown_unconfirmed", false);
      }
    }
  }
  await stopRemainingProcessGroup(child, timeouts);
  if (!await exitsWithin(client.outputEnded, timeouts.sigkillGraceMs)) {
    throw piRpcRunnerError("rpc_transport", "rpc_stdout_end_timeout", false);
  }
  return client.exit;
}

async function stopRemainingProcessGroup(child: Child, timeouts: RuntimeTimeouts): Promise<void> {
  if (!child.pid || !processGroupAlive(child.pid)) return;
  signalChildTree(child, "SIGTERM");
  if (await processGroupExitsWithin(child.pid, timeouts.sigkillGraceMs)) return;
  signalChildTree(child, "SIGKILL");
  if (!await processGroupExitsWithin(child.pid, timeouts.sigkillGraceMs)) {
    throw piRpcRunnerError("child_process", "child_shutdown_unconfirmed", false);
  }
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processGroupExitsWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function signalChildTree(child: Child, signal: "SIGTERM" | "SIGKILL"): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group has already disappeared.
    }
  }
  child.kill(signal);
}

async function exitsWithin(exit: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    exit.then(() => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

function receiptIdentity(plan: PiRpcPlan): JsonObject {
  return { version: 1, attemptId: plan.attemptId, generation: plan.generation, planDigest: plan.planDigest };
}

function assertTerminateIntent(plan: PiRpcPlan): boolean {
  const value = readJsonIfExists<JsonObject>(spoolPath(plan.runtimeRoot, "terminate.json"));
  if (!value) return false;
  if (
    value.version !== 1
    || value.attemptId !== plan.attemptId
    || value.generation !== plan.generation
    || value.planDigest !== plan.planDigest
    || typeof value.reason !== "string"
    || ![
      "completed", "recovery", "cancelled", "runtime_stall", "attempt_deadline", "policy_violation",
    ].includes(value.reason)
  ) throw new Error("Pi RPC terminate intent has a different identity");
  return true;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => reject(piRpcRunnerError("rpc_transport", "rpc_command_timeout", true)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveValue(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("FAIL: Pi RPC runner failed\n");
    process.exitCode = 1;
  });
}
