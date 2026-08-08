#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { JsonStateStore } from "./adapters/json-store.js";
import { MAX_CI_REWORKS, type HarnessState, type Job } from "./model.js";

const MAX_MESSAGE_LENGTH = 3_500;
const LANE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

type BridgeConfig = {
  harnessConfig: string;
  laneId?: string;
};

type HarnessStatusConfig = {
  repo: string;
  stateDir: string;
  workerArgv: string[];
  reviewerArgv: string[];
};

async function main(argv: string[]): Promise<number> {
  const command = argv[2] || "status";
  if (command !== "status" && command !== "incident" && command !== "summary" && command !== "notification") {
    throw new Error("command must be status, incident, summary, or notification");
  }
  const bridgePath = requiredFlag(argv, "--config");
  const bridge = loadBridgeConfig(bridgePath);
  const harness = loadHarnessConfig(bridge.harnessConfig);
  const state = await new JsonStateStore(harness.stateDir).load();
  const message = command === "status"
    ? renderStatus(state, harness)
    : command === "incident"
      ? renderIncident(state, bridge.laneId)
      : command === "notification"
        ? renderNotification(state)
        : renderSummary(state, harness);
  process.stdout.write(`${bounded(message)}\n`);
  return 0;
}

function renderStatus(state: HarnessState, config: HarnessStatusConfig): string {
  const job = state.activeJob;
  if (!job) {
    return [
      "Herdr Harness Lite",
      `仓库：${clean(config.repo, 160)}`,
      "状态：空闲（ledger 无活跃任务）",
      `历史终态任务：${state.terminalJobs.length}`,
      "下一步：是否继续领取由正在运行的 Controller 和 GitHub eligibility 决定。",
    ].join("\n");
  }

  const lines = [
    "Herdr Harness Lite",
    `任务：${clean(job.task.repo, 160)}#${job.task.issueNumber} ${clean(job.task.title, 240)}`,
    `状态：${job.state} · revision ${job.revision}`,
    `Review：${job.reviewRound}/${job.maxReviewRounds}`,
    `CI rework：${job.ciReworkCount ?? 0}/${MAX_CI_REWORKS}`,
  ];
  if (job.activeAttempt) {
    lines.push(`当前尝试：${job.activeAttempt.lane} · ${job.activeAttempt.phase} · round ${job.activeAttempt.round}`);
  }
  if (job.headSha) lines.push(`HEAD：${shortSha(job.headSha)}`);
  if (job.pullRequest) lines.push(`PR：#${job.pullRequest.number} ${clean(job.pullRequest.url, 500)}`);
  lines.push(
    `Worker 配置：${runtimeSelection(config.workerArgv)}`,
    `Reviewer 配置：${runtimeSelection(config.reviewerArgv)}`,
    "实际运行模型：ledger 未持久化时不可从配置推断。",
    `更新时间：${clean(job.updatedAt, 80)}`,
    `下一步：${nextStep(job)}`,
  );
  return lines.join("\n");
}

function renderNotification(state: HarnessState): string {
  const job = state.activeJob;
  if (!job) return "当前没有需要处理的 Harness 任务。";
  const incident = job.incident;
  if (!incident) return `任务：${clean(job.task.repo, 160)}#${job.task.issueNumber} ${clean(job.task.title, 240)}\n状态：${job.state}`;

  const analysis = job.analysis?.incidentId === incident.id ? job.analysis : null;
  const recommendation = analysis?.resolutionBrief || analysis?.summary || "等待系统生成下一步建议；不执行自动恢复。";
  return [
    `任务：${clean(job.task.repo, 160)}#${job.task.issueNumber} ${clean(job.task.title, 240)}`,
    `原因：${clean(incident.summary, 700)}`,
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

  const lines = [
    `任务：${clean(job.task.repo, 160)}#${job.task.issueNumber} ${clean(job.task.title, 240)}`,
    `状态：${job.state} · revision ${job.revision}`,
    `Incident：${clean(incident.id, 512)}`,
    `分类：${incident.class} · lane ${incident.lane}`,
    `摘要：${clean(incident.summary, 700)}`,
    `允许动作：${incident.allowedActions.join(", ")}`,
  ];

  const analysis = job.analysis?.incidentId === incident.id ? job.analysis : null;
  if (!analysis) {
    lines.push("Analyst：尚无与当前 incident 精确绑定的 durable analysis。", "下一步：等待 Controller 调用 Analyst；不要手工恢复。");
    return lines.join("\n");
  }

  lines.push(
    `Analysis：${clean(analysis.id, 512)}`,
    `Analyst 建议：${analysis.action}`,
    `判断：${clean(analysis.summary, 700)}`,
    `恢复说明：${clean(analysis.resolutionBrief, 900)}`,
  );
  if (analysis.unknowns.length > 0) {
    lines.push(`未决信息：${analysis.unknowns.slice(0, 3).map((value) => clean(value, 240)).join("；")}`);
  }
  if (analysis.action === "hold") {
    lines.push("下一步：Analyst 建议 hold；没有可批准的 fresh retry。");
  } else {
    lines.push(`下一步：使用当前 Telegram 决策卡批准 fresh retry，或发送 ${approvalCommand(laneId)} 获取新的 10 分钟挑战。`);
  }
  return lines.join("\n");
}

function nextStep(job: Job): string {
  switch (job.state) {
    case "claimed": return "Controller 将准备 worktree。";
    case "worker_ready": return "Controller 将准备并启动 Worker。";
    case "worker_running": return "等待 Worker 产生 durable result。";
    case "reviewer_ready": return "Controller 将准备并启动独立 Reviewer。";
    case "reviewer_running": return "等待 Reviewer 产生 durable result。";
    case "publish_ready": return "Controller 将推送分支并创建 PR。";
    case "awaiting_merge": return "等待 required checks、auto-merge 或新的 CI incident。";
    case "blocked": return "查看 /harness incident；若 Analyst 给出精确 fresh retry，使用 Telegram 决策卡处理。";
    case "recovery_approved": return "Controller 将重新校验并消费已批准恢复。";
    case "done": return "任务已完成。";
    case "cancelled": return "任务已取消。";
  }
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
  return laneId ? `/harness ${laneId} approve` : "/harness approve";
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
