import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("Telegram approval challenge is one-use and bound to exact durable recovery facts", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-hermes-approval-"));
  try {
    const stateDir = join(root, "harness-state");
    const harnessConfig = join(root, "harness.json");
    const bridgeConfig = join(root, "bridge.json");
    const approvalState = join(root, "approval", "state.json");
    const ledgerPath = join(stateDir, "state.json");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(harnessConfig, JSON.stringify({
      stateDir,
      herdr: { session: "test" },
      analyst: { command: "/usr/bin/false" },
    }), { encoding: "utf8", mode: 0o600 });
    writeFileSync(bridgeConfig, JSON.stringify({
      harnessConfig,
      nodeBin: process.execPath,
      harnessCliScript: resolve("dist/src/cli.js"),
      approvalState,
      telegramAllowedUser: "123456789",
    }), { encoding: "utf8", mode: 0o600 });
    writeFileSync(ledgerPath, `${JSON.stringify(blockedState())}\n`, { encoding: "utf8", mode: 0o600 });

    const first = run("request", bridgeConfig);
    assert.equal(first.status, 0);
    const firstToken = tokenFrom(first.stdout);
    assert.ok(!readFileSync(approvalState, "utf8").includes(firstToken));

    const wrong = run("confirm", bridgeConfig, "0".repeat(16));
    assert.equal(wrong.status, 1);
    assert.equal(readLedger(ledgerPath).activeJob.state, "blocked");

    const changed = readLedger(ledgerPath);
    changed.activeJob.revision += 1;
    writeFileSync(ledgerPath, `${JSON.stringify(changed)}\n`, { encoding: "utf8", mode: 0o600 });
    const stale = run("confirm", bridgeConfig, firstToken);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /已变化/);

    const second = run("request", bridgeConfig);
    assert.equal(second.status, 0);
    const secondToken = tokenFrom(second.stdout);
    const confirmed = run("confirm", bridgeConfig, secondToken);
    assert.equal(confirmed.status, 0);
    assert.match(confirmed.stdout, /已记录精确 operator action/);
    const approved = readLedger(ledgerPath).activeJob;
    assert.equal(approved.state, "recovery_approved");
    assert.equal(approved.approval.actor, "telegram:123456789");
    assert.equal(approved.approval.action, "retry_fresh_reviewer");
    assert.ok(JSON.parse(readFileSync(approvalState, "utf8")).consumedAt);

    const replay = run("confirm", bridgeConfig, secondToken);
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /已使用/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Telegram approval card exposes bounded decisions and hold consumes only the challenge", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-hermes-card-"));
  try {
    const stateDir = join(root, "harness-state");
    const harnessConfig = join(root, "harness.json");
    const bridgeConfig = join(root, "bridge.json");
    const approvalState = join(root, "approval", "state.json");
    const ledgerPath = join(stateDir, "state.json");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(harnessConfig, JSON.stringify({ stateDir, herdr: { session: "test" }, analyst: { command: "/usr/bin/false" } }), { encoding: "utf8", mode: 0o600 });
    writeFileSync(bridgeConfig, JSON.stringify({
      laneId: "exposure",
      harnessConfig,
      nodeBin: process.execPath,
      harnessCliScript: resolve("dist/src/cli.js"),
      approvalState,
      telegramAllowedUser: "123456789",
    }), { encoding: "utf8", mode: 0o600 });
    const state = blockedState();
    state.activeJob.incident.summary = "provider <script> & down ".repeat(100);
    state.activeJob.analysis.summary = "retry <only> & verify ".repeat(100);
    state.activeJob.analysis.resolutionBrief = "start <fresh> & keep HEAD ".repeat(100);
    state.activeJob.analysis.unknowns = ["unknown <one> & detail ".repeat(100)];
    writeFileSync(ledgerPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });

    const requested = run("request", bridgeConfig, undefined, true);
    assert.equal(requested.status, 0);
    const payload = JSON.parse(requested.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.analysisId, "analysis-001");
    assert.match(payload.card.text, /#48 已阻塞 · 需要你决定/);
    assert.match(payload.card.text, /Approve a fresh retry/);
    assert.match(payload.card.text, /结论：/);
    assert.match(payload.card.text, /影响：/);
    assert.match(payload.card.text, /建议：/);
    assert.match(payload.card.text, /建议原因：/);
    assert.match(payload.card.text, /<blockquote expandable><b>展开时间线与证据（Controller 本机时间）<\/b>/);
    assert.match(payload.card.text, /任务进入 Harness/);
    assert.match(payload.card.text, /Reviewer 开始（第 1 轮）/);
    assert.match(payload.card.text, /Reviewer 结束；ledger 尚未收到持久化结果/);
    assert.match(payload.card.text, /Harness 记录 infrastructure_exhausted · reviewer/);
    assert.match(payload.card.text, /Analyst 建议：retry_fresh_reviewer/);
    assert.match(payload.card.text, /原始阻塞：/);
    assert.match(payload.card.text, /证据引用：attempt_result/);
    assert.match(payload.card.text, /实例.*exposure/);
    assert.ok(payload.card.text.length <= 3_900);
    assert.ok(!payload.card.text.includes("<script>"));
    assert.match(payload.card.text, /&lt;script&gt;/);
    assert.equal(payload.card.approveLabel, "批准：全新 Reviewer");
    assert.match(payload.card.approveCallback, /^hh:a:exposure:[0-9A-F]{16}$/);
    assert.match(payload.card.holdCallback, /^hh:h:exposure:[0-9A-F]{16}$/);

    const token = payload.card.holdCallback.split(":").at(-1);
    const held = run("hold", bridgeConfig, token, true);
    assert.equal(held.status, 0);
    assert.equal(JSON.parse(held.stdout).action, "held");
    assert.equal(readLedger(ledgerPath).activeJob.state, "blocked");
    const audit = JSON.parse(readFileSync(approvalState, "utf8"));
    assert.equal(audit.decision, "held");
    assert.equal(audit.actor, "telegram:123456789");
    assert.ok(audit.consumedAt);

    const replay = run("confirm", bridgeConfig, token, true);
    assert.equal(replay.status, 1);
    assert.equal(JSON.parse(replay.stdout).code, "challenge_invalid");
    assert.equal(JSON.parse(replay.stdout).terminal, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Telegram approval emits a Transport v2 event without HTML or workflow authority", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-hermes-transport-card-"));
  try {
    const stateDir = join(root, "harness-state");
    const harnessConfig = join(root, "harness.json");
    const observerConfig = join(root, "observer.json");
    const approvalState = join(root, "approval", "state.json");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(harnessConfig, JSON.stringify({ stateDir, herdr: { session: "test" }, analyst: { command: "/usr/bin/false" } }), { encoding: "utf8", mode: 0o600 });
    writeFileSync(observerConfig, JSON.stringify({
      transportVersion: 2,
      routeId: "exposure",
      projectId: "Exposure-Agent",
      fleetId: "engineering-fleet",
      harnessConfig,
      nodeBin: process.execPath,
      harnessCliScript: resolve("dist/src/cli.js"),
      approvalState,
      telegramAllowedUser: "123456789",
    }), { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(stateDir, "state.json"), `${JSON.stringify(blockedState())}\n`, { encoding: "utf8", mode: 0o600 });

    const requested = run("request", observerConfig, undefined, true, ["--transport-v2"]);
    assert.equal(requested.status, 0, requested.stderr);
    const payload = JSON.parse(requested.stdout);
    assert.equal(payload.ok, true);
    assert.equal("card" in payload, false);
    assert.equal(payload.envelope.version, 2);
    assert.equal(payload.envelope.kind, "event");
    assert.equal(payload.envelope.category, "operator.approval");
    assert.equal(payload.envelope.routeId, "exposure");
    assert.equal(payload.envelope.projectId, "Exposure-Agent");
    assert.match(payload.envelope.approval.token, /^[0-9A-F]{16}$/);
    assert.equal(JSON.stringify(payload.envelope).includes("<b>"), false);
    assert.equal(JSON.stringify(payload.envelope).includes("SECRET ISSUE BODY"), false);
    assert.equal("approveCallback" in payload.envelope.approval, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Telegram challenge can consume an exact reassessment option with a bounded operator reason", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-hermes-reassess-"));
  try {
    const stateDir = join(root, "harness-state");
    const harnessConfig = join(root, "harness.json");
    const bridgeConfig = join(root, "bridge.json");
    const approvalState = join(root, "approval", "state.json");
    const ledgerPath = join(stateDir, "state.json");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(harnessConfig, JSON.stringify({ stateDir, herdr: { session: "test" }, analyst: { command: "/usr/bin/false" } }), { encoding: "utf8", mode: 0o600 });
    writeFileSync(bridgeConfig, JSON.stringify({
      laneId: "exposure",
      harnessConfig,
      nodeBin: process.execPath,
      harnessCliScript: resolve("dist/src/cli.js"),
      approvalState,
      telegramAllowedUser: "123456789",
    }), { encoding: "utf8", mode: 0o600 });
    const state = blockedState();
    state.activeJob.analysis.action = "hold";
    state.activeJob.analysis.resolutionBrief = "";
    state.activeJob.analysis.unknowns = ["Dirty worktree progress is not yet classified."];
    writeFileSync(ledgerPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });

    const reason = "Preserve staged and unstaged files, then analyze the fresh evidence.";
    const requested = run("request", bridgeConfig, undefined, false, ["--kind", "reassess", "--reason", reason]);
    assert.equal(requested.status, 0, requested.stderr);
    const token = tokenFrom(requested.stdout, "reassess");
    const mismatched = run("confirm", bridgeConfig, token, false, ["--kind", "approve_retry"]);
    assert.equal(mismatched.status, 1);
    assert.match(mismatched.stderr, /命令类型与 challenge 不匹配/);
    assert.equal(readLedger(ledgerPath).activeJob.analysis.action, "hold");
    const confirmed = run("confirm", bridgeConfig, token, false, ["--kind", "reassess"]);
    assert.equal(confirmed.status, 0, confirmed.stderr);
    const job = readLedger(ledgerPath).activeJob;
    assert.equal(job.state, "blocked");
    assert.equal(job.analysis, null);
    assert.equal(job.reassessments.at(-1).reason, reason);
    assert.equal(job.reassessments.at(-1).actor, "telegram:123456789");
    assert.ok(job.incident.id !== "incident-001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI projects and consumes one exact operator option", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-operator-option-"));
  try {
    const stateDir = join(root, "state");
    const config = join(root, "harness.json");
    const ledgerPath = join(stateDir, "state.json");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(config, JSON.stringify({
      stateDir,
      herdr: { session: "test" },
      analyst: { command: "/usr/bin/false" },
    }), { encoding: "utf8", mode: 0o600 });
    writeFileSync(ledgerPath, `${JSON.stringify(blockedState())}\n`, { encoding: "utf8", mode: 0o600 });

    const status = runHarness(["status", "--config", config, "--operator"]);
    assert.equal(status.status, 0);
    const projection = JSON.parse(status.stdout);
    assert.equal(projection.mode, "needs_decision");
    assert.equal(projection.actions[0].kind, "approve_retry");

    const decided = runHarness([
      "decide", "--config", config,
      "--option", projection.actions[0].id,
      "--actor", "human@example.test",
      "--reason", "Provider health probe passed.",
    ]);
    assert.equal(decided.status, 0);
    assert.equal(readLedger(ledgerPath).activeJob.state, "recovery_approved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function run(command: "request" | "confirm" | "hold", config: string, token?: string, json = false, extraArgs: string[] = []) {
  return spawnSync(process.execPath, [
    resolve("dist/src/hermes-approval.js"), command, "--config", config, ...extraArgs, ...(json ? ["--json"] : []),
  ], {
    encoding: "utf8",
    timeout: 10_000,
    ...(token ? { input: JSON.stringify({ token }) } : {}),
  });
}

function runHarness(argv: string[]) {
  return spawnSync(process.execPath, [resolve("dist/src/cli.js"), ...argv], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

function tokenFrom(output: string, command = "retry"): string {
  const match = output.match(new RegExp(`/harness(?: exposure)? ${command} ([0-9A-F]{16})`));
  assert.ok(match);
  return match[1]!;
}

function readLedger(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function blockedState() {
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
  const attempt = {
    id: "attempt-001",
    lane: "reviewer",
    phase: "settled",
    round: 1,
    baseSha: "a".repeat(40),
    expectedHeadSha: "b".repeat(40),
    resultPath: "/tmp/review-result.json",
    promptDigest: "p".repeat(64),
    handle: null,
    result: null,
    startedAt: "2026-08-07T00:00:00.000Z",
    completedAt: "2026-08-07T00:01:00.000Z",
  };
  return {
    version: 1,
    activeJob: {
      id: "job-001",
      revision: 12,
      state: "blocked",
      task: {
        repo: "owner/repo",
        issueNumber: 48,
        mapNumber: null,
        title: "Approve a fresh retry",
        objective: "SECRET ISSUE BODY",
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
        summary: "Retry only after provider recovery",
        resolutionBrief: "Start a fresh Reviewer against the unchanged HEAD.",
        evidenceRefs: ["attempt_result"],
        unknowns: [] as string[],
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
}
