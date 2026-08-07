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
    assert.match(confirmed.stdout, /已记录精确恢复批准/);
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

function run(command: "request" | "confirm", config: string, token?: string) {
  return spawnSync(process.execPath, [resolve("dist/src/hermes-approval.js"), command, "--config", config], {
    encoding: "utf8",
    timeout: 10_000,
    ...(token ? { input: JSON.stringify({ token }) } : {}),
  });
}

function tokenFrom(output: string): string {
  const match = output.match(/\/harness approve ([0-9A-F]{16})/);
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
      pendingBrief: null,
      incident,
      analysis: {
        id: "analysis-001",
        incidentId: incident.id,
        evidenceDigest: incident.evidenceDigest,
        action: "retry_fresh_reviewer",
        summary: "Retry only after provider recovery",
        resolutionBrief: "Start a fresh Reviewer against the unchanged HEAD.",
        evidenceRefs: ["attempt_result"],
        unknowns: [],
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
