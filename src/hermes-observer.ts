#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { JsonStateStore } from "./adapters/json-store.js";
import type { HarnessState, Job, JobState } from "./model.js";

const MAX_MESSAGE_LENGTH = 3_900;
const MAX_OUTBOX = 512;
const LOG_CHUNK_BYTES = 1024 * 1024;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];

type ObserverConfigFile = {
  harnessConfig: string;
  nodeBin: string;
  statusScript: string;
  hermesBin: string;
  hermesProfile: string;
  target: "telegram";
  observerState: string;
  controllerLog: string;
  pollMs: number;
  heartbeatTimeoutMs: number;
};

type ObserverConfig = ObserverConfigFile & { harnessStateDir: string };

type OutboxEntry = {
  key: string;
  message: string;
  attempts: number;
  nextAttemptAt: number;
};

type ObserverState = {
  version: 1;
  initialized: boolean;
  ledgerInitialized: boolean;
  ledgerHealthy: boolean;
  logInitialized: boolean;
  logHealthy: boolean;
  controllerDown: boolean;
  controllerDownLogMtimeMs: number;
  controllerLogOffset: number;
  lastControllerAlertKey: string | null;
  lastJobId: string | null;
  lastJobRevision: number | null;
  lastJobState: JobState | null;
  lastIncidentId: string | null;
  lastAnalysisId: string | null;
  terminalCount: number;
  outbox: OutboxEntry[];
};

async function main(argv: string[]): Promise<number> {
  if (argv[2] !== "run") throw new Error("usage: hermes-observer run --config /absolute/bridge.json [--once]");
  const config = loadConfig(requiredFlag(argv, "--config"));
  const once = argv.includes("--once");

  for (;;) {
    await cycle(config);
    if (once) return 0;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.pollMs);
  }
}

async function cycle(config: ObserverConfig): Promise<void> {
  const state = loadState(config.observerState);
  flushOutbox(config, state);
  if (!state.initialized) {
    state.initialized = true;
    enqueue(state, "observer-online", [
      "✅ Herdr Harness Telegram Observer 已上线",
      "模式：仅通知；不能审批、不能恢复、不能修改 Harness ledger。",
      safeView(config, "status"),
    ].join("\n"));
  }

  await observeLedger(config, state);
  observeControllerLog(config, state);
  observeHeartbeat(config, state);
  saveState(config.observerState, state);
  flushOutbox(config, state);
}

async function observeLedger(config: ObserverConfig, observer: ObserverState): Promise<void> {
  let ledger: HarnessState;
  try {
    ledger = await new JsonStateStore(config.harnessStateDir).load();
  } catch (error) {
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
      enqueue(observer, `analysis:${ledger.activeJob.analysis.id}`, `🧭 当前任务已有 Analyst 恢复建议\n${safeView(config, "incident")}`);
    } else if (ledger.activeJob?.incident) {
      enqueue(observer, `incident:${ledger.activeJob.incident.id}`, `⛔️ 当前 Harness 任务已阻塞\n${safeView(config, "incident")}`);
    }
    return;
  }

  const oldTerminalCount = observer.terminalCount;
  if (ledger.terminalJobs.length < oldTerminalCount) {
    enqueue(observer, `terminal-history-shrank:${ledger.terminalJobs.length}`, "⚠️ Harness terminal history 数量倒退；Observer 已重新建立只读基线。请人工核对 ledger。");
  } else {
    for (const terminal of ledger.terminalJobs.slice(oldTerminalCount)) {
      enqueue(
        observer,
        `terminal:${terminal.id}:${terminal.state}`,
        `${terminal.state === "done" ? "✅" : "⛔️"} 任务${terminal.state === "done" ? "完成" : "取消"}：${clean(terminal.repo, 160)}#${terminal.issueNumber}\n完成时间：${clean(terminal.finishedAt, 80)}`,
      );
    }
  }

  const job = ledger.activeJob;
  const jobChanged = job?.id !== observer.lastJobId;
  if (job && jobChanged) {
    enqueue(observer, `job:${job.id}`, `🆕 Harness 已领取新任务\n${safeView(config, "status")}`);
    if (job.analysis) {
      enqueue(observer, `analysis:${job.analysis.id}`, `🧭 Analyst 已给出恢复建议\n${safeView(config, "incident")}`);
    } else if (job.incident) {
      enqueue(observer, `incident:${job.incident.id}`, `⛔️ Harness 任务已阻塞\n${safeView(config, "incident")}`);
    }
  } else if (job) {
    observeJob(config, observer, job);
  } else if (observer.lastJobId && ledger.terminalJobs.length === oldTerminalCount) {
    enqueue(observer, `active-job-disappeared:${observer.lastJobId}`, "⚠️ 活跃任务从 ledger 消失且没有新增终态记录；请人工核对。");
  }

  baselineLedger(observer, ledger);
}

function observeJob(config: ObserverConfig, observer: ObserverState, job: Job): void {
  if (observer.lastJobRevision !== null && job.revision < observer.lastJobRevision) {
    enqueue(observer, `revision-regressed:${job.id}:${job.revision}`, `⚠️ Harness revision 从 ${observer.lastJobRevision} 倒退到 ${job.revision}；请人工核对 ledger。`);
  }

  const incidentChanged = job.incident?.id !== (observer.lastIncidentId ?? undefined);
  const analysisChanged = job.analysis?.id !== (observer.lastAnalysisId ?? undefined);
  if (job.analysis && analysisChanged) {
    enqueue(observer, `analysis:${job.analysis.id}`, `🧭 Analyst 已给出恢复建议\n${safeView(config, "incident")}`);
  } else if (job.incident && incidentChanged) {
    enqueue(observer, `incident:${job.incident.id}`, `⛔️ Harness 任务已阻塞\n${safeView(config, "incident")}`);
  }

  if (job.state === observer.lastJobState) return;
  const heading = transitionHeading(observer.lastJobState, job.state);
  if (heading) enqueue(observer, `state:${job.id}:${job.revision}:${job.state}`, `${heading}\n${safeView(config, "status")}`);
}

function transitionHeading(previous: JobState | null, next: JobState): string | null {
  if (next === "reviewer_ready") return "🧪 Worker 已完成，准备启动独立 Reviewer";
  if (next === "worker_ready" && previous === "reviewer_running") return "🔁 Reviewer 要求返工，准备启动全新 Worker";
  if (next === "publish_ready") return "✅ 独立 Reviewer 已通过，任务可发布";
  if (next === "awaiting_merge") return "📬 PR 已发布，正在等待 required checks / auto-merge";
  if (next === "recovery_approved") return "👍 Harness 已记录人工恢复批准，等待 Controller 消费";
  return null;
}

function baselineLedger(observer: ObserverState, ledger: HarnessState): void {
  const job = ledger.activeJob;
  observer.lastJobId = job?.id ?? null;
  observer.lastJobRevision = job?.revision ?? null;
  observer.lastJobState = job?.state ?? null;
  observer.lastIncidentId = job?.incident?.id ?? null;
  observer.lastAnalysisId = job?.analysis?.id ?? null;
  observer.terminalCount = ledger.terminalJobs.length;
}

function observeControllerLog(config: ObserverConfig, observer: ObserverState): void {
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
    if (!observer.logHealthy) enqueue(observer, "controller-log-restored", "✅ Controller 日志读取已恢复。");
    observer.logHealthy = true;
    if (stat.size < observer.controllerLogOffset) {
      observer.controllerLogOffset = stat.size;
      enqueue(observer, `controller-log-reset:${stat.size}`, "⚠️ Controller 日志被截断或轮转；Observer 已从当前文件末尾重新建立基线。");
      return;
    }
    if (stat.size === observer.controllerLogOffset) return;

    const text = readLogChunk(config.controllerLog, observer.controllerLogOffset, stat.size);
    const newline = text.lastIndexOf("\n");
    if (newline < 0) return;
    const complete = text.slice(0, newline + 1);
    const startingOffset = observer.controllerLogOffset;
    observer.controllerLogOffset += Buffer.byteLength(complete, "utf8");
    complete.split("\n").forEach((line, index) => {
      if (line.trim()) observeControllerEvent(config, observer, line, `${startingOffset}:${index}`);
    });
  } catch (error) {
    if (observer.logHealthy) {
      enqueue(observer, "controller-log-unavailable", `⚠️ Observer 无法读取 Controller 日志\n${clean(message(error), 700)}\n未执行任何恢复动作。`);
    }
    observer.logHealthy = false;
  }
}

function readLogChunk(path: string, offset: number, size: number): string {
  const length = Math.min(size - offset, LOG_CHUNK_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    const bytes = readSync(fd, buffer, 0, length, offset);
    return buffer.toString("utf8", 0, bytes);
  } finally {
    closeSync(fd);
  }
}

function observeControllerEvent(config: ObserverConfig, observer: ObserverState, line: string, position: string): void {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return;
  }
  if (!value || typeof value !== "object") return;
  const event = value as { ok?: unknown; action?: unknown; jobId?: unknown; message?: unknown };
  if (event.ok === true) {
    observer.lastControllerAlertKey = null;
    return;
  }
  if (event.ok !== false || typeof event.action !== "string" || typeof event.message !== "string" || event.action === "blocked") return;

  const alertKey = `${event.action}\u0000${typeof event.jobId === "string" ? event.jobId : ""}\u0000${event.message}`;
  if (alertKey === observer.lastControllerAlertKey) return;
  observer.lastControllerAlertKey = alertKey;
  enqueue(observer, `controller:${position}:${clean(event.action, 80)}`, [
    `⚠️ Controller 推进失败 · ${clean(event.action, 80)}`,
    clean(event.message, 700),
    safeView(config, "status"),
    "Observer 未执行自动恢复。",
  ].join("\n"));

  if (event.action === "preflight_failed") {
    observer.controllerDown = true;
    observer.controllerDownLogMtimeMs = safeLogMtime(config.controllerLog);
  }
}

function observeHeartbeat(config: ObserverConfig, observer: ObserverState): void {
  const mtime = safeLogMtime(config.controllerLog);
  const stale = mtime === 0 || Date.now() - mtime > config.heartbeatTimeoutMs;
  if (stale && !observer.controllerDown) {
    observer.controllerDown = true;
    observer.controllerDownLogMtimeMs = mtime;
    enqueue(observer, `controller-heartbeat-stopped:${mtime}`, "⏹️ Harness Controller 心跳已停止\nObserver 只负责通知，不会自动重启 Controller。");
  } else if (!stale && observer.controllerDown && mtime > observer.controllerDownLogMtimeMs) {
    observer.controllerDown = false;
    observer.controllerDownLogMtimeMs = 0;
    enqueue(observer, `controller-heartbeat-restored:${mtime}`, `✅ Harness Controller 心跳已恢复\n${safeView(config, "status")}`);
  }
}

function safeLogMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function safeView(config: ObserverConfig, command: "status" | "incident"): string {
  const output = spawnSync(config.nodeBin, [config.statusScript, command, "--config", config.harnessConfig], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (output.status === 0 && output.stdout.trim()) return bounded(output.stdout.trim());
  return `详情读取失败：${clean(output.error?.message || output.stderr || `exit ${output.status}`, 700)}`;
}

function flushOutbox(config: ObserverConfig, state: ObserverState): void {
  for (;;) {
    const entry = state.outbox.find((candidate) => candidate.nextAttemptAt <= Date.now());
    if (!entry) return;
    const sent = spawnSync(config.hermesBin, [
      "--profile",
      config.hermesProfile,
      "send",
      "--to",
      config.target,
      "--quiet",
      entry.message,
    ], { encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 });

    if (sent.status === 0) {
      state.outbox = state.outbox.filter((candidate) => candidate !== entry);
      saveState(config.observerState, state);
      process.stdout.write(`${JSON.stringify({ ok: true, action: "notification_sent", key: entry.key })}\n`);
      continue;
    }

    entry.attempts += 1;
    entry.nextAttemptAt = Date.now() + RETRY_DELAYS_MS[Math.min(entry.attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
    saveState(config.observerState, state);
    process.stderr.write(`${JSON.stringify({ ok: false, action: "notification_retry", key: entry.key, attempts: entry.attempts, error: clean(sent.error?.message || sent.stderr || `exit ${sent.status}`, 700) })}\n`);
    return;
  }
}

function enqueue(state: ObserverState, key: string, messageText: string): void {
  if (state.outbox.some((entry) => entry.key === key)) return;
  if (state.outbox.length >= MAX_OUTBOX) throw new Error(`observer outbox reached ${MAX_OUTBOX} entries`);
  state.outbox.push({ key, message: bounded(messageText.trim()), attempts: 0, nextAttemptAt: 0 });
}

function loadConfig(path: string): ObserverConfig {
  assertSecureAbsoluteFile(path, "bridge config");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ObserverConfigFile>;
  const paths = ["harnessConfig", "nodeBin", "statusScript", "hermesBin", "observerState", "controllerLog"] as const;
  for (const name of paths) {
    if (!parsed[name] || !isAbsolute(parsed[name])) throw new Error(`${name} must be an absolute path`);
  }
  if (!parsed.hermesProfile || !/^[A-Za-z0-9._-]+$/.test(parsed.hermesProfile) || parsed.target !== "telegram") {
    throw new Error("a safe hermesProfile and target=telegram are required");
  }
  if (!Number.isInteger(parsed.pollMs) || parsed.pollMs! < 1_000) throw new Error("pollMs must be an integer of at least 1000");
  if (!Number.isInteger(parsed.heartbeatTimeoutMs) || parsed.heartbeatTimeoutMs! < parsed.pollMs! * 3) {
    throw new Error("heartbeatTimeoutMs must be an integer of at least 3 * pollMs");
  }

  const file = parsed as ObserverConfigFile;
  const harness = JSON.parse(readFileSync(file.harnessConfig, "utf8")) as { stateDir?: unknown };
  if (typeof harness.stateDir !== "string" || !isAbsolute(harness.stateDir)) throw new Error("Harness config stateDir must be absolute");
  if (!existsSync(harness.stateDir)) throw new Error("Harness stateDir does not exist");
  return { ...file, harnessStateDir: harness.stateDir };
}

function assertSecureAbsoluteFile(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error(`${label} must not be a symlink or group/other writable`);
}

function loadState(path: string): ObserverState {
  if (!existsSync(path)) return emptyState();
  assertSecureAbsoluteFile(path, "observer state");
  const value = JSON.parse(readFileSync(path, "utf8")) as ObserverState;
  if (
    value.version !== 1
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
    || value.outbox.some((entry) => !entry || typeof entry.key !== "string" || typeof entry.message !== "string" || !Number.isInteger(entry.attempts) || !Number.isFinite(entry.nextAttemptAt))
  ) {
    throw new Error("invalid observer state");
  }
  return value;
}

function emptyState(): ObserverState {
  return {
    version: 1,
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

function saveState(path: string, state: ObserverState): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temp = join(directory, ".state.json.tmp");
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function requiredFlag(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function bounded(value: string): string {
  return value.length <= MAX_MESSAGE_LENGTH ? value : `${value.slice(0, MAX_MESSAGE_LENGTH - 20)}\n…内容已截断`;
}

function clean(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function message(error: unknown): string {
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
