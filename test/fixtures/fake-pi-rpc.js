#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";

let buffer = "";
let autoCompactionEnabled = true;
let splitStateResponse = true;

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
  if (command.type === "abort" && process.env.FAKE_PI_WAIT_FOR_ABORT === "1") {
    emit({ type: "agent_end", messages: [], willRetry: false });
    emit({ type: "agent_settled" });
    emit(base);
    return;
  }
  emit(base);
  if (command.type !== "prompt") return;

  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  if (process.env.FAKE_PI_WAIT_FOR_ABORT === "1") return;
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
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitAcrossUtf8Boundary(value) {
  const line = Buffer.from(`${JSON.stringify(value)}\n`);
  const marker = Buffer.from("中");
  const index = line.indexOf(marker);
  process.stdout.write(line.subarray(0, index + 1));
  setTimeout(() => process.stdout.write(line.subarray(index + 1)), 0);
}
