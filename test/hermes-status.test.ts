import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("Hermes status stays read-only and renders bounded ledger facts", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-hermes-status-"));
  try {
    const stateDir = join(root, "state");
    const harnessConfig = join(root, "harness.json");
    const bridgeConfig = join(root, "bridge.json");
    writeFileSync(harnessConfig, JSON.stringify({
      repo: "owner/repo",
      stateDir,
      maxReviewRounds: 3,
      workerArgv: ["--provider", "openai-codex", "--model", "gpt-test", "--thinking", "max"],
      reviewerArgv: ["--provider", "review-provider", "--model", "review-model", "--thinking", "max"],
      reviewerProviderProfiles: {
        active: "subscription",
        profiles: {
          subscription: {
            credentialMode: "canonical-oauth",
            provider: "openai-codex",
            model: "gpt-5.6-sol",
          },
          custom: {
            credentialMode: "canonical-model-config",
            provider: "review-provider",
            model: "review-model",
          },
        },
      },
    }), { encoding: "utf8", mode: 0o600 });
    writeFileSync(bridgeConfig, JSON.stringify({ harnessConfig }), { encoding: "utf8", mode: 0o600 });

    const idle = run("status", bridgeConfig);
    assert.equal(idle.status, 0);
    assert.match(idle.stdout, /状态：空闲/);
    const idleSummary = run("summary", bridgeConfig);
    assert.equal(idleSummary.status, 0);
    assert.match(idleSummary.stdout, /owner\/repo · IDLE/);

    const incident = {
      id: "incident-001",
      class: "infrastructure_exhausted",
      lane: "reviewer",
      attemptId: "attempt-001",
      summary: "provider sessions are full",
      evidenceDigest: "e".repeat(64),
      allowedActions: ["retry_fresh_reviewer", "hold"],
      createdAt: "2026-08-07T00:00:00.000Z",
    };
    const attempt: any = {
      id: "attempt-001",
      lane: "reviewer",
      phase: "settled",
      round: 1,
      baseSha: "a".repeat(40),
      expectedHeadSha: "b".repeat(40),
      resultPath: join(root, "review-result.json"),
      promptDigest: "p".repeat(64),
      handle: null,
      result: null,
      startedAt: "2026-08-07T00:00:00.000Z",
      completedAt: "2026-08-07T00:01:00.000Z",
    };
    const state: any = {
      version: 1,
      activeJob: {
        id: "job-001",
        revision: 12,
        state: "blocked",
        task: {
          repo: "owner/repo",
          issueNumber: 48,
          mapNumber: null,
          title: "Expose durable status",
          objective: "THIS OBJECTIVE MUST NOT BE EXPOSED",
          labels: ["ready-for-agent"],
          issueUpdatedAt: "2026-08-07T00:00:00.000Z",
          digest: "d".repeat(64),
        },
        baseSha: "a".repeat(40),
        claimConfirmed: true,
        headSha: "b".repeat(40),
        branch: "agent/issue-48",
        worktree: null,
        analyst: null,
        activeAttempt: attempt,
        attempts: [attempt],
        reviewRound: 1,
        maxReviewRounds: 3,
        pendingHandoff: null,
        incident,
        analysis: {
          id: "analysis-001",
          incidentId: incident.id,
          evidenceDigest: incident.evidenceDigest,
          action: "retry_fresh_reviewer",
          summary: "Retry only after the provider recovers",
          resolutionBrief: "Start a fresh Reviewer against the unchanged HEAD.",
          evidenceRefs: ["attempt_result"],
          unknowns: [],
          diagnosis: {
            primaryCause: "The Reviewer Provider failed before a durable result was recorded.",
            confidence: "high",
            contributingFactors: ["The Provider session pool was exhausted."],
            preservationConstraints: ["Keep the reviewed HEAD unchanged."],
            hypotheses: [
              {
                claim: "The candidate HEAD changed during review.",
                status: "rejected",
                confidence: "high",
                evidenceRefs: ["attempt_result"],
              },
            ],
          },
          createdAt: "2026-08-07T00:02:00.000Z",
        },
        approval: null,
        pullRequest: null,
        ciFailure: null,
        ciReworkCount: 0,
        lastError: "provider sessions are full",
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:02:00.000Z",
      },
      terminalJobs: [],
    };
    writeFileSync(join(stateDir, "state.json"), `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });

    const status = run("status", bridgeConfig);
    assert.equal(status.status, 0);
    assert.match(status.stdout, /^🚨 Harness · BLOCKED/m);
    assert.match(status.stdout, /\n\n进度\n/);
    assert.match(status.stdout, /\n\n下一步\n/);
    assert.match(status.stdout, /先看 \/harness_why，再用 \/harness_actions；当前有 1 个精确绑定操作。/);
    assert.match(status.stdout, /owner\/repo#48/);
    assert.match(status.stdout, /provider=openai-codex · model=gpt-test · effort=max/);
    assert.match(status.stdout, /• Reviewer：provider=openai-codex · model=gpt-5\.6-sol · effort=max/);
    assert.match(status.stdout, /• 本轮：尚未记录运行信息，暂时无法确认模型。/);
    assert.ok(!status.stdout.includes("ledger 未持久化"));
    assert.match(status.stdout, /• 更新：08-07 08:02:00 GMT\+8/);
    assert.ok(!status.stdout.includes("2026-08-07T00:02:00.000Z"));
    assert.ok(!status.stdout.includes("THIS OBJECTIVE MUST NOT BE EXPOSED"));
    assertMobileReadable(status.stdout);

    attempt.executionSnapshot = {
      version: 1,
      adapter: "pi-rpc",
      executable: "/opt/pi",
      runtimeVersion: "0.84.0",
      argv: [],
      provider: "review-provider",
      model: "review-model",
      thinking: "max",
      tools: ["read"],
      sessionMode: "ephemeral",
      retryMode: "disabled",
      compactionMode: "disabled",
      credentialMode: "canonical-model-config",
      dockerHost: null,
      resources: [],
    };
    attempt.planDigest = "f".repeat(64);
    writeFileSync(join(stateDir, "state.json"), `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    const boundStatus = run("status", bridgeConfig);
    assert.equal(boundStatus.status, 0);
    assert.match(boundStatus.stdout, /• 本轮：Reviewer · pi-rpc · provider=review-provider · model=review-model · effort=max/);

    const blocked = run("incident", bridgeConfig);
    assert.equal(blocked.status, 0);
    assert.match(blocked.stdout, /^🚨 阻塞详情/m);
    assert.match(blocked.stdout, /\n\n发生了什么\n/);
    assert.match(blocked.stdout, /\n\n可做什么\n/);
    assert.match(blocked.stdout, /建议动作：retry_fresh_reviewer/);
    assert.match(blocked.stdout, /• 批准 fresh retry \(decision-[0-9a-f]{16}\)/);
    assert.match(blocked.stdout, /发送：\/harness retry/);

    const why = run("why", bridgeConfig);
    assert.equal(why.status, 0);
    assert.match(why.stdout, /^🧭 为什么卡住了/m);
    assert.match(why.stdout, /\n\n结论\n/);
    assert.match(why.stdout, /主要原因 · high\nThe Reviewer Provider failed/);
    assert.match(why.stdout, /• rejected · The candidate HEAD changed/);
    assert.match(why.stdout, /必须保留\n• Keep the reviewed HEAD unchanged/);
    assert.match(why.stdout, /\n\n下一步\n/);
    assertMobileReadable(why.stdout);

    const originalAnalysis = state.activeJob.analysis;
    const originalIncidentClass = incident.class;
    const originalIncidentSummary = incident.summary;
    const originalAttemptRound = attempt.round;
    const originalAttemptResult = attempt.result;
    incident.class = "review_uncertain";
    incident.summary = "review rounds exhausted at 3: four unsafe publication paths remain";
    attempt.round = 3;
    attempt.result = {
      version: 1,
      jobId: state.activeJob.id,
      attemptId: attempt.id,
      lane: "reviewer",
      status: "changes",
      summary: "Two blocking risks remain.",
      reviewedHeadSha: state.activeJob.headSha,
      findings: [
        { severity: "major", summary: "Rollback failure can delete committed report bytes", evidence: "bounded evidence" },
        { severity: "major", summary: "FIFO replacement can block publication", evidence: "bounded evidence" },
      ],
    };
    state.activeJob.analysis = {
      id: "analysis-failed",
      incidentId: incident.id,
      evidenceDigest: incident.evidenceDigest,
      action: "hold",
      summary: "Analyst diagnosis failed closed: Codex Analyst wrapper failed: FAIL: Analyst diagnosis is invalid",
      resolutionBrief: "",
      evidenceRefs: [],
      unknowns: ["Codex Analyst wrapper failed: FAIL: Analyst diagnosis is invalid"],
      createdAt: "2026-08-07T00:03:00.000Z",
    };
    writeFileSync(join(stateDir, "state.json"), `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });

    const failedClosedWhy = run("why", bridgeConfig);
    assert.equal(failedClosedWhy.status, 0);
    assert.match(failedClosedWhy.stdout, /结论\nReviewer 在第 3 轮仍要求修改，共 2 个阻断问题；已达到审查上限，任务安全暂停。/);
    assert.match(failedClosedWhy.stdout, /发生了什么\nReviewer 已完成本轮审查，但仍有阻断问题；Harness 因达到审查上限转为人工决策。/);
    assert.match(failedClosedWhy.stdout, /关键依据\n• major · Rollback failure can delete committed report bytes/);
    assert.match(failedClosedWhy.stdout, /运行诊断\nAnalyst 输出未通过结构校验，Harness 未采用该诊断；原始 blocked 事实仍然有效。/);
    assert.match(failedClosedWhy.stdout, /下一步\n发送 \/harness_actions 查看当前允许的操作；不要仅因诊断失败直接重试。/);
    assert.ok(!failedClosedWhy.stdout.includes("主要原因 · 未结构化"));
    assert.ok(!failedClosedWhy.stdout.includes("Analyst diagnosis is invalid"));
    assertMobileReadable(failedClosedWhy.stdout);

    state.activeJob.analysis = originalAnalysis;
    incident.class = originalIncidentClass;
    incident.summary = originalIncidentSummary;
    attempt.round = originalAttemptRound;
    attempt.result = originalAttemptResult;
    writeFileSync(join(stateDir, "state.json"), `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });

    const evidence = run("evidence", bridgeConfig);
    assert.equal(evidence.status, 0);
    assert.match(evidence.stdout, /^🔎 证据索引/m);
    assert.match(evidence.stdout, /• Digest /);
    assert.match(evidence.stdout, /• attempt_result/);

    const actions = run("actions", bridgeConfig);
    assert.equal(actions.status, 0);
    assert.match(actions.stdout, /^🎛️ 当前可操作/m);
    assert.match(actions.stdout, /发送：\/harness retry/);
    assert.match(actions.stdout, /\n\n安全校验\n/);
    assertMobileReadable(actions.stdout);

    const notification = run("notification", bridgeConfig);
    assert.equal(notification.status, 0);
    assert.match(notification.stdout, /^⚠️ 需要关注 · #48/m);
    assert.match(notification.stdout, /^任务：owner\/repo#48 Expose durable status/m);
    assert.match(notification.stdout, /原因：provider sessions are full/);
    assert.match(notification.stdout, /影响：任务暂停；Harness 未执行自动恢复。/);
    assert.match(notification.stdout, /建议：Start a fresh Reviewer against the unchanged HEAD\./);
    assert.ok(!notification.stdout.includes("revision"));
    assert.ok(!notification.stdout.includes("Incident："));
    assert.ok(!notification.stdout.includes("Telegram 决策卡"));

    const automaticRecovery = {
      id: "approval-auto-001",
      jobRevision: state.activeJob.revision,
      incidentId: incident.id,
      analysisId: state.activeJob.analysis.id,
      action: "retry_fresh_reviewer",
      basis: "policy_rule",
      policyRule: "reviewer_same_head_infrastructure",
      fingerprint: "f".repeat(64),
      attemptId: attempt.id,
      actor: "harness:auto-recovery",
      reason: "reviewer_same_head_infrastructure",
      createdAt: "2026-08-07T00:03:00.000Z",
      consumedAt: null,
    };
    state.activeJob.revision += 1;
    state.activeJob.state = "recovery_approved";
    state.activeJob.incident.automaticRecovery = {
      rule: automaticRecovery.policyRule,
      fingerprint: automaticRecovery.fingerprint,
    };
    state.activeJob.approval = automaticRecovery;
    state.activeJob.automaticRecoveries = [automaticRecovery];
    writeFileSync(join(stateDir, "state.json"), `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    const automatic = run("notification", bridgeConfig);
    assert.equal(automatic.status, 0);
    assert.match(automatic.stdout, /自动恢复已授权 · 无需处理/);
    assert.match(automatic.stdout, /启动全新 Reviewer/);
    assert.ok(!automatic.stdout.includes("未执行自动恢复"));
    const automaticIncident = run("incident", bridgeConfig);
    assert.match(automaticIncident.stdout, /无需人工批准/);

    state.activeJob.state = "blocked";
    state.activeJob.approval = null;
    state.activeJob.analysis = {
      ...state.activeJob.analysis,
      id: "analysis-exhausted",
      action: "hold",
      summary: "Analyst evidence-gathering turns were exhausted",
      resolutionBrief: "",
      unknowns: ["more evidence is required than the Harness policy allows"],
    };
    writeFileSync(join(stateDir, "state.json"), `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    const exhausted = run("notification", bridgeConfig);
    assert.equal(exhausted.status, 0);
    assert.match(exhausted.stdout, /结论：自动诊断未完成：在允许的证据轮数内仍缺少关键证据。/);
    assert.match(exhausted.stdout, /建议：保持暂停；补齐完整失败日志后重新诊断，不要直接批准或重跑。/);
    assert.ok(!exhausted.stdout.includes("evidence-gathering turns were exhausted"));

    const summary = run("summary", bridgeConfig);
    assert.equal(summary.status, 0);
    assert.match(summary.stdout, /owner\/repo#48 · BLOCKED · revision 13/);
    assert.match(summary.stdout, /incident infrastructure_exhausted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function run(command: string, config: string) {
  return spawnSync(process.execPath, [resolve("dist/src/hermes-status.js"), command, "--config", config], {
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
    timeout: 5_000,
  });
}

function assertMobileReadable(value: string): void {
  assert.ok(value.length <= 2_400, `Telegram operator output is too long: ${value.length}`);
  for (const line of value.trimEnd().split("\n")) {
    assert.ok(line.length <= 280, `Telegram operator line is too long: ${line.length}`);
  }
}
