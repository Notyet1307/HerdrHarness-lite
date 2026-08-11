#!/usr/bin/env node
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
import { digest } from "./model.js";
import { executionResource, executionResourceDigest } from "./attempt-plan.js";
import { readJson, preparePiRpcAgentDir, spoolPath, writeAtomicJson, writeExclusiveJson, } from "./pi-rpc-spool.js";
import { isQualifiedPiRpcVersion } from "./pi-rpc-compat.js";
import { classifyProviderFailure, classifyPiRpcRunnerFailure, failurePhase, piRpcRunnerError, providerApi, } from "./pi-rpc-diagnostics.js";
const MAX_RPC_LINE_BYTES = 1024 * 1024;
const MAX_EVENT_LOG_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 10_000;
const POLL_MS = 50;
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
export class StrictJsonlDecoder {
    buffer = "";
    push(chunk, onRecord) {
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer, "utf8") > MAX_RPC_LINE_BYTES && !this.buffer.includes("\n")) {
            throw piRpcRunnerError("rpc_protocol", "rpc_line_too_large", false);
        }
        const records = [];
        for (;;) {
            const index = this.buffer.indexOf("\n");
            if (index < 0)
                break;
            let line = this.buffer.slice(0, index);
            this.buffer = this.buffer.slice(index + 1);
            if (line.endsWith("\r"))
                line = line.slice(0, -1);
            if (!line)
                continue;
            if (Buffer.byteLength(line, "utf8") > MAX_RPC_LINE_BYTES) {
                throw piRpcRunnerError("rpc_protocol", "rpc_line_too_large", false);
            }
            let value;
            try {
                value = JSON.parse(line);
            }
            catch {
                throw piRpcRunnerError("rpc_protocol", "rpc_invalid_json", false);
            }
            if (!value || typeof value !== "object" || Array.isArray(value)) {
                throw piRpcRunnerError("rpc_protocol", "rpc_record_not_object", false);
            }
            const record = value;
            records.push(record);
            onRecord?.(record);
        }
        return records;
    }
    finish() {
        if (this.buffer.trim())
            throw piRpcRunnerError("rpc_protocol", "rpc_incomplete_jsonl", false);
    }
}
class RpcClient {
    child;
    onEvent;
    decoder = new StrictJsonlDecoder();
    pending = new Map();
    sequence = 0;
    fatalError = null;
    stdoutEnded = false;
    exit;
    outputEnded;
    constructor(child, onEvent) {
        this.child = child;
        this.onEvent = onEvent;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            try {
                this.decoder.push(String(chunk), (record) => this.accept(record));
            }
            catch (error) {
                this.fail(error);
            }
        });
        this.outputEnded = new Promise((resolveEnd) => {
            child.stdout.on("end", () => {
                try {
                    this.decoder.finish();
                }
                catch (error) {
                    this.fail(error);
                }
                this.stdoutEnded = true;
                resolveEnd();
            });
        });
        this.exit = new Promise((resolveExit) => {
            child.on("exit", (code, signal) => resolveExit({ code, signal }));
            child.on("error", (error) => {
                this.fail(error);
                resolveExit({ code: null, signal: null });
            });
        });
    }
    get failure() {
        return this.fatalError;
    }
    get outputFinished() {
        return this.stdoutEnded;
    }
    async command(type, fields = {}) {
        if (this.fatalError)
            throw this.fatalError;
        const id = `runner-${++this.sequence}`;
        const response = new Promise((resolveResponse, reject) => {
            this.pending.set(id, { command: type, resolve: resolveResponse, reject });
        });
        this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
        return withTimeout(response, COMMAND_TIMEOUT_MS);
    }
    accept(record) {
        if (record.type !== "response") {
            if (typeof record.type !== "string")
                throw piRpcRunnerError("rpc_protocol", "rpc_event_missing_type", false);
            this.onEvent(record);
            return;
        }
        const id = record.id;
        const command = record.command;
        if (typeof id !== "string" || typeof command !== "string") {
            throw piRpcRunnerError("rpc_protocol", "rpc_response_missing_identity", false);
        }
        const pending = this.pending.get(id);
        if (!pending)
            throw piRpcRunnerError("rpc_protocol", "rpc_unknown_response_id", false);
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
    fail(error) {
        if (this.fatalError)
            return;
        this.fatalError = error instanceof Error ? error : new Error(String(error));
        for (const pending of this.pending.values())
            pending.reject(this.fatalError);
        this.pending.clear();
    }
}
async function main(argv) {
    const planPath = flag(argv, "--plan");
    if (!planPath)
        throw new Error("--plan is required");
    const sdkEntryPath = flag(argv, "--sdk-entry") ?? resolve(import.meta.dirname, "pi-rpc-sdk-entry.js");
    const plan = readJson(planPath);
    validatePlan(plan);
    const expectedRunner = boundRuntimeResource(plan, "pi-rpc-runner.js");
    const expectedSdkEntry = boundRuntimeResource(plan, "pi-rpc-sdk-entry.js");
    if (!process.argv[1] || realpathSync(process.argv[1]) !== expectedRunner || resolve(sdkEntryPath) !== expectedSdkEntry) {
        throw new Error("Pi RPC runner or SDK host differs from the execution snapshot");
    }
    const identity = receiptIdentity(plan);
    writeExclusiveJson(spoolPath(plan.runtimeRoot, "owner.json"), {
        ...identity,
        ok: true,
        runnerPid: process.pid,
        handle: plan.handle,
    });
    let child = null;
    let client = null;
    let settled = false;
    let policyViolation = null;
    let assistantFailure = null;
    let failureStage = "startup";
    let childExit = null;
    let agentStarts = 0;
    let eventBytes = 0;
    let logTruncated = false;
    let eventCount = 0;
    let lastEventType = null;
    let agentEndObserved = false;
    let effectiveProviderApi = "unknown";
    let turnCount = 0;
    let assistantMessageCount = 0;
    let toolExecutionCount = 0;
    let toolErrorCount = 0;
    let transcriptBytes = 0;
    const persistEvent = (event) => {
        const reportedType = typeof event.type === "string" ? event.type : "";
        const type = KNOWN_EVENT_TYPES.has(reportedType) ? reportedType : "unknown";
        eventCount += 1;
        lastEventType = type;
        if (type === "agent_end")
            agentEndObserved = true;
        if (type === "turn_start")
            turnCount += 1;
        if (["message_end", "tool_execution_end", "turn_end"].includes(type)) {
            transcriptBytes = Math.min(4 * 1024 * 1024, transcriptBytes + observedPayloadBytes(event));
        }
        if (["message_update", "tool_execution_update", "bash_execution_update"].includes(type))
            return;
        const summary = { type, digest: observedPayloadDigest(event) };
        const message = type === "message_end" ? object(event.message) : {};
        if (message.role === "assistant")
            assistantMessageCount += 1;
        if (type === "tool_execution_end") {
            toolExecutionCount += 1;
            if (event.isError === true)
                toolErrorCount += 1;
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
        if (type === "agent_end")
            summary.willRetry = event.willRetry === true;
        if (type === "tool_execution_start" || type === "tool_execution_end") {
            const toolName = safeToolName(event.toolName);
            if (toolName)
                summary.toolName = toolName;
            summary.isError = event.isError === true;
        }
        const line = `${JSON.stringify(summary)}\n`;
        if (eventBytes + Buffer.byteLength(line, "utf8") <= MAX_EVENT_LOG_BYTES) {
            appendFileSync(spoolPath(plan.runtimeRoot, "runtime-events.jsonl"), line, { encoding: "utf8", mode: 0o600 });
            eventBytes += Buffer.byteLength(line, "utf8");
        }
        else if (!logTruncated) {
            const marker = `${JSON.stringify({ type: "log_truncated" })}\n`;
            appendFileSync(spoolPath(plan.runtimeRoot, "runtime-events.jsonl"), marker, { encoding: "utf8", mode: 0o600 });
            logTruncated = true;
        }
        if (type === "agent_start" && ++agentStarts > 1)
            policyViolation = "multiple agent_start events";
        if (type === "agent_end" && event.willRetry === true)
            policyViolation = "agent_end requested an automatic retry";
        if (type === "unknown")
            policyViolation = "unknown Pi RPC event";
        if (type === "extension_ui_request" && !allowedReviewerLifecycleCleanup(plan, event, settled, agentStarts)) {
            policyViolation = "forbidden Pi RPC control event";
        }
        if ([
            "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end", "queue_update",
            "extension_ui_response",
            "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
        ].includes(type)) {
            policyViolation = "forbidden Pi RPC control event";
        }
        if (type === "agent_settled")
            settled = true;
    };
    try {
        const isolatedAgentDir = preparePiRpcAgentDir(plan.snapshot);
        child = spawn(process.execPath, [
            sdkEntryPath,
            "--pi-executable", plan.snapshot.executable,
            "--expected-version", plan.snapshot.runtimeVersion,
            ...credentialHostArgs(plan),
            "--private-agent-dir", isolatedAgentDir,
            "--",
            ...plan.snapshot.argv,
        ], {
            cwd: plan.cwd,
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: isolatedAgentDir,
                ...(plan.snapshot.context.lane === "reviewer"
                    ? { [REVIEW_ORIGINAL_AGENT_DIR_ENV]: plan.snapshot.context.agentDir }
                    : {}),
            },
            stdio: ["pipe", "pipe", "pipe"],
        });
        child.stderr.on("data", () => { });
        client = new RpcClient(child, persistEvent);
        failureStage = "handshake";
        const initialState = requireResponse(await client.command("get_state"), "get_state");
        effectiveProviderApi = validateInitialState(initialState, plan);
        const commands = requireResponse(await client.command("get_commands"), "get_commands");
        validateCommands(commands, plan);
        requireResponse(await client.command("set_auto_retry", { enabled: false }), "set_auto_retry");
        requireResponse(await client.command("set_auto_compaction", { enabled: false }), "set_auto_compaction");
        const controlledState = requireResponse(await client.command("get_state"), "get_state");
        if (object(controlledState.data).autoCompactionEnabled !== false)
            throw new Error("Pi RPC auto-compaction did not disable");
        preparePiRpcAgentDir(plan.snapshot);
        writeAtomicJson(spoolPath(plan.runtimeRoot, "ready.json"), {
            ...identity,
            ok: true,
            piPid: child.pid,
            autoRetryDisableAccepted: true,
            autoCompactionEnabled: false,
            credentialMode: plan.snapshot.credentialMode,
            isolatedAgentDir,
        });
        failureStage = "await-dispatch";
        const dispatch = await waitForDispatch(plan, client);
        if (!dispatch) {
            await stopChild(child, client);
            preparePiRpcAgentDir(plan.snapshot);
            writeAtomicJson(spoolPath(plan.runtimeRoot, "terminal.json"), { ...identity, ok: false, error: "terminated before dispatch" });
            writeAtomicJson(spoolPath(plan.runtimeRoot, "terminated.json"), { ...identity, ok: true, reason: "pre-dispatch termination" });
            return;
        }
        failureStage = "dispatch";
        credentialHostArgs(plan);
        requireResponse(await client.command("prompt", { message: dispatch.message }), "prompt");
        writeAtomicJson(spoolPath(plan.runtimeRoot, "accepted.json"), { ...identity, ok: true, dispatchId: dispatch.dispatchId });
        failureStage = "agent-run";
        let abortSent = false;
        let abortStartedAt = null;
        let terminationRequested = false;
        for (;;) {
            if (settled)
                break;
            const exited = await Promise.race([client.exit.then((value) => ({ exited: value })), delay(POLL_MS).then(() => null)]);
            if (exited && !settled) {
                throw piRpcRunnerError("child_process", "child_exit_before_settled", true);
            }
            if (client.failure)
                throw client.failure;
            terminationRequested = terminationRequested || existsSync(spoolPath(plan.runtimeRoot, "terminate.json"));
            if ((policyViolation || terminationRequested) && !abortSent) {
                abortSent = true;
                abortStartedAt = Date.now();
                requireResponse(await client.command("abort"), "abort");
            }
            if (abortStartedAt !== null && Date.now() - abortStartedAt >= EXIT_TIMEOUT_MS) {
                policyViolation = policyViolation ?? "termination did not reach agent_settled before escalation";
                break;
            }
        }
        failureStage = "child-shutdown";
        childExit = await stopChild(child, client);
        failureStage = "rpc-output";
        if (client.failure)
            throw client.failure;
        failureStage = "credential-postflight";
        credentialHostArgs(plan);
        preparePiRpcAgentDir(plan.snapshot);
        const assistantTerminalFailure = assistantFailure;
        const terminalError = policyViolation ?? assistantTerminalFailure?.error ?? null;
        const ok = terminalError === null && !terminationRequested && settled;
        failureStage = "child-exit";
        if (ok && (childExit.code !== 0 || childExit.signal !== null)) {
            throw piRpcRunnerError("child_process", "child_exit_after_settled", false);
        }
        writeAtomicJson(spoolPath(plan.runtimeRoot, "terminal.json"), {
            ...identity,
            ok,
            ...(!ok ? { error: terminalError ?? "runtime terminated by Controller" } : {}),
            ...(!policyViolation && assistantTerminalFailure ? {
                failureStage: "agent-run",
                ...assistantTerminalFailure.diagnostic,
                childExit,
            } : {}),
            agentSettled: settled,
        });
        writeAtomicJson(spoolPath(plan.runtimeRoot, "terminated.json"), { ...identity, ok: true, reason: "settled and child exited" });
    }
    catch (error) {
        const primaryFailure = classifyPiRpcRunnerFailure(error, failureStage);
        let cleanupFailureCode = null;
        if (child && client) {
            try {
                childExit ??= await stopChild(child, client);
            }
            catch (stopError) {
                cleanupFailureCode = classifyPiRpcRunnerFailure(stopError, "child-shutdown").failureCode;
            }
        }
        else if (child) {
            cleanupFailureCode = "child_shutdown_unconfirmed";
        }
        const diagnosticFingerprint = digest({
            version: 1,
            ...primaryFailure,
            agentSettled: settled,
            agentEndObserved,
            lastEventType,
            childExit: childExitCategory(childExit),
        });
        writeAtomicJson(spoolPath(plan.runtimeRoot, "terminal.json"), {
            ...identity,
            ok: false,
            error: "Pi RPC runner failed",
            failureStage,
            ...primaryFailure,
            diagnosticFingerprint,
            childExit,
            agentSettled: settled,
            agentEndObserved,
            lastEventType,
            eventCount,
            stdoutEnded: client?.outputFinished ?? false,
            ...(cleanupFailureCode ? { cleanupFailureCode } : {}),
        });
        writeAtomicJson(spoolPath(plan.runtimeRoot, "terminated.json"), {
            ...identity,
            ok: cleanupFailureCode === null,
            reason: cleanupFailureCode === null ? "runner failure child exit confirmed" : "runner failure child exit unconfirmed",
            ...(cleanupFailureCode ? { error: "Pi RPC child exit unconfirmed", cleanupFailureCode } : {}),
        });
        throw new Error("Pi RPC runner failed");
    }
}
function observedPayloadBytes(event) {
    const projected = event.payloadBytes;
    return typeof projected === "number" && Number.isSafeInteger(projected) && projected >= 0
        ? projected
        : Buffer.byteLength(JSON.stringify(event), "utf8");
}
function observedPayloadDigest(event) {
    const projected = event.payloadDigest;
    return typeof projected === "string" && /^[0-9a-f]{64}$/u.test(projected) ? projected : digest(event);
}
function safeToolName(value) {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value) ? value : null;
}
async function waitForDispatch(plan, client) {
    for (;;) {
        if (existsSync(spoolPath(plan.runtimeRoot, "terminate.json")))
            return null;
        if (existsSync(spoolPath(plan.runtimeRoot, "dispatch.json"))) {
            const value = readJson(spoolPath(plan.runtimeRoot, "dispatch.json"));
            if (value.version !== 1
                || value.attemptId !== plan.attemptId
                || value.generation !== plan.generation
                || value.planDigest !== plan.planDigest
                || value.dispatchId !== plan.attemptId
                || value.promptDigest !== plan.promptDigest
                || typeof value.message !== "string")
                throw new Error("Pi RPC dispatch has a different identity");
            const skill = plan.snapshot.context.lane === "worker" ? "implement" : "code-review";
            const prefix = `/skill:${skill} [harness-dispatch:${value.dispatchId}]\n`;
            if (!value.message.startsWith(prefix) || digest(value.message.slice(prefix.length)) !== plan.promptDigest) {
                throw new Error("Pi RPC dispatch body differs from the immutable prompt digest");
            }
            return { dispatchId: value.dispatchId, message: value.message };
        }
        const exited = await Promise.race([client.exit.then(() => true), delay(POLL_MS).then(() => false)]);
        if (exited)
            throw new Error("Pi RPC exited before dispatch");
        if (client.failure)
            throw client.failure;
    }
}
export function validateInitialState(response, plan) {
    const state = object(response.data);
    if (state.isStreaming !== false || state.isCompacting === true || Number(state.messageCount) !== 0 || Number(state.pendingMessageCount) !== 0) {
        throw new Error("Pi RPC did not start as a fresh idle session");
    }
    if (state.sessionFile)
        throw new Error("Pi RPC created a persistent session despite --no-session");
    if (state.thinkingLevel !== plan.snapshot.thinking)
        throw new Error("Pi RPC thinking level differs from the execution snapshot");
    const model = object(state.model);
    if (model.provider !== plan.snapshot.provider)
        throw new Error("Pi RPC provider differs from the execution snapshot");
    if (model.id !== plan.snapshot.model)
        throw new Error("Pi RPC model differs from the execution snapshot");
    return providerApi(model.api);
}
function validateCommands(response, plan) {
    const commands = Array.isArray(object(response.data).commands) ? object(response.data).commands : [];
    const entries = commands.map(object);
    const expectedSkills = new Set(plan.snapshot.resources
        .filter((resource) => resource.kind === "skill")
        .map((resource) => `skill:${basename(resource.path) === "SKILL.md" ? basename(dirname(resource.path)) : basename(resource.path)}`));
    const loadedSkills = new Set(entries.filter((entry) => entry.source === "skill").map((entry) => String(entry.name)));
    for (const expected of expectedSkills)
        if (!loadedSkills.has(expected))
            throw new Error(`Pi RPC did not load ${expected}`);
    if (entries.some((entry) => entry.source === "prompt"))
        throw new Error("Pi RPC loaded an ambient prompt template");
    for (const loaded of loadedSkills)
        if (!expectedSkills.has(loaded))
            throw new Error(`Pi RPC loaded an ambient skill: ${loaded}`);
}
function validatePlan(plan) {
    const lane = plan.snapshot.context?.lane;
    const expectedCredentialMode = lane === "worker" ? "canonical-oauth" : "canonical-model-config";
    if (plan.version !== 1
        || !plan.attemptId
        || !plan.generation
        || !/^[0-9a-f]{64}$/i.test(plan.planDigest)
        || !/^[0-9a-f]{64}$/i.test(plan.promptDigest)
        || plan.snapshot.adapter !== "pi-rpc"
        || !isQualifiedPiRpcVersion(plan.snapshot.runtimeVersion)
        || plan.snapshot.retryMode !== "disabled"
        || plan.snapshot.compactionMode !== "disabled"
        || (lane !== "worker" && lane !== "reviewer")
        || plan.snapshot.credentialMode !== expectedCredentialMode
        || !plan.snapshot.provider
        || !plan.snapshot.model
        || !plan.snapshot.context?.agentDir
        || !plan.snapshot.argv.includes("--no-session")
        || !plan.snapshot.argv.includes("--mode")
        || !plan.snapshot.argv.includes("rpc"))
        throw new Error("invalid Pi RPC runtime plan");
    credentialHostArgs(plan);
}
function allowedReviewerLifecycleCleanup(plan, event, settled, agentStarts) {
    const allowedKeys = new Set(["type", "id", "method", "widgetKey"]);
    return (agentStarts === 0 || settled)
        && plan.snapshot.context?.lane === "reviewer"
        && typeof event.id === "string"
        && event.id.length > 0
        && event.method === "setWidget"
        && event.widgetKey === "subagent-async"
        && Object.keys(event).every((key) => allowedKeys.has(key));
}
function credentialHostArgs(plan) {
    const agentDir = plan.snapshot.context?.agentDir;
    if (!agentDir)
        throw new Error("Pi RPC plan has no canonical credential agent directory");
    const modelConfigs = plan.snapshot.resources.filter((resource) => resource.kind === "model-config");
    if (plan.snapshot.credentialMode === "canonical-oauth") {
        if (modelConfigs.length !== 0)
            throw new Error("subscription OAuth RPC must not bind models.json");
        return ["--credential-mode", "canonical-oauth", "--credential-agent-dir", agentDir];
    }
    if (plan.snapshot.credentialMode !== "canonical-model-config" || modelConfigs.length !== 1) {
        throw new Error("custom-model RPC must bind exactly one models.json");
    }
    const modelConfig = modelConfigs[0];
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
function boundRuntimeResource(plan, name) {
    const matches = plan.snapshot.resources.filter((resource) => resource.kind === "runtime" && basename(resource.path) === name);
    if (matches.length !== 1)
        throw new Error(`Pi RPC plan must bind exactly one ${name}`);
    const resource = matches[0];
    if (executionResourceDigest(dirname(resource.path)) !== resource.digest) {
        throw new Error(`Pi RPC runtime resource changed after preparation: ${name}`);
    }
    return resource.path;
}
function requireResponse(response, command) {
    if (response.type !== "response" || response.command !== command || response.success !== true) {
        throw new Error(`invalid Pi RPC ${command} response`);
    }
    return response;
}
async function stopChild(child, client) {
    child.stdin.end();
    if (!await exitsWithin(client.exit, EXIT_TIMEOUT_MS)) {
        child.kill("SIGTERM");
        if (!await exitsWithin(client.exit, EXIT_TIMEOUT_MS / 2)) {
            child.kill("SIGKILL");
            if (!await exitsWithin(client.exit, EXIT_TIMEOUT_MS / 2)) {
                throw piRpcRunnerError("child_process", "child_shutdown_unconfirmed", false);
            }
        }
    }
    if (!await exitsWithin(client.outputEnded, EXIT_TIMEOUT_MS / 2)) {
        throw piRpcRunnerError("rpc_transport", "rpc_stdout_end_timeout", false);
    }
    return client.exit;
}
async function exitsWithin(exit, timeoutMs) {
    return new Promise((resolveExit) => {
        const timer = setTimeout(() => resolveExit(false), timeoutMs);
        exit.then(() => {
            clearTimeout(timer);
            resolveExit(true);
        });
    });
}
function receiptIdentity(plan) {
    return { version: 1, attemptId: plan.attemptId, generation: plan.generation, planDigest: plan.planDigest };
}
function childExitCategory(childExit) {
    if (!childExit)
        return "unknown";
    if (childExit.signal !== null)
        return "signal";
    if (childExit.code === 0)
        return "success";
    if (childExit.code !== null)
        return "nonzero";
    return "unknown";
}
function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function flag(argv, name) {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] ?? null : null;
}
function delay(ms) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
async function withTimeout(promise, timeoutMs) {
    return new Promise((resolveValue, reject) => {
        const timer = setTimeout(() => reject(piRpcRunnerError("rpc_transport", "rpc_command_timeout", true)), timeoutMs);
        promise.then((value) => {
            clearTimeout(timer);
            resolveValue(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch(() => {
        process.stderr.write("FAIL: Pi RPC runner failed\n");
        process.exitCode = 1;
    });
}
//# sourceMappingURL=pi-rpc-runner.js.map