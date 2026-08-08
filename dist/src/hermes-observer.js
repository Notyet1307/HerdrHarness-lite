#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { JsonStateStore } from "./adapters/json-store.js";
import { isRetryAction } from "./model.js";
import { allowedActionsFor } from "./policy.js";
import { controllerHeartbeatPath } from "./controller-heartbeat.js";
const MAX_MESSAGE_LENGTH = 3_900;
const MAX_OUTBOX = 512;
const LOG_CHUNK_BYTES = 1024 * 1024;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];
async function main(argv) {
    if (argv[2] !== "run")
        throw new Error("usage: hermes-observer run --config /absolute/bridge.json [--once]");
    const config = loadConfig(requiredFlag(argv, "--config"));
    const once = argv.includes("--once");
    for (;;) {
        await cycle(config);
        if (once)
            return 0;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.pollMs);
    }
}
async function cycle(config) {
    const state = loadState(config.observerState);
    await flushOutbox(config, state);
    if (!state.initialized) {
        state.initialized = true;
        enqueue(state, "observer-online", [
            "✅ Herdr Harness Telegram Observer 已上线",
            "模式：通知与决策入口；只有精确绑定的人工点击可请求 Harness 写入恢复批准。",
            safeView(config, "status"),
        ].join("\n"));
    }
    await observeLedger(config, state);
    observeControllerLog(config, state);
    observeHeartbeat(config, state);
    saveState(config.observerState, state);
    await flushOutbox(config, state);
}
async function observeLedger(config, observer) {
    let ledger;
    try {
        ledger = await new JsonStateStore(config.harnessStateDir).load();
    }
    catch (error) {
        if (observer.ledgerHealthy) {
            enqueue(observer, "ledger-unavailable", `⚠️ Observer 无法读取 Harness ledger\n${clean(message(error), 700)}\n未执行任何恢复动作。`);
        }
        observer.ledgerHealthy = false;
        return;
    }
    if (!observer.ledgerHealthy && observer.ledgerInitialized) {
        enqueue(observer, "ledger-restored", `✅ Harness ledger 读取已恢复\n${safeView(config, "status")}`);
    }
    observer.ledgerHealthy = true;
    if (!observer.ledgerInitialized) {
        observer.ledgerInitialized = true;
        baselineLedger(observer, ledger);
        if (ledger.activeJob?.analysis) {
            enqueueAnalysis(config, observer, ledger.activeJob, "🧭 当前任务已有 Analyst 恢复建议");
        }
        else if (ledger.activeJob?.incident) {
            enqueue(observer, `incident:${ledger.activeJob.incident.id}`, safeView(config, "notification"));
        }
        return;
    }
    const oldTerminalCount = observer.terminalCount;
    if (ledger.terminalJobs.length < oldTerminalCount) {
        enqueue(observer, `terminal-history-shrank:${ledger.terminalJobs.length}`, "⚠️ Harness terminal history 数量倒退；Observer 已重新建立只读基线。请人工核对 ledger。");
    }
    else {
        for (const terminal of ledger.terminalJobs.slice(oldTerminalCount)) {
            enqueue(observer, `terminal:${terminal.id}:${terminal.state}`, `${terminal.state === "done" ? "✅" : "⛔️"} 任务${terminal.state === "done" ? "完成" : "取消"}：${clean(terminal.repo, 160)}#${terminal.issueNumber}\n完成时间：${clean(terminal.finishedAt, 80)}`);
        }
    }
    const job = ledger.activeJob;
    const jobChanged = job?.id !== observer.lastJobId;
    if (job && jobChanged) {
        enqueue(observer, `job:${job.id}`, `🆕 Harness 已领取新任务\n${safeView(config, "status")}`);
        if (job.analysis) {
            enqueueAnalysis(config, observer, job, "🧭 Analyst 已给出恢复建议");
        }
        else if (job.incident) {
            enqueue(observer, `incident:${job.incident.id}`, safeView(config, "notification"));
        }
    }
    else if (job) {
        observeJob(config, observer, job);
    }
    else if (observer.lastJobId && ledger.terminalJobs.length === oldTerminalCount) {
        enqueue(observer, `active-job-disappeared:${observer.lastJobId}`, "⚠️ 活跃任务从 ledger 消失且没有新增终态记录；请人工核对。");
    }
    baselineLedger(observer, ledger);
}
function observeJob(config, observer, job) {
    if (observer.lastJobRevision !== null && job.revision < observer.lastJobRevision) {
        enqueue(observer, `revision-regressed:${job.id}:${job.revision}`, `⚠️ Harness revision 从 ${observer.lastJobRevision} 倒退到 ${job.revision}；请人工核对 ledger。`);
    }
    const incidentChanged = job.incident?.id !== (observer.lastIncidentId ?? undefined);
    const analysisChanged = job.analysis?.id !== (observer.lastAnalysisId ?? undefined);
    if (job.analysis && analysisChanged) {
        enqueueAnalysis(config, observer, job, "🧭 Analyst 已给出恢复建议");
    }
    else if (job.incident && incidentChanged) {
        enqueue(observer, `incident:${job.incident.id}`, safeView(config, "notification"));
    }
    if (job.state === observer.lastJobState)
        return;
    const heading = transitionHeading(observer.lastJobState, job.state);
    if (heading)
        enqueue(observer, `state:${job.id}:${job.revision}:${job.state}`, `${heading}\n${safeView(config, "status")}`);
}
function transitionHeading(previous, next) {
    if (next === "reviewer_ready")
        return "🧪 Worker 已完成，准备启动独立 Reviewer";
    if (next === "worker_ready" && previous === "reviewer_running")
        return "🔁 Reviewer 要求返工，准备启动全新 Worker";
    if (next === "publish_ready")
        return "✅ 独立 Reviewer 已通过，任务可发布";
    if (next === "awaiting_merge")
        return "📬 PR 已发布，正在等待 required checks / auto-merge";
    if (next === "recovery_approved")
        return "👍 Harness 已记录人工恢复批准，等待 Controller 消费";
    return null;
}
function baselineLedger(observer, ledger) {
    const job = ledger.activeJob;
    observer.lastJobId = job?.id ?? null;
    observer.lastJobRevision = job?.revision ?? null;
    observer.lastJobState = job?.state ?? null;
    observer.lastIncidentId = job?.incident?.id ?? null;
    observer.lastAnalysisId = job?.analysis?.id ?? null;
    observer.terminalCount = ledger.terminalJobs.length;
}
function observeControllerLog(config, observer) {
    if (!existsSync(config.controllerLog)) {
        observer.logInitialized = true;
        observer.controllerLogOffset = 0;
        return;
    }
    try {
        const stat = statSync(config.controllerLog);
        if (!observer.logInitialized) {
            observer.logInitialized = true;
            observer.controllerLogOffset = stat.size;
            return;
        }
        if (!observer.logHealthy)
            enqueue(observer, "controller-log-restored", "✅ Controller 日志读取已恢复。");
        observer.logHealthy = true;
        if (stat.size < observer.controllerLogOffset) {
            observer.controllerLogOffset = stat.size;
            enqueue(observer, `controller-log-reset:${stat.size}`, "⚠️ Controller 日志被截断或轮转；Observer 已从当前文件末尾重新建立基线。");
            return;
        }
        if (stat.size === observer.controllerLogOffset)
            return;
        const text = readLogChunk(config.controllerLog, observer.controllerLogOffset, stat.size);
        const newline = text.lastIndexOf("\n");
        if (newline < 0)
            return;
        const complete = text.slice(0, newline + 1);
        const startingOffset = observer.controllerLogOffset;
        observer.controllerLogOffset += Buffer.byteLength(complete, "utf8");
        complete.split("\n").forEach((line, index) => {
            if (line.trim())
                observeControllerEvent(config, observer, line, `${startingOffset}:${index}`);
        });
    }
    catch (error) {
        if (observer.logHealthy) {
            enqueue(observer, "controller-log-unavailable", `⚠️ Observer 无法读取 Controller 日志\n${clean(message(error), 700)}\n未执行任何恢复动作。`);
        }
        observer.logHealthy = false;
    }
}
function readLogChunk(path, offset, size) {
    const length = Math.min(size - offset, LOG_CHUNK_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
        const bytes = readSync(fd, buffer, 0, length, offset);
        return buffer.toString("utf8", 0, bytes);
    }
    finally {
        closeSync(fd);
    }
}
function observeControllerEvent(config, observer, line, position) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        return;
    }
    if (!value || typeof value !== "object")
        return;
    const event = value;
    if (event.ok === true) {
        observer.lastControllerAlertKey = null;
        return;
    }
    if (event.ok !== false || typeof event.action !== "string" || typeof event.message !== "string" || event.action === "blocked")
        return;
    const alertKey = `${event.action}\u0000${typeof event.jobId === "string" ? event.jobId : ""}\u0000${event.message}`;
    if (alertKey === observer.lastControllerAlertKey)
        return;
    observer.lastControllerAlertKey = alertKey;
    enqueue(observer, `controller:${position}:${clean(event.action, 80)}`, [
        `⚠️ Controller 推进失败 · ${clean(event.action, 80)}`,
        clean(event.message, 700),
        safeView(config, "status"),
        "Observer 未执行自动恢复。",
    ].join("\n"));
    if (event.action === "preflight_failed") {
        observer.controllerDown = true;
        observer.controllerDownLogMtimeMs = safeLogMtime(config.controllerHeartbeat);
    }
}
function observeHeartbeat(config, observer) {
    const mtime = safeLogMtime(config.controllerHeartbeat);
    const stale = mtime === 0 || Date.now() - mtime > config.heartbeatTimeoutMs;
    if (stale && !observer.controllerDown) {
        observer.controllerDown = true;
        observer.controllerDownLogMtimeMs = mtime;
        enqueue(observer, `controller-heartbeat-stopped:${mtime}`, "⏹️ Harness Controller 心跳已停止\nObserver 只负责通知，不会自动重启 Controller。");
    }
    else if (!stale && observer.controllerDown && mtime > observer.controllerDownLogMtimeMs) {
        observer.controllerDown = false;
        observer.controllerDownLogMtimeMs = 0;
        enqueue(observer, `controller-heartbeat-restored:${mtime}`, `✅ Harness Controller 心跳已恢复\n${safeView(config, "status")}`);
    }
}
function safeLogMtime(path) {
    try {
        return statSync(path).mtimeMs;
    }
    catch {
        return 0;
    }
}
function safeView(config, command) {
    const output = spawnSync(config.nodeBin, [config.statusScript, command, "--config", config.bridgeConfig], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
    });
    if (output.status === 0 && output.stdout.trim())
        return bounded(output.stdout.trim());
    return `详情读取失败：${clean(output.error?.message || output.stderr || `exit ${output.status}`, 700)}`;
}
async function flushOutbox(config, state) {
    for (;;) {
        const entry = state.outbox.find((candidate) => candidate.nextAttemptAt <= Date.now());
        if (!entry)
            return;
        let sent;
        if (entry.kind === "approval") {
            let ledger;
            try {
                ledger = await new JsonStateStore(config.harnessStateDir).load();
            }
            catch (error) {
                retryEntry(config, state, entry, message(error));
                return;
            }
            const job = ledger.activeJob;
            if (job?.state !== "blocked"
                || job.analysis?.id !== entry.analysisId
                || job.analysis.incidentId !== job.incident?.id
                || !isRetryAction(job.analysis.action)) {
                state.outbox = state.outbox.filter((candidate) => candidate !== entry);
                saveState(config.observerState, state);
                continue;
            }
            const requested = spawnSync(config.nodeBin, [
                config.approvalScript,
                "request",
                "--config",
                config.bridgeConfig,
                "--json",
            ], { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
            const card = requested.status === 0 ? parseApprovalCard(requested.stdout, entry.analysisId) : null;
            if (requested.status !== 0) {
                sent = requested;
            }
            else if (!card) {
                retryEntry(config, state, entry, "approval script returned an invalid card payload");
                return;
            }
            else {
                sent = spawnSync(config.hermesBin, ["--profile", config.hermesProfile, "harness-card"], {
                    encoding: "utf8",
                    input: JSON.stringify(card),
                    timeout: 20_000,
                    maxBuffer: 1024 * 1024,
                });
            }
        }
        else {
            sent = spawnSync(config.hermesBin, [
                "--profile",
                config.hermesProfile,
                "send",
                "--to",
                config.target,
                "--quiet",
                entry.message,
            ], { encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 });
        }
        if (sent.status === 0) {
            state.outbox = state.outbox.filter((candidate) => candidate !== entry);
            saveState(config.observerState, state);
            process.stdout.write(`${JSON.stringify({ ok: true, action: "notification_sent", key: entry.key })}\n`);
            continue;
        }
        retryEntry(config, state, entry, sent.error?.message || sent.stderr || `exit ${sent.status}`);
        return;
    }
}
function retryEntry(config, state, entry, error) {
    entry.attempts += 1;
    entry.nextAttemptAt = Date.now() + RETRY_DELAYS_MS[Math.min(entry.attempts - 1, RETRY_DELAYS_MS.length - 1)];
    saveState(config.observerState, state);
    process.stderr.write(`${JSON.stringify({ ok: false, action: "notification_retry", key: entry.key, attempts: entry.attempts, error: clean(error, 700) })}\n`);
}
function enqueue(state, key, messageText) {
    if (state.outbox.some((entry) => entry.key === key))
        return;
    if (state.outbox.length >= MAX_OUTBOX)
        throw new Error(`observer outbox reached ${MAX_OUTBOX} entries`);
    state.outbox.push({ kind: "text", key, message: bounded(messageText.trim()), attempts: 0, nextAttemptAt: 0 });
}
function enqueueAnalysis(config, state, job, heading) {
    const analysis = job.analysis;
    const exactRetry = job.state === "blocked"
        && job.incident !== null
        && analysis?.incidentId === job.incident.id
        && isRetryAction(analysis.action)
        && job.incident.allowedActions.includes(analysis.action)
        && allowedActionsFor(job.incident.class, job.incident.lane).includes(analysis.action);
    if (!exactRetry) {
        enqueue(state, `analysis:${analysis?.id ?? job.revision}`, safeView(config, "notification"));
        return;
    }
    const key = `approval:${analysis.id}`;
    if (state.outbox.some((entry) => entry.key === key))
        return;
    if (state.outbox.length >= MAX_OUTBOX)
        throw new Error(`observer outbox reached ${MAX_OUTBOX} entries`);
    state.outbox.push({ kind: "approval", key, analysisId: analysis.id, attempts: 0, nextAttemptAt: 0 });
}
function parseApprovalCard(output, analysisId) {
    try {
        const value = JSON.parse(output);
        const card = value.card;
        if (value.ok !== true
            || value.action !== "challenge_created"
            || value.analysisId !== analysisId
            || typeof card?.text !== "string"
            || card.text.length === 0
            || card.text.length > MAX_MESSAGE_LENGTH
            || typeof card.approveLabel !== "string"
            || card.approveLabel.length === 0
            || card.approveLabel.length > 64
            || typeof card.approveCallback !== "string"
            || !/^hh:a:(?:[a-z0-9][a-z0-9-]{0,31}:)?[0-9A-F]{16}$/.test(card.approveCallback)
            || typeof card.holdCallback !== "string"
            || !/^hh:h:(?:[a-z0-9][a-z0-9-]{0,31}:)?[0-9A-F]{16}$/.test(card.holdCallback))
            return null;
        return card;
    }
    catch {
        return null;
    }
}
function loadConfig(path) {
    assertSecureAbsoluteFile(path, "bridge config");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const paths = ["harnessConfig", "nodeBin", "statusScript", "approvalScript", "hermesBin", "observerState", "controllerLog"];
    for (const name of paths) {
        if (!parsed[name] || !isAbsolute(parsed[name]))
            throw new Error(`${name} must be an absolute path`);
    }
    if (!parsed.hermesProfile || !/^[A-Za-z0-9._-]+$/.test(parsed.hermesProfile) || parsed.target !== "telegram") {
        throw new Error("a safe hermesProfile and target=telegram are required");
    }
    if (!Number.isInteger(parsed.pollMs) || parsed.pollMs < 1_000)
        throw new Error("pollMs must be an integer of at least 1000");
    if (!Number.isInteger(parsed.heartbeatTimeoutMs) || parsed.heartbeatTimeoutMs < parsed.pollMs * 3) {
        throw new Error("heartbeatTimeoutMs must be an integer of at least 3 * pollMs");
    }
    const file = parsed;
    const harness = JSON.parse(readFileSync(file.harnessConfig, "utf8"));
    if (typeof harness.stateDir !== "string" || !isAbsolute(harness.stateDir))
        throw new Error("Harness config stateDir must be absolute");
    if (!existsSync(harness.stateDir))
        throw new Error("Harness stateDir does not exist");
    return {
        ...file,
        bridgeConfig: path,
        harnessStateDir: harness.stateDir,
        controllerHeartbeat: controllerHeartbeatPath(harness.stateDir),
    };
}
function assertSecureAbsoluteFile(path, label) {
    if (!isAbsolute(path))
        throw new Error(`${label} path must be absolute`);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0)
        throw new Error(`${label} must not be a symlink or group/other writable`);
}
function loadState(path) {
    if (!existsSync(path))
        return emptyState();
    assertSecureAbsoluteFile(path, "observer state");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const value = raw.version === 1
        ? { ...raw, version: 2, outbox: raw.outbox.map((entry) => ({ kind: "text", ...entry })) }
        : raw;
    if (value.version !== 2
        || typeof value.initialized !== "boolean"
        || typeof value.ledgerInitialized !== "boolean"
        || typeof value.ledgerHealthy !== "boolean"
        || typeof value.logInitialized !== "boolean"
        || typeof value.logHealthy !== "boolean"
        || typeof value.controllerDown !== "boolean"
        || !Number.isFinite(value.controllerDownLogMtimeMs)
        || !Number.isInteger(value.controllerLogOffset)
        || value.controllerLogOffset < 0
        || !Number.isInteger(value.terminalCount)
        || value.terminalCount < 0
        || !Array.isArray(value.outbox)
        || value.outbox.some((entry) => !entry
            || typeof entry.key !== "string"
            || !Number.isInteger(entry.attempts)
            || !Number.isFinite(entry.nextAttemptAt)
            || (entry.kind === "text" ? typeof entry.message !== "string" : entry.kind !== "approval" || typeof entry.analysisId !== "string"))) {
        throw new Error("invalid observer state");
    }
    return value;
}
function emptyState() {
    return {
        version: 2,
        initialized: false,
        ledgerInitialized: false,
        ledgerHealthy: true,
        logInitialized: false,
        logHealthy: true,
        controllerDown: false,
        controllerDownLogMtimeMs: 0,
        controllerLogOffset: 0,
        lastControllerAlertKey: null,
        lastJobId: null,
        lastJobRevision: null,
        lastJobState: null,
        lastIncidentId: null,
        lastAnalysisId: null,
        terminalCount: 0,
        outbox: [],
    };
}
function saveState(path, state) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temp = join(directory, ".state.json.tmp");
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
}
function requiredFlag(argv, name) {
    const index = argv.indexOf(name);
    const value = index >= 0 ? argv[index + 1] : undefined;
    if (!value?.trim())
        throw new Error(`${name} is required`);
    return value;
}
function bounded(value) {
    return value.length <= MAX_MESSAGE_LENGTH ? value : `${value.slice(0, MAX_MESSAGE_LENGTH - 20)}\n…内容已截断`;
}
function clean(value, max) {
    return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
main(process.argv)
    .then((code) => {
    process.exitCode = code;
})
    .catch((error) => {
    process.stderr.write(`FAIL: ${message(error)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=hermes-observer.js.map