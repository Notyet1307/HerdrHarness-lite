import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
test("Hermes observer baselines old logs and retries text or approval-card deliveries", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-hermes-observer-"));
    try {
        const stateDir = join(root, "harness-state");
        const observerState = join(root, "observer", "state.json");
        const harnessConfig = join(root, "harness.json");
        const bridgeConfig = join(root, "bridge.json");
        const controllerLog = join(root, "controller.log");
        const controllerHeartbeat = join(stateDir, "controller-heartbeat.json");
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        writeFileSync(harnessConfig, JSON.stringify({
            repo: "owner/repo",
            stateDir,
            workerArgv: [],
            reviewerArgv: [],
        }), { encoding: "utf8", mode: 0o600 });
        writeFileSync(controllerLog, `${JSON.stringify({ ok: false, action: "preflight_failed", jobId: null, message: "historical failure" })}\n`, { encoding: "utf8", mode: 0o600 });
        const old = new Date(Date.now() - 120_000);
        utimesSync(controllerLog, old, old);
        writeFileSync(controllerHeartbeat, "{}\n", { encoding: "utf8", mode: 0o600 });
        writeBridge("/usr/bin/false");
        const first = runObserver();
        assert.equal(first.status, 0);
        let observer = readObserver(observerState);
        assert.equal(observer.outbox.length, 1);
        assert.match(observer.outbox[0].message ?? "", /^🟢 Observer 已上线 · 无需处理/m);
        assert.match(observer.outbox[0].message ?? "", /只推送任务开始、终态和需要关注的异常/);
        assert.ok(!(observer.outbox[0].message ?? "").includes("详情读取失败"));
        assert.ok(!(observer.outbox[0].message ?? "").includes("historical failure"));
        assert.ok(!observer.outbox.some((entry) => (entry.message ?? "").includes("Controller 心跳已停止")));
        assert.equal(observer.outbox[0].attempts, 1);
        observer.outbox[0].nextAttemptAt = 0;
        writeFileSync(observerState, `${JSON.stringify(observer)}\n`, { encoding: "utf8", mode: 0o600 });
        writeBridge("/usr/bin/true");
        assert.equal(runObserver().status, 0);
        assert.equal(readObserver(observerState).outbox.length, 0);
        const ledgerPath = join(stateDir, "state.json");
        const active = activeState(root);
        writeFileSync(ledgerPath, `${JSON.stringify(active)}\n`, { encoding: "utf8", mode: 0o600 });
        writeBridge("/usr/bin/false");
        assert.equal(runObserver().status, 0);
        observer = readObserver(observerState);
        assert.deepEqual(observer.outbox.map((entry) => entry.key), ["job:job-001"]);
        assert.equal(observer.outbox[0].message, "🟦 任务已开始 · 无需处理\nowner/repo#48 · Expose durable status");
        for (const entry of observer.outbox)
            entry.nextAttemptAt = 0;
        writeFileSync(observerState, `${JSON.stringify(observer)}\n`, { encoding: "utf8", mode: 0o600 });
        writeBridge("/usr/bin/true");
        assert.equal(runObserver().status, 0);
        assert.equal(readObserver(observerState).outbox.length, 0);
        active.activeJob.revision += 1;
        active.activeJob.state = "reviewer_ready";
        writeFileSync(ledgerPath, `${JSON.stringify(active)}\n`, { encoding: "utf8", mode: 0o600 });
        writeBridge("/usr/bin/false");
        assert.equal(runObserver().status, 0);
        assert.equal(readObserver(observerState).outbox.length, 0);
        const terminalJobs = [{
                id: "job-001",
                repo: "owner/repo",
                issueNumber: 48,
                state: "done",
                finishedAt: "2026-08-07T00:03:00.000Z",
                cancellation: null,
                reassessments: [],
            }];
        writeFileSync(ledgerPath, `${JSON.stringify({ version: 1, activeJob: null, terminalJobs })}\n`, { encoding: "utf8", mode: 0o600 });
        assert.equal(runObserver().status, 0);
        observer = readObserver(observerState);
        assert.deepEqual(observer.outbox.map((entry) => entry.key), ["terminal:job-001:done"]);
        assert.equal(observer.outbox[0].message, "✅ 任务已完成 · 无需处理\nowner/repo#48");
        for (const entry of observer.outbox)
            entry.nextAttemptAt = 0;
        writeFileSync(observerState, `${JSON.stringify(observer)}\n`, { encoding: "utf8", mode: 0o600 });
        writeBridge("/usr/bin/true");
        assert.equal(runObserver().status, 0);
        assert.equal(readObserver(observerState).outbox.length, 0);
        const blocked = { ...blockedState(root), terminalJobs };
        const blockedLedgerWithHistory = `${JSON.stringify(blocked)}\n`;
        writeFileSync(ledgerPath, blockedLedgerWithHistory, { encoding: "utf8", mode: 0o600 });
        writeBridge("/usr/bin/false");
        assert.equal(runObserver().status, 0);
        observer = readObserver(observerState);
        assert.ok(observer.outbox.some((entry) => entry.kind === "approval" && entry.analysisId === "analysis-001"));
        assert.ok(observer.outbox.every((entry) => !(entry.message ?? "").includes("SECRET ISSUE BODY")));
        for (const entry of observer.outbox)
            entry.nextAttemptAt = 0;
        writeFileSync(observerState, `${JSON.stringify(observer)}\n`, { encoding: "utf8", mode: 0o600 });
        writeBridge("/usr/bin/true");
        assert.equal(runObserver().status, 0);
        assert.ok(!readObserver(observerState).outbox.some((entry) => entry.kind === "approval"));
        blocked.activeJob.revision += 1;
        blocked.activeJob.incident.class = "ci_failure";
        blocked.activeJob.incident.lane = "controller";
        blocked.activeJob.incident.attemptId = null;
        blocked.activeJob.incident.summary = "PR #87 required CI failed at a43e55d: test-docker-compose";
        blocked.activeJob.incident.allowedActions = ["retry_fresh_worker", "hold"];
        blocked.activeJob.pullRequest = {
            number: 87,
            url: "https://github.com/owner/repo/pull/87",
            headSha: "b".repeat(40),
        };
        blocked.activeJob.ciFailure = {
            headSha: "b".repeat(40),
            observedAt: "2026-08-07T00:01:30.000Z",
            checks: [{
                    name: "test-docker-compose",
                    state: "FAILURE",
                    bucket: "fail",
                    workflow: "Test Docker Compose",
                    link: "https://github.com/owner/repo/actions/runs/1/job/2",
                    completedAt: "2026-08-07T00:01:00.000Z",
                    diagnostic: "Expected: 409\nReceived: 202",
                }],
        };
        blocked.activeJob.analysis = {
            ...blocked.activeJob.analysis,
            id: "analysis-exhausted",
            action: "hold",
            summary: "Analyst evidence-gathering turns were exhausted",
            resolutionBrief: "",
            unknowns: ["more evidence is required than the Harness policy allows"],
            createdAt: "2026-08-07T00:03:00.000Z",
        };
        const heldLedger = `${JSON.stringify(blocked)}\n`;
        writeFileSync(ledgerPath, heldLedger, { encoding: "utf8", mode: 0o600 });
        writeBridge("/usr/bin/false");
        assert.equal(runObserver().status, 0);
        observer = readObserver(observerState);
        const holdCard = observer.outbox.find((entry) => entry.kind === "card");
        assert.ok(holdCard, JSON.stringify(observer.outbox));
        assert.match(holdCard.message ?? "", /自动诊断未完成/);
        assert.match(holdCard.message ?? "", /补齐完整失败日志后重新诊断/);
        assert.match(holdCard.message ?? "", /<blockquote expandable>/);
        assert.match(holdCard.message ?? "", /已观察到 GitHub 必需 CI 失败/);
        assert.ok(!(holdCard.message ?? "").includes("evidence-gathering turns were exhausted"));
        assert.ok((holdCard.message ?? "").length <= 3_900);
        appendFileSync(controllerLog, `${JSON.stringify({ ok: false, action: "preflight_failed", jobId: "job-001", message: "provider probe failed" })}\n`, { encoding: "utf8" });
        writeBridge("/usr/bin/false");
        assert.equal(runObserver().status, 0);
        observer = readObserver(observerState);
        assert.ok(observer.outbox.some((entry) => (entry.message ?? "").includes("preflight_failed") && (entry.message ?? "").includes("未执行自动恢复")));
        assert.equal(readFileSync(ledgerPath, "utf8"), heldLedger);
        function writeBridge(hermesBin) {
            writeFileSync(bridgeConfig, JSON.stringify({
                laneId: "exposure",
                harnessConfig,
                nodeBin: process.execPath,
                statusScript: resolve("dist/src/hermes-status.js"),
                approvalScript: resolve("dist/src/hermes-approval.js"),
                harnessCliScript: resolve("dist/src/cli.js"),
                approvalState: join(root, "approval", "state.json"),
                telegramAllowedUser: "123456789",
                hermesBin,
                hermesProfile: "harness",
                target: "telegram",
                observerState,
                controllerLog,
                pollMs: 1_000,
                heartbeatTimeoutMs: 60_000,
            }), { encoding: "utf8", mode: 0o600 });
        }
        function runObserver() {
            return spawnSync(process.execPath, [resolve("dist/src/hermes-observer.js"), "run", "--config", bridgeConfig, "--once"], {
                encoding: "utf8",
                timeout: 10_000,
            });
        }
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
function readObserver(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}
function activeState(root) {
    const state = blockedState(root);
    return {
        ...state,
        activeJob: {
            ...state.activeJob,
            revision: 5,
            state: "worker_ready",
            incident: null,
            analysis: null,
            lastError: null,
        },
    };
}
function blockedState(root) {
    const incident = {
        id: "incident-001",
        class: "infrastructure_exhausted",
        lane: "reviewer",
        attemptId: null,
        summary: "provider sessions are full",
        evidenceDigest: "e".repeat(64),
        allowedActions: ["retry_fresh_reviewer", "hold"],
        createdAt: "2026-08-07T00:00:00.000Z",
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
                title: "Expose durable status",
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
            activeAttempt: null,
            attempts: [],
            reviewRound: 1,
            maxReviewRounds: 3,
            pendingBrief: null,
            incident,
            analysis: {
                id: "analysis-001",
                incidentId: incident.id,
                evidenceDigest: incident.evidenceDigest,
                action: "retry_fresh_reviewer",
                summary: "Retry after provider recovery",
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
//# sourceMappingURL=hermes-observer.test.js.map