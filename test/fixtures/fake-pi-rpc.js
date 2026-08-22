#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  knownPiRpcEventClassification,
  piRpcEventPayloadMetadata,
  projectUnknownPiRpcEvent,
} from "../../dist/src/pi-rpc-events.js";

let buffer = "";
let autoCompactionEnabled = true;
let splitStateResponse = true;
let continuousOutput = null;
const expectedVersionIndex = process.argv.indexOf("--expected-version");
const runtimeVersion = expectedVersionIndex >= 0 ? process.argv[expectedVersionIndex + 1] : "0.84.2";

if (process.env.FAKE_PI_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}

if (process.env.FAKE_PI_EXPECT_PONYTAIL_ENV === "1" && (
  process.env.PONYTAIL_DEFAULT_MODE !== "full"
  || process.env.PONYTAIL_HIDE_STATUS !== "1"
  || process.env.PONYTAIL_QUIET_STARTUP !== "1"
)) {
  throw new Error("missing headless Ponytail environment");
}

if (process.env.FAKE_PI_MALFORMED_SECRET_PHASE === "before-ready") {
  process.stdout.write(`${process.env.FAKE_PI_MALFORMED_SECRET}\n`);
}
if (process.env.FAKE_PI_REVIEWER_CLEANUP === "before-and-after") emitReviewerCleanup();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line) respond(JSON.parse(line));
  }
});

function respond(command) {
  const base = { id: command.id, type: "response", command: command.type, success: true };
  if (command.type === process.env.FAKE_PI_HANG_COMMAND) return;
  if (command.type === "get_state") {
    if (process.env.FAKE_PI_SECRET_ERROR) {
      process.stderr.write(process.env.FAKE_PI_SECRET_ERROR);
      emit({ ...base, success: false, error: process.env.FAKE_PI_SECRET_ERROR });
      return;
    }
    if (!splitStateResponse && process.env.FAKE_PI_WRITE_AUTH_BEFORE_READY === "1") writePrivateAuth();
    const response = {
      ...base,
      data: {
        model: {
          provider: "test",
          id: "model",
          api: process.env.FAKE_PI_API ?? "unknown",
          ...(process.env.FAKE_PI_MODEL_SECRET ? { headers: { Authorization: process.env.FAKE_PI_MODEL_SECRET } } : {}),
        },
        unicodeBoundary: "中",
        thinkingLevel: process.env.FAKE_PI_THINKING ?? "high",
        isStreaming: false,
        isCompacting: false,
        sessionFile: null,
        autoCompactionEnabled,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    };
    if (splitStateResponse) {
      splitStateResponse = false;
      emitAcrossUtf8Boundary(response);
    } else {
      emit(response);
    }
    return;
  }
  if (command.type === "get_commands") {
    emit({
      ...base,
      data: {
        commands: (process.env.FAKE_PI_SKILLS ?? "implement,tdd,focused-self-check").split(",").map((name) => ({
          name: `skill:${name}`,
          source: "skill",
          location: "path",
        })),
      },
    });
    return;
  }
  if (command.type === "set_auto_compaction") autoCompactionEnabled = command.enabled;
  if (command.type === "abort" && process.env.FAKE_PI_IGNORE_ABORT === "1") return;
  if (command.type === "abort" && (
    process.env.FAKE_PI_WAIT_FOR_ABORT === "1"
    || process.env.FAKE_PI_PROVIDER_NEVER_RETURNS === "1"
    || process.env.FAKE_PI_RESULT_BEFORE_STALL === "1"
    || process.env.FAKE_PI_CONTINUOUS_TOOL_OUTPUT === "1"
  )) {
    if (continuousOutput) clearInterval(continuousOutput);
    emit({ type: "agent_end", messages: [], willRetry: false });
    emit({ type: "agent_settled" });
    emit(base);
    return;
  }
  emit(base);
  if (command.type !== "prompt") return;

  emit({ type: "agent_start" });
  if (process.env.FAKE_PI_MULTIPLE_AGENT_START === "1") emit({ type: "agent_start" });
  if (["extension_ui_response", "queue_update"].includes(process.env.FAKE_PI_FORBIDDEN_EVENT)) {
    emit({ type: process.env.FAKE_PI_FORBIDDEN_EVENT, privatePayload: "PRIVATE_FORBIDDEN_SENTINEL" });
  }
  if (process.env.FAKE_PI_WORKER_UI_REQUEST === "1") {
    emit({ type: "extension_ui_request", id: "worker-ui", method: "setStatus", widgetKey: "ponytail" });
  }
  emit({ type: "turn_start" });
  if (process.env.FAKE_PI_OVERSIZE_EVENT === "1") {
    process.stdout.write(`${JSON.stringify({ type: "turn_end", payload: "x".repeat(1024 * 1024) })}\n`);
    return;
  }
  if (["1", "fail"].includes(process.env.FAKE_PI_CONTROLLED_COMPACTION)) {
    emitProjected({
      type: "compaction_start",
      source: "harness-controlled",
      reason: "threshold",
      count: 1,
      triggerPercent: 75,
      contextTokens: 80_000,
      contextWindow: 100_000,
      willRetry: false,
    });
    emitProjected(process.env.FAKE_PI_CONTROLLED_COMPACTION === "fail" ? {
      type: "compaction_end",
      source: "harness-controlled",
      reason: "threshold",
      count: 1,
      triggerPercent: 75,
      contextTokens: 80_000,
      contextWindow: 100_000,
      willRetry: false,
      outcome: "failed",
    } : {
      type: "compaction_end",
      source: "harness-controlled",
      reason: "threshold",
      count: 1,
      triggerPercent: 75,
      contextTokens: 80_000,
      contextWindow: 100_000,
      willRetry: false,
      outcome: "completed",
      tokensBefore: 80_000,
      estimatedTokensAfter: 12_000,
      summaryDigest: "a".repeat(64),
    });
  }
  if (process.env.FAKE_PI_WAIT_FOR_ABORT === "1" || process.env.FAKE_PI_PROVIDER_NEVER_RETURNS === "1") return;
  if (process.env.FAKE_PI_CONTINUOUS_TOOL_OUTPUT === "1") {
    emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
    continuousOutput = setInterval(() => {
      emit({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "read", partialResult: "bounded progress" });
    }, Number(process.env.FAKE_PI_PROGRESS_INTERVAL_MS ?? "20"));
    return;
  }
  if (process.env.FAKE_PI_ORPHAN_PID_PATH) {
    const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(process.env.FAKE_PI_ORPHAN_PID_PATH, String(orphan.pid));
    orphan.unref();
  }
  if (["success", "error"].includes(process.env.FAKE_PI_TOOL_BEFORE_FAILURE)) {
    emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
    emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: { content: "fixed fixture result" },
      isError: process.env.FAKE_PI_TOOL_BEFORE_FAILURE === "error",
    });
  }
  if (process.env.FAKE_PI_TOOL_START_ONLY) {
    for (const toolName of process.env.FAKE_PI_TOOL_START_ONLY.split(",")) {
      emit({ type: "tool_execution_start", toolCallId: `tool-start-${toolName}`, toolName, args: {} });
    }
  }
  if (process.env.FAKE_PI_TOOL_EVENT_ONLY === "end") {
    emit({ type: "tool_execution_end", toolCallId: "tool-end-only", toolName: "read", result: {}, isError: false });
  }
  if (process.env.FAKE_PI_TOOL_EVENT_ONLY === "bash-update") {
    emit({ type: "bash_execution_update", toolCallId: "bash-update-only", partialResult: "bounded progress" });
  }
  if (process.env.FAKE_PI_WORKTREE_CHANGE === "1") {
    writeFileSync(join(process.cwd(), "provider-failure-side-effect.txt"), "changed\n");
  }
  if (process.env.FAKE_PI_CONTINUATION_LOST === "1") {
    if (process.env.FAKE_PI_ASSISTANT_BEFORE_CONTINUATION_LOST === "1") {
      const message = { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "stop" };
      emit({ type: "message_start", message });
      emit({ type: "message_end", message });
    }
    process.stdout.write("", () => process.exit(0));
    return;
  }
  if (["error", "aborted"].includes(process.env.FAKE_PI_ASSISTANT_STOP_REASON)) {
    const failureMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: process.env.FAKE_PI_ASSISTANT_STOP_REASON,
      errorMessage: process.env.FAKE_PI_ASSISTANT_ERROR ?? "Provider request failed",
    };
    emit({ type: "message_start", message: failureMessage });
    emit({ type: "message_end", message: failureMessage });
    emit({ type: "turn_end", message: failureMessage, toolResults: [] });
    emit({ type: "agent_end", messages: [failureMessage], willRetry: false });
    emit({ type: "agent_settled" });
    return;
  }
  if (process.env.FAKE_PI_RAW_UNSAFE_REASON === "1") {
    process.stdout.write(`${JSON.stringify({
      type: "future_event",
      classification: "unknown-unsafe",
      refreshesProgress: false,
      payloadBytes: 0,
      payloadDigest: "a".repeat(64),
      unsafeReason: "access_token_RAW_REASON_SENTINEL",
    })}\n`);
    emit({ type: "agent_end", messages: [], willRetry: false });
    emit({ type: "agent_settled" });
    return;
  }
  if (process.env.FAKE_PI_UNKNOWN_EVENT) {
    const unknown = {
      telemetry: {
        type: "future_telemetry",
        metrics: { privateMetric: 987654321, latencyMs: 12, tokenUsage: { input: 10, output: 2 } },
      },
      ui: { type: "future_ui_request", request: { action: "open" }, privatePayload: "PRIVATE_UI_SENTINEL" },
      retry: { type: "future_retry_event", retry: { action: "resume" }, privatePayload: "PRIVATE_RETRY_SENTINEL" },
    }[process.env.FAKE_PI_UNKNOWN_EVENT];
    if (!unknown) throw new Error("unknown fake Pi event fixture");
    emit(unknown);
    if (process.env.FAKE_PI_UNKNOWN_EVENT !== "telemetry") {
      emit({ type: "agent_end", messages: [], willRetry: false });
      emit({ type: "agent_settled" });
      return;
    }
  }
  const lane = process.env.FAKE_PI_LANE ?? "worker";
  writeFileSync(process.env.FAKE_PI_RESULT_PATH, `${JSON.stringify(lane === "reviewer" ? {
    version: 1,
    jobId: process.env.FAKE_PI_JOB_ID,
    attemptId: process.env.FAKE_PI_ATTEMPT_ID,
    lane,
    status: "pass",
    summary: "fake RPC review completed",
    reviewedHeadSha: "b".repeat(40),
    findings: [],
  } : {
    version: 1,
    jobId: process.env.FAKE_PI_JOB_ID,
    attemptId: process.env.FAKE_PI_ATTEMPT_ID,
    lane,
    status: "completed",
    summary: "fake RPC completed",
    headSha: "b".repeat(40),
    failedCommands: [],
  })}\n`);
  if (process.env.FAKE_PI_TERMINAL_FAILURE_AFTER_RESULT === "1") {
    emit({ type: "auto_retry_start", privatePayload: "must-not-be-persisted" });
  }
  if (process.env.FAKE_PI_RESULT_BEFORE_STALL === "1") return;
  if (process.env.FAKE_PI_MALFORMED_AFTER_PROMPT === "1") {
    process.stdout.write("{malformed\n");
    return;
  }
  if (process.env.FAKE_PI_REVIEWER_CLEANUP === "before-settled") emitReviewerCleanup();
  emit({ type: "turn_end", message: {}, toolResults: [] });
  emit({ type: "agent_end", messages: [], willRetry: false });
  emit({ type: "agent_settled" });
  if (process.env.FAKE_PI_EXIT_AFTER_SETTLED) {
    if (process.env.FAKE_PI_EXIT_STDERR) process.stderr.write(process.env.FAKE_PI_EXIT_STDERR);
    process.stdout.write("", () => {
      if (process.env.FAKE_PI_EXIT_AFTER_SETTLED === "signal") process.kill(process.pid, "SIGTERM");
      else process.exit(process.env.FAKE_PI_EXIT_AFTER_SETTLED === "success" ? 0 : 23);
    });
    return;
  }
  if (["after-settled", "before-and-after"].includes(process.env.FAKE_PI_REVIEWER_CLEANUP)) emitReviewerCleanup();
  if (process.env.FAKE_PI_REVIEWER_CLEANUP === "wrong-key") emitReviewerCleanup("other-widget");
  if (process.env.FAKE_PI_WRITE_AUTH_AFTER_SETTLED === "1") writePrivateAuth();
  if (process.env.FAKE_PI_MALFORMED_AFTER_SETTLED === "1") {
    setTimeout(() => process.stdout.write("{malformed-after-settled\n"), 0);
  }
  if (process.env.FAKE_PI_INCOMPLETE_AFTER_SETTLED === "1") {
    setTimeout(() => process.stdout.write('{"type":"incomplete"'), 0);
  }
  if (process.env.FAKE_PI_MALFORMED_SECRET_PHASE === "after-settled") {
    setTimeout(() => process.stdout.write(`${process.env.FAKE_PI_MALFORMED_SECRET}\n`), 0);
  }
}

function emitReviewerCleanup(widgetKey = "subagent-async") {
  emit({ type: "extension_ui_request", id: "reviewer-cleanup", method: "setWidget", widgetKey });
}

function writePrivateAuth() {
  const path = join(process.env.PI_CODING_AGENT_DIR, "auth.json");
  writeFileSync(path, '{"oauth":"persisted"}\n', { mode: 0o600 });
}

function emit(value) {
  const projected = value.type === "response" || knownPiRpcEventClassification(value.type) !== null
    ? value
    : projectUnknownPiRpcEvent(value, runtimeVersion);
  process.stdout.write(`${JSON.stringify(projected)}\n`);
}

function emitProjected(value) {
  emit({ ...value, ...piRpcEventPayloadMetadata(value) });
}

function emitAcrossUtf8Boundary(value) {
  const line = Buffer.from(`${JSON.stringify(value)}\n`);
  const marker = Buffer.from("中");
  const index = line.indexOf(marker);
  process.stdout.write(line.subarray(0, index + 1));
  setTimeout(() => process.stdout.write(line.subarray(index + 1)), 0);
}
