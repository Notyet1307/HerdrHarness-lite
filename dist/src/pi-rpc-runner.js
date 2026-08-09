#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
import { digest } from "./model.js";
import { readJson, preparePiRpcAgentDir, spoolPath, SUPPORTED_PI_RPC_VERSION, writeAtomicJson, writeExclusiveJson, } from "./pi-rpc-spool.js";
const MAX_RPC_LINE_BYTES = 1024 * 1024;
const MAX_EVENT_LOG_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 10_000;
const POLL_MS = 50;
export class StrictJsonlDecoder {
    buffer = "";
    push(chunk) {
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer, "utf8") > MAX_RPC_LINE_BYTES && !this.buffer.includes("\n")) {
            throw new Error("Pi RPC line exceeded the maximum size");
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
            if (Buffer.byteLength(line, "utf8") > MAX_RPC_LINE_BYTES)
                throw new Error("Pi RPC line exceeded the maximum size");
            const value = JSON.parse(line);
            if (!value || typeof value !== "object" || Array.isArray(value))
                throw new Error("Pi RPC record is not an object");
            records.push(value);
        }
        return records;
    }
    finish() {
        if (this.buffer.trim())
            throw new Error("Pi RPC stdout ended with an incomplete JSONL record");
    }
}
class RpcClient {
    child;
    onEvent;
    decoder = new StrictJsonlDecoder();
    pending = new Map();
    sequence = 0;
    fatalError = null;
    exit;
    outputEnded;
    constructor(child, onEvent) {
        this.child = child;
        this.onEvent = onEvent;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            try {
                for (const record of this.decoder.push(String(chunk)))
                    this.accept(record);
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
    async command(type, fields = {}) {
        if (this.fatalError)
            throw this.fatalError;
        const id = `runner-${++this.sequence}`;
        const response = new Promise((resolveResponse, reject) => {
            this.pending.set(id, { command: type, resolve: resolveResponse, reject });
        });
        this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
        return withTimeout(response, COMMAND_TIMEOUT_MS, `Pi RPC ${type} response`);
    }
    accept(record) {
        if (record.type !== "response") {
            if (typeof record.type !== "string")
                throw new Error("Pi RPC event has no type");
            this.onEvent(record);
            return;
        }
        const id = record.id;
        const command = record.command;
        if (typeof id !== "string" || typeof command !== "string")
            throw new Error("Pi RPC response has no identity");
        const pending = this.pending.get(id);
        if (!pending)
            throw new Error(`Pi RPC returned an unknown or duplicate response id: ${id}`);
        this.pending.delete(id);
        if (pending.command !== command) {
            const error = new Error(`Pi RPC response command ${command} != ${pending.command}`);
            pending.reject(error);
            throw error;
        }
        if (record.success !== true) {
            pending.reject(new Error(`Pi RPC ${command} failed: ${String(record.error ?? "unknown failure")}`));
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
    const plan = readJson(planPath);
    validatePlan(plan);
    const identity = receiptIdentity(plan);
    writeExclusiveJson(spoolPath(plan.runtimeRoot, "owner.json"), {
        ...identity,
        ok: true,
        runnerPid: process.pid,
        handle: plan.handle,
    });
    let child = null;
    let client = null;
    let stderr = "";
    let settled = false;
    let policyViolation = null;
    let agentStarts = 0;
    let eventBytes = 0;
    let logTruncated = false;
    const persistEvent = (event) => {
        const type = String(event.type);
        if (["message_update", "tool_execution_update", "bash_execution_update"].includes(type))
            return;
        const summary = { type, digest: digest(event) };
        if (type === "agent_end")
            summary.willRetry = event.willRetry === true;
        if (type === "tool_execution_start" || type === "tool_execution_end") {
            summary.toolName = event.toolName;
            summary.toolCallId = event.toolCallId;
            summary.isError = event.isError === true;
        }
        if (type === "message_end")
            summary.role = object(event.message).role;
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
        if (["auto_retry_start", "compaction_start", "queue_update", "extension_ui_request"].includes(type) || type.startsWith("summarization_retry")) {
            policyViolation = `forbidden Pi RPC event: ${type}`;
        }
        if (type === "agent_settled")
            settled = true;
    };
    try {
        const isolatedAgentDir = preparePiRpcAgentDir(plan.snapshot);
        child = spawn(plan.snapshot.executable, plan.snapshot.argv, {
            cwd: plan.cwd,
            env: { ...process.env, PI_CODING_AGENT_DIR: isolatedAgentDir },
            stdio: ["pipe", "pipe", "pipe"],
        });
        child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
        client = new RpcClient(child, persistEvent);
        const initialState = requireResponse(await client.command("get_state"), "get_state");
        validateInitialState(initialState, plan);
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
            ambientAuthExcluded: true,
            isolatedAgentDir,
            runtimeModel: object(controlledState.data).model ?? null,
            thinkingLevel: object(controlledState.data).thinkingLevel,
        });
        const dispatch = await waitForDispatch(plan, client);
        if (!dispatch) {
            await stopChild(child, client);
            preparePiRpcAgentDir(plan.snapshot);
            writeAtomicJson(spoolPath(plan.runtimeRoot, "terminal.json"), { ...identity, ok: false, error: "terminated before dispatch" });
            writeAtomicJson(spoolPath(plan.runtimeRoot, "terminated.json"), { ...identity, ok: true, reason: "pre-dispatch termination" });
            return;
        }
        requireResponse(await client.command("prompt", { message: dispatch.message }), "prompt");
        writeAtomicJson(spoolPath(plan.runtimeRoot, "accepted.json"), { ...identity, ok: true, dispatchId: dispatch.dispatchId });
        let abortSent = false;
        let abortStartedAt = null;
        let terminationRequested = false;
        for (;;) {
            if (settled)
                break;
            const exited = await Promise.race([client.exit.then((value) => ({ exited: value })), delay(POLL_MS).then(() => null)]);
            if (exited)
                throw new Error(`Pi RPC exited before agent_settled: ${JSON.stringify(exited.exited)}`);
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
        const childExit = await stopChild(child, client);
        if (client.failure)
            throw client.failure;
        preparePiRpcAgentDir(plan.snapshot);
        const ok = policyViolation === null && !terminationRequested && settled;
        if (ok && (childExit.code !== 0 || childExit.signal !== null)) {
            throw new Error(`Pi RPC exited unsuccessfully after settlement: ${JSON.stringify(childExit)}`);
        }
        writeAtomicJson(spoolPath(plan.runtimeRoot, "terminal.json"), {
            ...identity,
            ok,
            ...(!ok ? { error: policyViolation ?? "runtime terminated by Controller" } : {}),
            agentSettled: settled,
            stderr,
        });
        writeAtomicJson(spoolPath(plan.runtimeRoot, "terminated.json"), { ...identity, ok: true, reason: "settled and child exited" });
    }
    catch (error) {
        let terminationError = null;
        if (child && client) {
            try {
                await stopChild(child, client);
            }
            catch (stopError) {
                terminationError = stopError instanceof Error ? stopError.message : String(stopError);
            }
        }
        else if (child) {
            terminationError = "Pi RPC child exists without a controllable client";
        }
        const detail = [error instanceof Error ? error.message : String(error), stderr, terminationError]
            .filter(Boolean)
            .join("\n")
            .slice(-4_000);
        writeAtomicJson(spoolPath(plan.runtimeRoot, "terminal.json"), { ...identity, ok: false, error: detail });
        writeAtomicJson(spoolPath(plan.runtimeRoot, "terminated.json"), {
            ...identity,
            ok: terminationError === null,
            reason: terminationError === null ? "runner failure child exit confirmed" : "runner failure child exit unconfirmed",
            ...(terminationError ? { error: terminationError } : {}),
        });
        throw error;
    }
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
            const prefix = `/skill:implement [harness-dispatch:${value.dispatchId}]\n`;
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
    if (plan.version !== 1
        || !plan.attemptId
        || !plan.generation
        || !/^[0-9a-f]{64}$/i.test(plan.planDigest)
        || !/^[0-9a-f]{64}$/i.test(plan.promptDigest)
        || plan.snapshot.adapter !== "pi-rpc"
        || plan.snapshot.runtimeVersion !== SUPPORTED_PI_RPC_VERSION
        || plan.snapshot.retryMode !== "disabled"
        || plan.snapshot.compactionMode !== "disabled"
        || !plan.snapshot.provider
        || !plan.snapshot.model
        || !plan.snapshot.argv.includes("--no-session")
        || !plan.snapshot.argv.includes("--mode")
        || !plan.snapshot.argv.includes("rpc"))
        throw new Error("invalid Pi RPC runtime plan");
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
            if (!await exitsWithin(client.exit, EXIT_TIMEOUT_MS / 2))
                throw new Error("Pi RPC child termination is not confirmed");
        }
    }
    if (!await exitsWithin(client.outputEnded, EXIT_TIMEOUT_MS / 2))
        throw new Error("Pi RPC stdout termination is not confirmed");
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
async function withTimeout(promise, timeoutMs, label) {
    return new Promise((resolveValue, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
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
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=pi-rpc-runner.js.map