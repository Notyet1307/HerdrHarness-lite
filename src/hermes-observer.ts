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
import { type AutomaticRecovery, type HarnessState, type Job, type JobState } from "./model.js";
import { isControllerAnalystFailure, operatorActionsFor } from "./policy.js";
import { controllerHeartbeatPath } from "./controller-heartbeat.js";
import { formatSafePiRpcDiagnostic } from "./pi-rpc-diagnostics.js";

const MAX_MESSAGE_LENGTH = 3_900;
const MAX_OUTBOX = 512;
const LOG_CHUNK_BYTES = 1024 * 1024;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];
const TIMELINE_TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

type ObserverConfigFile = {
  harnessConfig: string;
  nodeBin: string;
  statusScript: string;
  approvalScript: string;
  deliveryCommand?: string[];
  hermesBin?: string;
  hermesProfile?: string;
  target?: "telegram";
  observerState: string;
  controllerLog: string;
  pollMs: number;
  heartbeatTimeoutMs: number;
};

type ObserverConfig = Omit<ObserverConfigFile, "deliveryCommand"> & {
  deliveryCommand: string[] | null;
  bridgeConfig: string;
  harnessStateDir: string;
  controllerHeartbeat: string;
};

type TextOutboxEntry = {
  kind: "text";
  key: string;
  message: string;
  attempts: number;
  nextAttemptAt: number;
};

type ApprovalOutboxEntry = {
  kind: "approval";
  key: string;
  analysisId: string;
  attempts: number;
  nextAttemptAt: number;
};

type CardOutboxEntry = {
  kind: "card";
  key: string;
  message: string;
  attempts: number;
  nextAttemptAt: number;
};

type OutboxEntry = TextOutboxEntry | CardOutboxEntry | ApprovalOutboxEntry;

type ObserverState = {
  version: 2;
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
  lastAutomaticRecoveryCount: number;
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
  await flushOutbox(config, state);
  if (!state.initialized) {
    state.initialized = true;
    enqueue(state, "observer-online", [
      "🟢 Observer 已上线 · 无需处理",
      "只推送任务开始、终态和需要关注的异常；低风险恢复可按精确策略自动一次，其余仍需人工批准。",
    ].join("\n"));
  }

  await observeLedger(config, state);
  observeControllerLog(config, state);
  observeHeartbeat(config, state);
  saveState(config.observerState, state);
  await flushOutbox(config, state);
}

async function observeLedger(config: ObserverConfig, observer: ObserverState): Promise<void> {
  let ledger: HarnessState;
  try {
    ledger = await new JsonStateStore(config.harnessStateDir).load();
  } catch (error) {
    if (observer.ledgerHealthy) {
      enqueue(observer, "ledger-unavailable", `🚨 自动化异常 · 需要检查\nHarness ledger 无法读取：${clean(message(error), 700)}\n未执行任何恢复动作。`);
    }
    observer.ledgerHealthy = false;
    return;
  }

  if (!observer.ledgerHealthy && observer.ledgerInitialized) {
    enqueue(observer, "ledger-restored", "✅ 自动化已恢复 · 无需处理\nHarness ledger 已可读取。");
  }
  observer.ledgerHealthy = true;
  if (!observer.ledgerInitialized) {
    observer.ledgerInitialized = true;
    baselineLedger(observer, ledger);
    const automaticRecovery = ledger.activeJob ? enqueueCurrentAutomaticRecovery(observer, ledger.activeJob) : false;
    if (!automaticRecovery) {
      if (ledger.activeJob?.analysis) {
        enqueueAnalysis(config, observer, ledger.activeJob, "🧭 当前任务已有 Analyst 恢复建议");
      } else if (ledger.activeJob?.incident) {
        enqueue(observer, `incident:${ledger.activeJob.incident.id}`, safeView(config, "notification"));
      }
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
        `${terminal.state === "done" ? "✅ 任务已完成" : "⛔️ 任务已取消"} · 无需处理\n${clean(terminal.repo, 160)}#${terminal.issueNumber}`,
      );
    }
  }

  const job = ledger.activeJob;
  const jobChanged = job?.id !== observer.lastJobId;
  if (job && jobChanged) {
    enqueue(
      observer,
      `job:${job.id}`,
      `🚀 任务已开始 · 无需处理\n${clean(job.task.repo, 160)}#${job.task.issueNumber} · ${clean(job.task.title, 240)}`,
    );
    const automaticRecovery = enqueueCurrentAutomaticRecovery(observer, job);
    if (!automaticRecovery) {
      if (job.analysis) {
        enqueueAnalysis(config, observer, job, "🧭 Analyst 已给出恢复建议");
      } else if (job.incident) {
        enqueue(observer, `incident:${job.incident.id}`, safeView(config, "notification"));
      }
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
  const automaticRecoveryChanged = enqueueAutomaticRecoveries(observer, job, observer.lastAutomaticRecoveryCount);
  if (job.analysis && analysisChanged && !automaticRecoveryChanged) {
    enqueueAnalysis(config, observer, job, "🧭 Analyst 已给出恢复建议");
  } else if (job.incident && incidentChanged && !automaticRecoveryChanged) {
    enqueue(observer, `incident:${job.incident.id}`, safeView(config, "notification"));
  }
}

function baselineLedger(observer: ObserverState, ledger: HarnessState): void {
  const job = ledger.activeJob;
  observer.lastJobId = job?.id ?? null;
  observer.lastJobRevision = job?.revision ?? null;
  observer.lastJobState = job?.state ?? null;
  observer.lastIncidentId = job?.incident?.id ?? null;
  observer.lastAnalysisId = job?.analysis?.id ?? null;
  observer.lastAutomaticRecoveryCount = job?.automaticRecoveries?.length ?? 0;
  observer.terminalCount = ledger.terminalJobs.length;
}

function enqueueAutomaticRecoveries(observer: ObserverState, job: Job, offset: number): boolean {
  const recoveries = job.automaticRecoveries ?? [];
  if (recoveries.length <= offset) return false;
  for (const recovery of recoveries.slice(offset)) {
    enqueue(observer, `auto-recovery:${recovery.id}`, automaticRecoveryNotice(job, recovery));
  }
  return true;
}

function enqueueCurrentAutomaticRecovery(observer: ObserverState, job: Job): boolean {
  const recovery = job.state === "recovery_approved" && job.approval?.basis === "policy_rule"
    ? (job.automaticRecoveries ?? []).find((entry) => entry.id === job.approval!.id)
    : undefined;
  if (!recovery) return false;
  enqueue(observer, `auto-recovery:${recovery.id}`, automaticRecoveryNotice(job, recovery));
  return true;
}

function automaticRecoveryNotice(job: Job, recovery: AutomaticRecovery): string {
  const lane = recovery.action === "retry_fresh_reviewer" ? "Reviewer" : "Worker";
  const reason = recovery.policyRule === "reviewer_same_head_infrastructure"
    ? "Reviewer 基础设施失败；实现 HEAD 未变化。"
    : "Worker 在 prompt dispatch 前发生基础设施失败。";
  return [
    "♻️ 自动恢复已授权 · 无需处理",
    `任务：${clean(job.task.repo, 160)}#${job.task.issueNumber} · ${clean(job.task.title, 240)}`,
    `动作：启动全新 ${lane}`,
    `原因：${reason}`,
    `旧 Attempt：${clean(recovery.attemptId, 160)}`,
    `规则：${recovery.policyRule} · fingerprint ${recovery.fingerprint.slice(0, 12)}`,
    "限制：该故障指纹的自动额度已用尽；再次发生将转为人工批准。",
  ].join("\n");
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
    if (!observer.logHealthy) enqueue(observer, "controller-log-restored", "✅ 自动化已恢复 · 无需处理\nController 日志已可读取。");
    observer.logHealthy = true;
    if (stat.size < observer.controllerLogOffset) {
      observer.controllerLogOffset = stat.size;
      enqueue(observer, `controller-log-reset:${stat.size}`, "⚠️ 自动化记录异常 · 需要检查\nController 日志被截断或轮转；Observer 已重新建立基线。");
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
      enqueue(observer, "controller-log-unavailable", `🚨 自动化异常 · 需要检查\nController 日志无法读取：${clean(message(error), 700)}\n未执行任何恢复动作。`);
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
  if (event.action === "preflight_failed") {
    enqueue(observer, `controller:${position}:preflight_failed`, [
      "⚠️ 运行环境暂不可用 · 将自动重试",
      "Controller preflight 暂未通过：",
      clean(event.message, 700),
      "安全门禁仍生效，未启动新的 Agent；常驻 Controller 将在下个轮询周期重试。",
      "无需手动重启；发送 /harness 可查看当前状态。",
    ].join("\n"));
    return;
  }
  enqueue(observer, `controller:${position}:${clean(event.action, 80)}`, [
    "🚨 自动化异常 · 需要检查",
    `Controller 推进失败：${clean(event.action, 80)}`,
    clean(event.message, 700),
    "未执行自动恢复；发送 /harness 查看当前状态。",
  ].join("\n"));
}

function observeHeartbeat(config: ObserverConfig, observer: ObserverState): void {
  const mtime = safeLogMtime(config.controllerHeartbeat);
  const stale = mtime === 0 || Date.now() - mtime > config.heartbeatTimeoutMs;
  if (stale && !observer.controllerDown) {
    observer.controllerDown = true;
    observer.controllerDownLogMtimeMs = mtime;
    enqueue(observer, `controller-heartbeat-stopped:${mtime}`, "🚨 自动化停止 · 需要检查\nHarness Controller 心跳已停止；Observer 不会自动重启。");
  } else if (!stale && observer.controllerDown && mtime > observer.controllerDownLogMtimeMs) {
    observer.controllerDown = false;
    observer.controllerDownLogMtimeMs = 0;
    enqueue(observer, `controller-heartbeat-restored:${mtime}`, "✅ 自动化已恢复 · 无需处理\nHarness Controller 心跳已恢复。");
  }
}

function safeLogMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function safeView(config: ObserverConfig, command: "status" | "incident" | "notification"): string {
  const output = spawnSync(config.nodeBin, [config.statusScript, command, "--config", config.bridgeConfig], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (output.status === 0 && output.stdout.trim()) return bounded(output.stdout.trim());
  return `详情读取失败：${clean(output.error?.message || output.stderr || `exit ${output.status}`, 700)}`;
}

async function flushOutbox(config: ObserverConfig, state: ObserverState): Promise<void> {
  for (;;) {
    const entry = state.outbox.find((candidate) => candidate.nextAttemptAt <= Date.now());
    if (!entry) return;
    let sent: ReturnType<typeof spawnSync>;
    if (entry.kind === "approval") {
      let ledger: HarnessState;
      try {
        ledger = await new JsonStateStore(config.harnessStateDir).load();
      } catch (error) {
        retryEntry(config, state, entry, message(error));
        return;
      }
      const job = ledger.activeJob;
      const option = job ? operatorActionsFor(job).find((candidate) => candidate.kind === "approve_retry") : null;
      if (
        job?.state !== "blocked"
        || job.analysis?.id !== entry.analysisId
        || job.analysis.incidentId !== job.incident?.id
        || option?.effect !== job.analysis.action
      ) {
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
      } else if (!card) {
        retryEntry(config, state, entry, "approval script returned an invalid card payload");
        return;
      } else {
        sent = sendCard(config, card);
      }
    } else if (entry.kind === "card") {
      sent = sendCard(config, { text: entry.message });
    } else if (config.deliveryCommand) {
      sent = sendCard(config, { text: entry.message, parseMode: "plain" });
    } else {
      sent = spawnSync(config.hermesBin!, [
        "--profile",
        config.hermesProfile!,
        "send",
        "--to",
        config.target!,
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

function sendCard(config: ObserverConfig, payload: unknown): ReturnType<typeof spawnSync> {
  const command = config.deliveryCommand ?? [config.hermesBin!, "--profile", config.hermesProfile!, "harness-card"];
  return spawnSync(command[0]!, command.slice(1), {
    encoding: "utf8",
    input: JSON.stringify(payload),
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
}

function retryEntry(config: ObserverConfig, state: ObserverState, entry: OutboxEntry, error: string): void {
  entry.attempts += 1;
  entry.nextAttemptAt = Date.now() + RETRY_DELAYS_MS[Math.min(entry.attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
  saveState(config.observerState, state);
  process.stderr.write(`${JSON.stringify({ ok: false, action: "notification_retry", key: entry.key, attempts: entry.attempts, error: clean(error, 700) })}\n`);
}

function enqueue(state: ObserverState, key: string, messageText: string): void {
  if (state.outbox.some((entry) => entry.key === key)) return;
  if (state.outbox.length >= MAX_OUTBOX) throw new Error(`observer outbox reached ${MAX_OUTBOX} entries`);
  state.outbox.push({ kind: "text", key, message: bounded(messageText.trim()), attempts: 0, nextAttemptAt: 0 });
}

function enqueueAnalysis(config: ObserverConfig, state: ObserverState, job: Job, heading: string): void {
  const analysis = job.analysis;
  const exactAnalysis = job.state === "blocked"
    && job.incident !== null
    && analysis?.incidentId === job.incident.id;
  const approvalOption = operatorActionsFor(job).find((option) => option.kind === "approve_retry");
  const exactRetry = exactAnalysis && approvalOption?.effect === analysis.action;
  if (!exactRetry) {
    if (exactAnalysis && analysis.action === "hold") {
      enqueueCard(state, `analysis:${analysis.id}`, analysisCard(job, heading));
    } else {
      enqueue(state, `analysis:${analysis?.id ?? job.revision}`, safeView(config, "notification"));
    }
    return;
  }
  const key = `approval:${analysis.id}`;
  if (state.outbox.some((entry) => entry.key === key)) return;
  if (state.outbox.length >= MAX_OUTBOX) throw new Error(`observer outbox reached ${MAX_OUTBOX} entries`);
  state.outbox.push({ kind: "approval", key, analysisId: analysis.id, attempts: 0, nextAttemptAt: 0 });
}

function enqueueCard(state: ObserverState, key: string, messageText: string): void {
  if (state.outbox.some((entry) => entry.key === key)) return;
  if (state.outbox.length >= MAX_OUTBOX) throw new Error(`observer outbox reached ${MAX_OUTBOX} entries`);
  state.outbox.push({ kind: "card", key, message: messageText, attempts: 0, nextAttemptAt: 0 });
}

function analysisCard(job: Job, heading: string): string {
  const incident = job.incident!;
  const analysis = job.analysis!;
  const exhausted = analysis.summary === "Analyst evidence-gathering turns were exhausted"
    || analysis.summary.startsWith("自动诊断未完成：在允许的证据轮数内仍缺少关键证据");
  const analystFailed = isControllerAnalystFailure(analysis);
  const conclusion = exhausted
    ? "自动诊断未完成：在允许的证据轮数内仍缺少关键证据。"
    : analystFailed
      ? "Analyst 执行结果未通过 Harness 校验，未形成可批准的恢复建议。"
    : analysis.summary;
  const recommendation = exhausted && incident.class === "ci_failure"
    ? "保持暂停；补齐完整失败日志后重新诊断，不要直接批准或重跑。"
    : analystFailed
      ? "保持暂停；恢复 Analyst 后重新诊断，不要直接批准或重跑。"
    : "保持暂停；先处理未决信息，再按 Harness 策略重新诊断。";
  const rationale = exhausted
    ? "关键证据仍不足；继续 fail-closed 可避免在原因未明时启动恢复 agent。"
    : analystFailed
      ? "Analyst 输出未通过 Harness 校验；继续 fail-closed 可避免在没有有效诊断时启动恢复 agent。"
      : "现有 analysis 为 hold；继续 fail-closed 可避免在未决信息处理前启动恢复 agent。";
  const unknowns = exhausted
    ? "• 所需证据超出 Harness 本轮允许的收集范围"
    : analysis.unknowns.length === 0
      ? "无"
      : analysis.unknowns.slice(0, 3).map((value) => `• ${html(clean(value, 220), 180)}`).join("\n");
  return [
    `⚠️ <b>#${job.task.issueNumber} 已阻塞 · ${html(exhausted ? "自动诊断未完成" : analystFailed ? "Analyst 未形成有效建议" : heading, 100)}</b>`,
    `<code>${html(clean(job.task.repo, 160), 140)}</code> · ${html(clean(job.task.title, 180), 150)}`,
    "",
    `<b>结论：</b>${html(clean(conclusion, 420), 340)}`,
    `<b>原因：</b>${html(clean(incident.summary, 540), 440)}`,
    ...(incident.runtimeDiagnostic
      ? [`<b>运行诊断：</b><code>${html(clean(formatSafePiRpcDiagnostic(incident.runtimeDiagnostic), 540), 440)}</code>`]
      : []),
    "<b>影响：</b>自动流程保持暂停；Harness 未启动恢复 agent。",
    `<b>建议：</b>${html(recommendation, 300)}`,
    `<b>建议原因：</b>${html(rationale, 300)}`,
    "",
    "<blockquote expandable><b>展开时间线与证据（Controller 本机时间）</b>",
    ...holdTimeline(job),
    `HEAD：<code>${html(job.headSha?.slice(0, 12) ?? "尚无 HEAD", 40)}</code>`,
    `证据引用：${html(clean(analysis.evidenceRefs.join(", ") || "无", 300), 240)}`,
    `未决信息：${unknowns}`,
    `Incident：<code>${html(clean(incident.id, 80), 60)}</code> · revision <code>${job.revision}</code>`,
    "</blockquote>",
  ].join("\n");
}

function holdTimeline(job: Job): string[] {
  const events = [{ at: job.createdAt, text: "任务进入 Harness" }];
  if (job.ciFailure?.observedAt) events.push({ at: job.ciFailure.observedAt, text: "已观察到 GitHub 必需 CI 失败" });
  events.push(
    { at: job.incident!.createdAt, text: `Harness 记录 ${job.incident!.class} · ${job.incident!.lane}` },
    { at: job.analysis!.createdAt, text: "Analyst 未形成可批准的恢复建议；保持阻塞" },
  );
  return events
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .map(({ at, text }) => `<code>${html(localTime(at), 40)}</code> · ${html(text, 180)}`);
}

function localTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return clean(value, 40);
  const parts = Object.fromEntries(TIMELINE_TIME.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
}

function parseApprovalCard(output: string, analysisId: string): unknown | null {
  try {
    const value = JSON.parse(output) as {
      ok?: unknown;
      action?: unknown;
      analysisId?: unknown;
      card?: { text?: unknown; approveLabel?: unknown; approveCallback?: unknown; holdCallback?: unknown };
    };
    const card = value.card;
    if (
      value.ok !== true
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
      || !/^hh:h:(?:[a-z0-9][a-z0-9-]{0,31}:)?[0-9A-F]{16}$/.test(card.holdCallback)
    ) return null;
    return card;
  } catch {
    return null;
  }
}

function loadConfig(path: string): ObserverConfig {
  assertSecureAbsoluteFile(path, "bridge config");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ObserverConfigFile>;
  const paths = ["harnessConfig", "nodeBin", "statusScript", "approvalScript", "observerState", "controllerLog"] as const;
  for (const name of paths) {
    if (!parsed[name] || !isAbsolute(parsed[name])) throw new Error(`${name} must be an absolute path`);
  }
  const deliveryCommand = parseDeliveryCommand(parsed.deliveryCommand);
  if (!deliveryCommand && (
    !parsed.hermesBin
    || !isAbsolute(parsed.hermesBin)
    || !parsed.hermesProfile
    || !/^[A-Za-z0-9._-]+$/.test(parsed.hermesProfile)
    || parsed.target !== "telegram"
  )) {
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
  return {
    ...file,
    deliveryCommand,
    bridgeConfig: path,
    harnessStateDir: harness.stateDir,
    controllerHeartbeat: controllerHeartbeatPath(harness.stateDir),
  };
}

function parseDeliveryCommand(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > 16
    || value.some((part) => typeof part !== "string" || !part || part.includes("\0"))
    || !isAbsolute(value[0]!)
  ) {
    throw new Error("deliveryCommand must be an absolute executable plus at most 15 arguments");
  }
  if (!existsSync(value[0]!)) throw new Error("deliveryCommand executable does not exist");
  return value;
}

function assertSecureAbsoluteFile(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error(`${label} must not be a symlink or group/other writable`);
}

function loadState(path: string): ObserverState {
  if (!existsSync(path)) return emptyState();
  assertSecureAbsoluteFile(path, "observer state");
  const raw = JSON.parse(readFileSync(path, "utf8")) as ObserverState | (Omit<ObserverState, "version" | "outbox"> & {
    version: 1;
    outbox: Array<{ key: string; message: string; attempts: number; nextAttemptAt: number }>;
  });
  const migrated = raw.version === 1
    ? { ...raw, version: 2 as const, outbox: raw.outbox.map((entry) => ({ kind: "text" as const, ...entry })) }
    : raw;
  const value: ObserverState = {
    ...migrated,
    lastAutomaticRecoveryCount: Number.isInteger((migrated as Partial<ObserverState>).lastAutomaticRecoveryCount)
      ? (migrated as Partial<ObserverState>).lastAutomaticRecoveryCount!
      : 0,
  };
  if (
    value.version !== 2
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
    || !Number.isInteger(value.lastAutomaticRecoveryCount)
    || value.lastAutomaticRecoveryCount < 0
    || !Array.isArray(value.outbox)
    || value.outbox.some((entry) => !entry
      || typeof entry.key !== "string"
      || !Number.isInteger(entry.attempts)
      || !Number.isFinite(entry.nextAttemptAt)
      || (entry.kind === "text" || entry.kind === "card"
        ? typeof entry.message !== "string"
        : entry.kind !== "approval" || typeof entry.analysisId !== "string"))
  ) {
    throw new Error("invalid observer state");
  }
  return value;
}

function emptyState(): ObserverState {
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
    lastAutomaticRecoveryCount: 0,
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

function html(value: string, max: number): string {
  let output = "";
  for (const char of value) {
    const escaped = char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char;
    if (output.length + escaped.length > max) break;
    output += escaped;
  }
  return output;
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
