#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { JsonStateStore } from "./adapters/json-store.js";
import { isRetryAction, type Job } from "./model.js";
import { allowedActionsFor } from "./policy.js";

const CHALLENGE_TTL_MS = 10 * 60 * 1_000;
const MAX_STDIN_BYTES = 1_024;
const LANE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TIMELINE_TIME = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

type ApprovalAction = "retry_fresh_worker" | "retry_fresh_reviewer";

type ApprovalConfigFile = {
  laneId?: string;
  harnessConfig: string;
  nodeBin: string;
  harnessCliScript: string;
  approvalState: string;
  telegramAllowedUser: string;
};

type ApprovalConfig = ApprovalConfigFile & { harnessStateDir: string };

type Challenge = {
  version: 2;
  tokenDigest: string;
  jobId: string;
  revision: number;
  repo: string;
  issueNumber: number;
  incidentId: string;
  analysisId: string;
  action: ApprovalAction;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  decision: "approved" | "held" | null;
  actor: string | null;
};

class ApprovalCommandError extends Error {
  constructor(readonly code: string, message: string, readonly terminal: boolean) {
    super(message);
  }
}

async function main(argv: string[]): Promise<number> {
  const command = argv[2];
  if (command !== "request" && command !== "confirm" && command !== "hold") {
    throw new Error("usage: hermes-approval request|confirm|hold --config /absolute/bridge.json [--json]");
  }
  const config = loadConfig(requiredFlag(argv, "--config"));
  const json = argv.includes("--json");
  if (command === "request") return requestChallenge(config, json);
  return decideChallenge(config, command, json);
}

async function requestChallenge(config: ApprovalConfig, json: boolean): Promise<number> {
  const ledger = await new JsonStateStore(config.harnessStateDir).load();
  const job = ledger.activeJob;
  if (!job) throw new Error("当前没有活跃任务");
  if (job.state !== "blocked" || !job.incident) throw new Error("当前任务不在等待恢复批准");
  if (!job.analysis || job.analysis.incidentId !== job.incident.id) throw new Error("当前 incident 尚无精确绑定的 Analyst 建议");
  if (!isRetryAction(job.analysis.action)) throw new Error("Analyst 没有建议 fresh retry，不能批准");
  if (
    !job.incident.allowedActions.includes(job.analysis.action)
    || !allowedActionsFor(job.incident.class, job.incident.lane).includes(job.analysis.action)
  ) {
    throw new Error("当前 incident policy 不允许 Analyst 建议的恢复动作");
  }

  const token = randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase();
  const createdAt = new Date();
  const challenge: Challenge = {
    version: 2,
    tokenDigest: digestToken(token),
    jobId: job.id,
    revision: job.revision,
    repo: job.task.repo,
    issueNumber: job.task.issueNumber,
    incidentId: job.incident.id,
    analysisId: job.analysis.id,
    action: job.analysis.action,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + CHALLENGE_TTL_MS).toISOString(),
    consumedAt: null,
    decision: null,
    actor: null,
  };
  saveChallenge(config.approvalState, challenge);

  const humanMessage = [
    "⚠️ 待批准 Harness fresh retry",
    `任务：${clean(job.task.repo, 160)}#${job.task.issueNumber}`,
    `阻塞：${job.incident.class} · ${job.incident.lane}`,
    ...(job.headSha ? [`HEAD：${job.headSha.slice(0, 12)}`] : []),
    `动作：${actionLabel(challenge.action)}`,
    `revision：${job.revision}`,
    `Analyst：${clean(job.analysis.summary, 500)}`,
    `恢复说明：${clean(job.analysis.resolutionBrief, 700)}`,
    "有效期：10 分钟；新的挑战会使旧挑战失效。",
    `确认命令：${approvalCommand(config, token)}`,
    "不想批准就不要发送确认命令。",
  ].join("\n");
  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: "challenge_created",
      analysisId: challenge.analysisId,
      expiresAt: challenge.expiresAt,
      card: approvalCard(job, token, config.laneId),
    })}\n`);
  } else {
    process.stdout.write(`${humanMessage}\n`);
  }
  return 0;
}

async function decideChallenge(config: ApprovalConfig, decision: "confirm" | "hold", json: boolean): Promise<number> {
  const token = readToken();
  const challenge = loadChallenge(config.approvalState);
  if (
    challenge.consumedAt !== null
    || Date.parse(challenge.expiresAt) <= Date.now()
    || digestToken(token) !== challenge.tokenDigest
  ) {
    throw new ApprovalCommandError("challenge_invalid", `挑战码无效、已过期或已使用；请重新发送 ${approvalCommand(config)}`, true);
  }

  const store = new JsonStateStore(config.harnessStateDir);
  const before = await store.load();
  assertChallengeCurrent(before.activeJob, challenge, config);
  const actor = `telegram:${config.telegramAllowedUser}`;
  if (decision === "hold") {
    challenge.consumedAt = new Date().toISOString();
    challenge.decision = "held";
    challenge.actor = actor;
    saveChallenge(config.approvalState, challenge);
    const output = {
      ok: true,
      action: "held",
      message: `任务 ${clean(challenge.repo, 160)}#${challenge.issueNumber} 保持 blocked；未写入恢复批准。`,
    };
    process.stdout.write(json ? `${JSON.stringify(output)}\n` : `⏸️ ${output.message}\n`);
    return 0;
  }

  const reason = "Approved through a Telegram challenge bound to the exact job revision, incident, analysis, and retry action.";
  const approved = spawnSync(config.nodeBin, [
    config.harnessCliScript,
    "approve",
    "--config", config.harnessConfig,
    "--revision", String(challenge.revision),
    "--incident", challenge.incidentId,
    "--analysis", challenge.analysisId,
    "--actor", actor,
    "--reason", reason,
  ], { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (approved.status !== 0) {
    throw new ApprovalCommandError(
      "harness_rejected",
      `Harness 拒绝批准：${clean(approved.error?.message || approved.stderr || approved.stdout || `exit ${approved.status}`, 700)}`,
      false,
    );
  }

  const after = await store.load();
  const approval = after.activeJob?.approval;
  if (
    !approval
    || approval.jobRevision !== challenge.revision
    || approval.incidentId !== challenge.incidentId
    || approval.analysisId !== challenge.analysisId
    || approval.action !== challenge.action
    || approval.actor !== actor
  ) {
    throw new ApprovalCommandError("approval_mismatch", "Harness 命令返回成功，但 ledger 中没有精确匹配的 durable approval", true);
  }

  challenge.consumedAt = new Date().toISOString();
  challenge.decision = "approved";
  challenge.actor = actor;
  let auditWarning = "";
  try {
    saveChallenge(config.approvalState, challenge);
  } catch (error) {
    auditWarning = `\n⚠️ approval 已写入 ledger，但挑战状态落盘失败：${clean(message(error), 300)}`;
  }
  const humanMessage = [
    "✅ Harness 已记录精确恢复批准",
    `任务：${clean(challenge.repo, 160)}#${challenge.issueNumber}`,
    `动作：${actionLabel(challenge.action)}`,
    "Controller 会重新校验并只启动全新的 Worker/Reviewer。",
  ].join("\n") + auditWarning;
  process.stdout.write(json
    ? `${JSON.stringify({ ok: true, action: "approved", message: clean(humanMessage, 1_500) })}\n`
    : `${humanMessage}\n`);
  return 0;
}

function assertChallengeCurrent(job: Job | null, challenge: Challenge, config: ApprovalConfig): void {
  if (
    !job
    || job.id !== challenge.jobId
    || job.revision !== challenge.revision
    || job.state !== "blocked"
    || job.incident?.id !== challenge.incidentId
    || job.analysis?.id !== challenge.analysisId
    || job.analysis.incidentId !== job.incident.id
    || job.analysis.action !== challenge.action
  ) {
    throw new ApprovalCommandError("binding_stale", `任务、revision、incident 或 analysis 已变化；请重新发送 ${approvalCommand(config)}`, true);
  }
}

function approvalCard(job: Job, token: string, laneId?: string): { text: string; approveLabel: string; approveCallback: string; holdCallback: string } {
  const incident = job.incident!;
  const analysis = job.analysis!;
  if (!isRetryAction(analysis.action)) throw new Error("approval card requires a fresh retry action");
  const unknowns = analysis.unknowns.length === 0
    ? "无"
    : analysis.unknowns.slice(0, 3).map((value) => `• ${html(clean(value, 220), 140)}`).join("\n");
  const head = job.headSha ? job.headSha.slice(0, 12) : "尚无 HEAD";
  return {
    text: [
      `🚨 <b>#${job.task.issueNumber} 已阻塞 · 需要你决定</b>`,
      `<code>${html(clean(job.task.repo, 160), 140)}</code> · ${html(clean(job.task.title, 180), 150)}`,
      "",
      `<b>结论：</b>${html(clean(analysis.summary, 420), 340)}`,
      "<b>影响：</b>自动流程暂停；Harness 尚未启动恢复 agent。",
      `<b>建议：</b>${html(actionLabel(analysis.action), 100)}`,
      html(clean(analysis.resolutionBrief, 540), 440),
      "<b>建议原因：</b>这是与当前阻塞精确绑定、且符合 Harness 策略的恢复动作；批准后 Controller 仍会重新校验任务、HEAD 与全部绑定。",
      "",
      "⏱️ <b>10 分钟内有效</b>；新卡片会使旧卡片失效。",
      "",
      "<blockquote expandable><b>展开时间线与证据（Controller 本机时间）</b>",
      ...analysisTimeline(job),
      ...(laneId ? [`实例：<code>${html(laneId, 32)}</code>`] : []),
      `HEAD：<code>${html(head, 40)}</code>`,
      `原始阻塞：${html(clean(incident.summary, 600), 480)}`,
      `证据引用：${html(clean(analysis.evidenceRefs.join(", ") || "无", 300), 240)}`,
      `未决信息：${unknowns}`,
      `Incident：<code>${html(clean(incident.id, 80), 60)}</code> · revision <code>${job.revision}</code>`,
      "</blockquote>",
    ].join("\n"),
    approveLabel: analysis.action === "retry_fresh_worker"
      ? "批准：全新 Worker"
      : "批准：全新 Reviewer",
    approveCallback: `hh:a:${laneId ? `${laneId}:` : ""}${token}`,
    holdCallback: `hh:h:${laneId ? `${laneId}:` : ""}${token}`,
  };
}

function analysisTimeline(job: Job): string[] {
  const incident = job.incident!;
  const analysis = job.analysis!;
  if (!isRetryAction(analysis.action)) throw new Error("approval timeline requires a fresh retry action");
  const attempt = incident.attemptId === null
    ? null
    : job.attempts.find((candidate) => candidate.id === incident.attemptId)
      ?? (job.activeAttempt?.id === incident.attemptId ? job.activeAttempt : null);
  const events = [{ at: job.createdAt, text: "任务进入 Harness" }];
  if (attempt) {
    const lane = attempt.lane === "worker" ? "Worker" : "Reviewer";
    events.push({ at: attempt.startedAt, text: `${lane} 开始（第 ${attempt.round} 轮）` });
    if (attempt.completedAt) {
      events.push({
        at: attempt.completedAt,
        text: attempt.result
          ? `${lane} 结束；持久化结果状态：${attempt.result.status}`
          : `${lane} 结束；ledger 尚未收到持久化结果`,
      });
    }
  }
  if (job.ciFailure?.observedAt) {
    events.push({ at: job.ciFailure.observedAt, text: "已观察到 GitHub 必需 CI 失败" });
  }
  events.push(
    { at: incident.createdAt, text: `Harness 记录 ${incident.class} · ${incident.lane}` },
    { at: analysis.createdAt, text: `Analyst 建议：${actionLabel(analysis.action)}` },
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

function readToken(): string {
  const input = readFileSync(0, "utf8");
  if (input.length > MAX_STDIN_BYTES) throw new Error("确认输入过长");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw new Error("确认输入不是 JSON");
  }
  const token = typeof parsed === "object" && parsed !== null && "token" in parsed
    ? String((parsed as { token: unknown }).token).trim().toUpperCase()
    : "";
  if (!/^[0-9A-F]{16}$/.test(token)) throw new Error("挑战码格式无效");
  return token;
}

function loadConfig(path: string): ApprovalConfig {
  assertSecureAbsoluteFile(path, "bridge config");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ApprovalConfigFile>;
  for (const name of ["harnessConfig", "nodeBin", "harnessCliScript", "approvalState"] as const) {
    if (!parsed[name] || !isAbsolute(parsed[name])) throw new Error(`${name} must be an absolute path`);
  }
  if (!parsed.telegramAllowedUser || !/^[1-9][0-9]{2,19}$/.test(parsed.telegramAllowedUser)) {
    throw new Error("telegramAllowedUser must be one numeric Telegram user id");
  }
  if (parsed.laneId !== undefined && !LANE_ID.test(parsed.laneId)) {
    throw new Error("laneId must be 1-32 lowercase letters, digits, or hyphens");
  }
  const file = parsed as ApprovalConfigFile;
  const harness = JSON.parse(readFileSync(file.harnessConfig, "utf8")) as { stateDir?: unknown };
  if (typeof harness.stateDir !== "string" || !isAbsolute(harness.stateDir) || !existsSync(harness.stateDir)) {
    throw new Error("Harness config stateDir must be an existing absolute path");
  }
  return { ...file, harnessStateDir: harness.stateDir };
}

function approvalCommand(config: ApprovalConfig, token?: string): string {
  return `/harness${config.laneId ? ` ${config.laneId}` : ""} approve${token ? ` ${token}` : ""}`;
}

function loadChallenge(path: string): Challenge {
  assertSecureAbsoluteFile(path, "approval challenge");
  const value = JSON.parse(readFileSync(path, "utf8")) as Challenge;
  if (
    value.version !== 2
    || !/^[0-9a-f]{64}$/.test(value.tokenDigest)
    || !value.jobId?.trim()
    || !Number.isInteger(value.revision)
    || value.revision < 0
    || typeof value.repo !== "string"
    || !value.repo.trim()
    || !Number.isInteger(value.issueNumber)
    || value.issueNumber <= 0
    || !value.incidentId?.trim()
    || !value.analysisId?.trim()
    || !isRetryAction(value.action)
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isFinite(Date.parse(value.expiresAt))
    || (value.consumedAt !== null && !Number.isFinite(Date.parse(value.consumedAt)))
    || (value.decision !== null && value.decision !== "approved" && value.decision !== "held")
    || (value.actor !== null && !value.actor.trim())
    || ((value.decision === null) !== (value.consumedAt === null))
  ) {
    throw new Error("approval challenge state is invalid");
  }
  return value;
}

function saveChallenge(path: string, challenge: Challenge): void {
  if (existsSync(path)) assertSecureAbsoluteFile(path, "approval challenge");
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temp = join(directory, ".state.json.tmp");
  writeFileSync(temp, `${JSON.stringify(challenge, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function assertSecureAbsoluteFile(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error(`${label} must not be a symlink or group/other writable`);
}

function digestToken(token: string): string {
  const hash = createHash("sha256");
  hash.update(token);
  return hash.digest("hex");
}

function actionLabel(action: ApprovalAction): string {
  return action === "retry_fresh_worker" ? "启动全新 Worker" : "启动全新 Reviewer（保持当前 HEAD）";
}

function requiredFlag(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
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
    if (process.argv.includes("--json")) {
      const typed = error instanceof ApprovalCommandError ? error : null;
      process.stdout.write(`${JSON.stringify({
        ok: false,
        code: typed?.code ?? "command_failed",
        terminal: typed?.terminal ?? false,
        message: clean(message(error), 700),
      })}\n`);
    } else {
      process.stderr.write(`FAIL: ${message(error)}\n`);
    }
    process.exitCode = 1;
  });
