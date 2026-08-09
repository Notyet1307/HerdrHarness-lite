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
            reviewerArgv: ["--provider", "review-provider", "--model", "review-model", "--thinking", "high"],
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
        const attempt = {
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
        const state = {
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
                pendingBrief: null,
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
        assert.match(status.stdout, /owner\/repo#48/);
        assert.match(status.stdout, /provider=openai-codex · model=gpt-test · effort=max/);
        assert.ok(!status.stdout.includes("THIS OBJECTIVE MUST NOT BE EXPOSED"));
        const blocked = run("incident", bridgeConfig);
        assert.equal(blocked.status, 0);
        assert.match(blocked.stdout, /Analyst 建议：retry_fresh_reviewer/);
        assert.match(blocked.stdout, /可执行操作：批准 fresh retry \(decision-[0-9a-f]{16}\)/);
        assert.match(blocked.stdout, /Telegram 决策卡/);
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
        assert.match(summary.stdout, /owner\/repo#48 · BLOCKED · revision 12/);
        assert.match(summary.stdout, /incident infrastructure_exhausted/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
function run(command, config) {
    return spawnSync(process.execPath, [resolve("dist/src/hermes-status.js"), command, "--config", config], {
        encoding: "utf8",
        timeout: 5_000,
    });
}
//# sourceMappingURL=hermes-status.test.js.map