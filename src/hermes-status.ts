#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { JsonStateStore } from "./adapters/json-store.js";
import { MAX_CI_REWORKS, type AnalystAdvice, type HarnessState, type Job } from "./model.js";
import { projectOperatorState, type OperatorAction, type OperatorProjection } from "./policy.js";
import { formatSafePiRpcDiagnostic } from "./pi-rpc-diagnostics.js";
import { resolveReviewerProviderProfile } from "./reviewer-provider-profile.js";
import type { ReviewerProviderProfiles } from "./ports.js";

const MAX_MESSAGE_LENGTH = 3_500;
const LANE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DISPLAY_TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

type BridgeConfig = {
  harnessConfig: string;
  laneId?: string;
};

type HarnessStatusConfig = {
  repo: string;
  stateDir: string;
  workerArgv: string[];
  reviewerArgv: string[];
  reviewerProviderProfiles?: ReviewerProviderProfiles;
};

async function main(argv: string[]): Promise<number> {
  const command = argv[2] || "status";
  if (!["status", "incident", "why", "evidence", "actions", "summary", "notification"].includes(command)) {
    throw new Error("command must be status, incident, why, evidence, actions, summary, or notification");
  }
  const bridgePath = requiredFlag(argv, "--config");
  const bridge = loadBridgeConfig(bridgePath);
  const harness = loadHarnessConfig(bridge.harnessConfig);
  const state = await new JsonStateStore(harness.stateDir).load();
  const message = command === "status"
    ? renderStatus(state, harness)
    : command === "incident"
      ? renderIncident(state, bridge.laneId)
      : command === "why"
        ? renderWhy(state)
        : command === "evidence"
          ? renderEvidence(state)
          : command === "actions"
            ? renderActions(state, bridge.laneId)
      : command === "notification"
        ? renderNotification(state)
        : renderSummary(state, harness);
  process.stdout.write(`${bounded(message)}\n`);
  return 0;
}

function renderWhy(state: HarnessState): string {
  const job = state.activeJob;
  if (!job?.incident) return "当前没有可解释的 blocked incident。";
  const analysis = job.analysis?.incidentId === job.incident.id ? job.analysis : null;
  if (!analysis) return `当前 incident ${clean(job.incident.id, 160)} 尚无精确绑定的 durable analysis。`;
  const diagnosis = analysis.diagnosis;
  const lines = [
    "🧭 为什么卡住了",
    `${mobileTask(job)} · rev ${job.revision}`,
    "",
    "结论",
    clean(presentedAnalysisSummary(analysis), 260),
    "",
    `主要原因 · ${diagnosis?.confidence ?? "未结构化"}`,
    clean(diagnosis?.primaryCause ?? analysis.summary, 260),
  ];
  if (diagnosis?.hypotheses.length) {
    lines.push("", "关键依据", ...diagnosis.hypotheses.slice(0, 2).map((hypothesis) => (
      `• ${hypothesis.status} · ${clean(hypothesis.claim, 230)}`
    )), ...(diagnosis.hypotheses.length > 2 ? [`• …另 ${diagnosis.hypotheses.length - 2} 项见证据索引`] : []));
  }
  if (diagnosis?.preservationConstraints.length) {
    lines.push("", "必须保留", ...mobileBullets(diagnosis.preservationConstraints));
  }
  if (analysis.unknowns.length) lines.push("", "仍需确认", ...mobileBullets(analysis.unknowns));
  lines.push(
    "",
    "下一步",
    clean(analysis.resolutionBrief || "保持 blocked，等待新的精确 operator action。", 260),
    "发送 /harness_actions 查看当前允许的操作。",
  );
  return lines.join("\n");
}

function renderEvidence(state: HarnessState): string {
  const job = state.activeJob;
  if (!job?.incident) return "当前没有 blocked incident 的证据索引。";
  const analysis = job.analysis?.incidentId === job.incident.id ? job.analysis : null;
  if (!analysis) return "当前 incident 尚无精确绑定的 durable analysis。";
  return [
    "🔎 证据索引",
    `${mobileTask(job)} · rev ${job.revision}`,
    "",
    "绑定",
    `• Incident ${clean(job.incident.id, 120)}`,
    `• Analysis ${clean(analysis.id, 120)}`,
    `• Digest ${analysis.evidenceDigest}`,
    "",
    "证据引用",
    ...mobileBullets(analysis.evidenceRefs, 8, 128),
    ...(analysis.unknowns.length ? ["", "仍需确认", ...mobileBullets(analysis.unknowns)] : []),
  ].join("\n");
}

function renderActions(state: HarnessState, laneId?: string): string {
  const projection = projectOperatorState(state);
  if (!projection.jobId) return "当前没有活跃任务。";
  if (projection.actions.length === 0) return `当前 revision ${projection.revision} 没有可执行 operator action。`;
  const prefix = `/harness${laneId ? ` ${laneId}` : ""}`;
  return [
    "🎛️ 当前可操作",
    `${clean(projection.jobId, 100)} · rev ${projection.revision}`,
    "",
    ...projection.actions.flatMap((action, index) => [
      `${index + 1}. ${operatorActionLabel(action)}`,
      `   发送：${prefix} ${operatorActionCommand(action.kind)}`,
    ]),
    "",
    "安全校验",
    "命令先创建 10 分钟单次 challenge；确认时会重新核对 revision、incident、analysis、attempt 与 HEAD。",
  ].join("\n");
}

function operatorActionCommand(kind: OperatorAction["kind"]): string {
  if (kind === "approve_retry") return "retry";
  if (kind === "resolve_decision") return "resolve <reason>";
  if (kind === "reassess") return "reassess <reason>";
  return "cancel <reason>";
}

function renderStatus(state: HarnessState, config: HarnessStatusConfig): string {
  const job = state.activeJob;
  if (!job) {
    return [
      "🟢 Harness · IDLE",
      clean(config.repo, 180),
      "",
      "概况",
      "• 状态：空闲（ledger 无活跃任务）",
      `• 历史终态任务：${state.terminalJobs.length}`,
      "",
      "下一步",
      "是否继续领取由正在运行的 Controller 和 GitHub eligibility 决定。",
    ].join("\n");
  }

  const projection = projectOperatorState(state);
  const lines = [
    `${stateIcon(job.state)} Harness · ${job.state.toUpperCase()}`,
    `${mobileTask(job)} · rev ${job.revision}`,
    clean(job.task.title, 180),
    "",
    "进度",
    `• Review ${job.reviewRound}/${job.maxReviewRounds}`,
    `• CI rework ${job.ciReworkCount ?? 0}/${MAX_CI_REWORKS}`,
  ];
  if (job.activeAttempt) {
    lines.push(`• 当前：${job.activeAttempt.lane} · ${job.activeAttempt.phase} · round ${job.activeAttempt.round}`);
  }
  if (job.headSha) lines.push(`• HEAD ${shortSha(job.headSha)}`);
  if (job.pullRequest) lines.push(`• PR #${job.pullRequest.number} ${clean(job.pullRequest.url, 220)}`);
  lines.push(
    "",
    "运行信息",
    `• Worker：${clean(runtimeSelection(config.workerArgv), 230)}`,
    `• Reviewer：${clean(runtimeSelection(resolveReviewerProviderProfile(config.reviewerArgv, config.reviewerProviderProfiles).argv), 230)}`,
    `• 本轮：${clean(activeRuntime(job), 230)}`,
    `• 更新：${displayTime(job.updatedAt)}`,
    "",
    "下一步",
    clean(nextStep(job, projection), 260),
  );
  return lines.join("\n");
}

function renderNotification(state: HarnessState): string {
  const job = state.activeJob;
  if (!job) return "当前没有需要处理的 Harness 任务。";
  if (job.state === "recovery_approved" && job.approval?.basis === "policy_rule") {
    const lane = job.approval.action === "retry_fresh_reviewer" ? "Reviewer" : "Worker";
    return [
      "♻️ 自动恢复已授权 · 无需处理",
      `任务：${clean(job.task.repo, 160)}#${job.task.issueNumber} ${clean(job.task.title, 240)}`,
      `动作：启动全新 ${lane}`,
      `规则：${job.approval.policyRule} · fingerprint ${job.approval.fingerprint?.slice(0, 12)}`,
      "限制：该故障指纹的自动额度已用尽；再次发生将转为人工批准。",
    ].join("\n");
  }
  const incident = job.incident;
  if (!incident) return `⚙️ 运行中 · 无需处理\n${clean(job.task.repo, 160)}#${job.task.issueNumber} · ${clean(job.task.title, 240)}`;

  const analysis = job.analysis?.incidentId === incident.id ? job.analysis : null;
  const conclusion = analysis ? presentedAnalysisSummary(analysis) : "Harness 已记录阻塞，正在等待自动诊断。";
  const recommendation = analysis?.action === "hold"
    ? isEvidenceExhausted(analysis)
      ? "保持暂停；补齐完整失败日志后重新诊断，不要直接批准或重跑。"
      : "保持暂停；先处理未决信息，再按 Harness 策略重新诊断。"
    : analysis?.resolutionBrief || analysis?.summary || "等待系统生成下一步建议；不执行自动恢复。";
  return [
    `⚠️ 需要关注 · #${job.task.issueNumber}`,
    `任务：${clean(job.task.repo, 160)}#${job.task.issueNumber} ${clean(job.task.title, 240)}`,
    `结论：${clean(conclusion, 700)}`,
    `原因：${clean(incident.summary, 700)}`,
    ...(incident.runtimeDiagnostic
      ? [`运行诊断：${clean(formatSafePiRpcDiagnostic(incident.runtimeDiagnostic), 700)}`]
      : []),
    "影响：任务暂停；Harness 未执行自动恢复。",
    `建议：${clean(recommendation, 900)}`,
  ].join("\n");
}

function renderSummary(state: HarnessState, config: HarnessStatusConfig): string {
  const job = state.activeJob;
  if (!job) return `${clean(config.repo, 160)} · IDLE · 历史 ${state.terminalJobs.length}`;
  const parts = [
    `${clean(job.task.repo, 160)}#${job.task.issueNumber}`,
    job.state.toUpperCase(),
    `revision ${job.revision}`,
  ];
  if (job.activeAttempt) parts.push(`${job.activeAttempt.lane}/${job.activeAttempt.phase}`);
  if (job.incident) parts.push(`incident ${clean(job.incident.class, 80)}`);
  if (job.headSha) parts.push(`HEAD ${shortSha(job.headSha)}`);
  return parts.join(" · ");
}

function renderIncident(state: HarnessState, laneId?: string): string {
  const job = state.activeJob;
  if (!job) return "当前没有活跃任务，也没有待处理 incident。";
  const incident = job.incident;
  if (!incident) return `当前任务 ${clean(job.task.repo, 160)}#${job.task.issueNumber} 没有待处理 incident。`;
  const actions = projectOperatorState(state).actions;

  const lines = [
    "🚨 阻塞详情",
    `${mobileTask(job)} · rev ${job.revision}`,
    `${incident.class} · ${incident.lane}`,
    "",
    "发生了什么",
    clean(incident.summary, 260),
    ...(incident.runtimeDiagnostic
      ? ["", "运行诊断", clean(formatSafePiRpcDiagnostic(incident.runtimeDiagnostic), 260)]
      : []),
  ];

  const analysis = job.analysis?.incidentId === incident.id ? job.analysis : null;
  if (!analysis) {
    lines.push("", "Analyst 判断", "尚无与当前 incident 精确绑定的 durable analysis。", "", "下一步", "等待 Controller 调用 Analyst；不要手工恢复。");
    return lines.join("\n");
  }

  lines.push(
    "",
    "Analyst 判断",
    clean(presentedAnalysisSummary(analysis), 260),
    `建议动作：${analysis.action}`,
  );
  if (analysis.unknowns.length > 0) {
    lines.push("", "仍需确认", ...mobileBullets(analysis.unknowns));
  }
  lines.push("", "可做什么");
  if (actions.length > 0) {
    const prefix = `/harness${laneId ? ` ${laneId}` : ""}`;
    lines.push(...actions.flatMap((action) => [
      `• ${operatorActionLabel(action)}`,
      `  发送：${prefix} ${operatorActionCommand(action.kind)}`,
    ]));
  } else {
    lines.push("• 当前没有可执行操作");
  }
  lines.push("", "下一步");
  if (job.state === "recovery_approved" && job.approval?.basis === "policy_rule") {
    lines.push("低风险恢复已由精确策略授权；Controller 将重新校验后启动 fresh retry，无需人工批准。");
  } else if (actions.some((action) => action.kind === "approve_retry")) {
    lines.push(`发送 ${approvalCommand(laneId)} 获取新的 10 分钟 challenge。`);
  } else if (actions.length > 0) {
    lines.push("选择上面的精确操作；Harness 会在执行时重新校验全部绑定。");
  } else if (analysis.action === "hold") {
    lines.push("Analyst 建议 hold；没有可批准的 fresh retry。");
  } else {
    lines.push("当前建议已失效或不符合策略；不要手工恢复。");
  }
  return lines.join("\n");
}

function presentedAnalysisSummary(analysis: AnalystAdvice): string {
  return isEvidenceExhausted(analysis)
    ? "自动诊断未完成：在允许的证据轮数内仍缺少关键证据。"
    : analysis.summary;
}

function isEvidenceExhausted(analysis: AnalystAdvice): boolean {
  return analysis.summary === "Analyst evidence-gathering turns were exhausted"
    || analysis.summary.startsWith("自动诊断未完成：在允许的证据轮数内仍缺少关键证据");
}

function nextStep(job: Job, projection: OperatorProjection): string {
  switch (job.state) {
    case "claimed": return "Controller 将准备 worktree。";
    case "worker_ready": return "Controller 将准备并启动 Worker。";
    case "worker_running": return "等待 Worker 产生 durable result。";
    case "reviewer_ready": return "Controller 将准备并启动独立 Reviewer。";
    case "reviewer_running": return "等待 Reviewer 产生 durable result。";
    case "publish_ready": return "Controller 将推送分支并创建 PR。";
    case "awaiting_merge": return "等待 required checks、auto-merge 或新的 CI incident。";
    case "blocked": return projection.actions.length > 0
      ? `查看 /harness incident；当前有 ${projection.actions.length} 个精确绑定的可执行操作。`
      : "查看 /harness incident；当前没有可执行恢复操作。";
    case "recovery_approved": return job.approval?.basis === "policy_rule"
      ? "Controller 将重新校验并消费一次精确策略自动恢复。"
      : "Controller 将重新校验并消费已批准恢复。";
    case "done": return "任务已完成。";
    case "cancelled": return "任务已取消。";
  }
}

function operatorActionLabel(action: OperatorAction): string {
  const label = action.kind === "approve_retry"
    ? "批准 fresh retry"
    : action.kind === "reassess"
      ? "重新分析"
      : action.kind === "resolve_decision"
        ? "提供人工决策"
        : "取消并重新入队";
  return `${label} (${action.id})`;
}

function runtimeSelection(argv: string[]): string {
  const provider = flag(argv, "--provider");
  const model = flag(argv, "--model");
  const effort = flag(argv, "--thinking");
  if (!provider && !model && !effort) return "Pi 默认值";
  return [provider ? `provider=${clean(provider, 120)}` : null, model ? `model=${clean(model, 160)}` : null, effort ? `effort=${clean(effort, 40)}` : null]
    .filter((value): value is string => value !== null)
    .join(" · ");
}

function activeRuntime(job: Job): string {
  const attempt = job.activeAttempt;
  if (!attempt) return "尚未开始。";
  const snapshot = attempt.executionSnapshot;
  if (!snapshot) return "尚未记录运行信息，暂时无法确认模型。";
  return [
    attempt.lane === "worker" ? "Worker" : "Reviewer",
    snapshot.adapter,
    `provider=${clean(snapshot.provider ?? "Pi 默认值", 120)}`,
    `model=${clean(snapshot.model ?? "Pi 默认值", 160)}`,
    `effort=${clean(snapshot.thinking, 40)}`,
  ].join(" · ");
}

function loadBridgeConfig(path: string): BridgeConfig {
  const parsed = readJson(path) as Partial<BridgeConfig>;
  if (!parsed.harnessConfig || !isAbsolute(parsed.harnessConfig)) {
    throw new Error("bridge config harnessConfig must be an absolute path");
  }
  if (parsed.laneId !== undefined && !LANE_ID.test(parsed.laneId)) {
    throw new Error("bridge config laneId must be 1-32 lowercase letters, digits, or hyphens");
  }
  return { harnessConfig: parsed.harnessConfig, ...(parsed.laneId ? { laneId: parsed.laneId } : {}) };
}

function approvalCommand(laneId?: string): string {
  return laneId ? `/harness ${laneId} retry` : "/harness_retry";
}

function mobileTask(job: Job): string {
  return clean(`${job.task.repo}#${job.task.issueNumber}`, 220);
}

function mobileBullets(values: string[], limit = 2, max = 200): string[] {
  const shown = values.slice(0, limit).map((value) => `• ${clean(value, max)}`);
  if (values.length > limit) shown.push(`• …另 ${values.length - limit} 项`);
  return shown;
}

function stateIcon(state: Job["state"]): string {
  if (state === "blocked") return "🚨";
  if (state === "done") return "✅";
  if (state === "cancelled") return "⛔";
  if (state.endsWith("_running")) return "⚙️";
  return "🟡";
}

function loadHarnessConfig(path: string): HarnessStatusConfig {
  const parsed = readJson(path) as Partial<HarnessStatusConfig>;
  if (
    !parsed.repo?.trim()
    || !parsed.stateDir
    || !isAbsolute(parsed.stateDir)
    || !Array.isArray(parsed.workerArgv)
    || !Array.isArray(parsed.reviewerArgv)
    || parsed.workerArgv.some((value) => typeof value !== "string")
    || parsed.reviewerArgv.some((value) => typeof value !== "string")
  ) {
    throw new Error("Harness config is missing repo, absolute stateDir, workerArgv, or reviewerArgv");
  }
  return {
    repo: parsed.repo,
    stateDir: parsed.stateDir,
    workerArgv: parsed.workerArgv,
    reviewerArgv: parsed.reviewerArgv,
    ...(parsed.reviewerProviderProfiles ? { reviewerProviderProfiles: parsed.reviewerProviderProfiles } : {}),
  };
}

function readJson(path: string): unknown {
  if (!isAbsolute(path)) throw new Error("config path must be absolute");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function requiredFlag(argv: string[], name: string): string {
  const value = flag(argv, name);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
}

function clean(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function shortSha(value: string): string {
  return clean(value, 12);
}

function displayTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return clean(value, 80);
  const parts = Object.fromEntries(DISPLAY_TIME.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
}

function bounded(value: string): string {
  return value.length <= MAX_MESSAGE_LENGTH ? value : `${value.slice(0, MAX_MESSAGE_LENGTH - 20)}\n…内容已截断`;
}

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
