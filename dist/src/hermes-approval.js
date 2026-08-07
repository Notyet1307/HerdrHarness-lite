#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { JsonStateStore } from "./adapters/json-store.js";
import { isRetryAction } from "./model.js";
import { allowedActionsFor } from "./policy.js";
const CHALLENGE_TTL_MS = 10 * 60 * 1_000;
const MAX_STDIN_BYTES = 1_024;
async function main(argv) {
    const command = argv[2];
    if (command !== "request" && command !== "confirm") {
        throw new Error("usage: hermes-approval request|confirm --config /absolute/bridge.json");
    }
    const config = loadConfig(requiredFlag(argv, "--config"));
    if (command === "request")
        return requestChallenge(config);
    return confirmChallenge(config);
}
async function requestChallenge(config) {
    const ledger = await new JsonStateStore(config.harnessStateDir).load();
    const job = ledger.activeJob;
    if (!job)
        throw new Error("当前没有活跃任务");
    if (job.state !== "blocked" || !job.incident)
        throw new Error("当前任务不在等待恢复批准");
    if (!job.analysis || job.analysis.incidentId !== job.incident.id)
        throw new Error("当前 incident 尚无精确绑定的 Analyst 建议");
    if (!isRetryAction(job.analysis.action))
        throw new Error("Analyst 没有建议 fresh retry，不能批准");
    if (!job.incident.allowedActions.includes(job.analysis.action)
        || !allowedActionsFor(job.incident.class, job.incident.lane).includes(job.analysis.action)) {
        throw new Error("当前 incident policy 不允许 Analyst 建议的恢复动作");
    }
    const token = randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase();
    const createdAt = new Date();
    const challenge = {
        version: 1,
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
    };
    saveChallenge(config.approvalState, challenge);
    process.stdout.write([
        "⚠️ 待批准 Harness fresh retry",
        `任务：${clean(job.task.repo, 160)}#${job.task.issueNumber}`,
        `阻塞：${job.incident.class} · ${job.incident.lane}`,
        ...(job.headSha ? [`HEAD：${job.headSha.slice(0, 12)}`] : []),
        `动作：${actionLabel(challenge.action)}`,
        `revision：${job.revision}`,
        `Analyst：${clean(job.analysis.summary, 500)}`,
        `恢复说明：${clean(job.analysis.resolutionBrief, 700)}`,
        "有效期：10 分钟；新的挑战会使旧挑战失效。",
        `确认命令：/harness approve ${token}`,
        "不想批准就不要发送确认命令。",
    ].join("\n") + "\n");
    return 0;
}
async function confirmChallenge(config) {
    const token = readToken();
    const challenge = loadChallenge(config.approvalState);
    if (challenge.consumedAt !== null
        || Date.parse(challenge.expiresAt) <= Date.now()
        || digestToken(token) !== challenge.tokenDigest) {
        throw new Error("挑战码无效、已过期或已使用；请重新发送 /harness approve");
    }
    const store = new JsonStateStore(config.harnessStateDir);
    const before = await store.load();
    assertChallengeCurrent(before.activeJob, challenge);
    const actor = `telegram:${config.telegramAllowedUser}`;
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
        throw new Error(`Harness 拒绝批准：${clean(approved.error?.message || approved.stderr || approved.stdout || `exit ${approved.status}`, 700)}`);
    }
    const after = await store.load();
    const approval = after.activeJob?.approval;
    if (!approval
        || approval.jobRevision !== challenge.revision
        || approval.incidentId !== challenge.incidentId
        || approval.analysisId !== challenge.analysisId
        || approval.action !== challenge.action
        || approval.actor !== actor) {
        throw new Error("Harness 命令返回成功，但 ledger 中没有精确匹配的 durable approval");
    }
    challenge.consumedAt = new Date().toISOString();
    let auditWarning = "";
    try {
        saveChallenge(config.approvalState, challenge);
    }
    catch (error) {
        auditWarning = `\n⚠️ approval 已写入 ledger，但挑战状态落盘失败：${clean(message(error), 300)}`;
    }
    process.stdout.write([
        "✅ Harness 已记录精确恢复批准",
        `任务：${clean(challenge.repo, 160)}#${challenge.issueNumber}`,
        `动作：${actionLabel(challenge.action)}`,
        "Controller 会重新校验并只启动全新的 Worker/Reviewer。",
    ].join("\n") + auditWarning + "\n");
    return 0;
}
function assertChallengeCurrent(job, challenge) {
    if (!job
        || job.id !== challenge.jobId
        || job.revision !== challenge.revision
        || job.state !== "blocked"
        || job.incident?.id !== challenge.incidentId
        || job.analysis?.id !== challenge.analysisId
        || job.analysis.incidentId !== job.incident.id
        || job.analysis.action !== challenge.action) {
        throw new Error("任务、revision、incident 或 analysis 已变化；请重新发送 /harness approve");
    }
}
function readToken() {
    const input = readFileSync(0, "utf8");
    if (input.length > MAX_STDIN_BYTES)
        throw new Error("确认输入过长");
    let parsed;
    try {
        parsed = JSON.parse(input);
    }
    catch {
        throw new Error("确认输入不是 JSON");
    }
    const token = typeof parsed === "object" && parsed !== null && "token" in parsed
        ? String(parsed.token).trim().toUpperCase()
        : "";
    if (!/^[0-9A-F]{16}$/.test(token))
        throw new Error("挑战码格式无效");
    return token;
}
function loadConfig(path) {
    assertSecureAbsoluteFile(path, "bridge config");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    for (const name of ["harnessConfig", "nodeBin", "harnessCliScript", "approvalState"]) {
        if (!parsed[name] || !isAbsolute(parsed[name]))
            throw new Error(`${name} must be an absolute path`);
    }
    if (!parsed.telegramAllowedUser || !/^[1-9][0-9]{2,19}$/.test(parsed.telegramAllowedUser)) {
        throw new Error("telegramAllowedUser must be one numeric Telegram user id");
    }
    const file = parsed;
    const harness = JSON.parse(readFileSync(file.harnessConfig, "utf8"));
    if (typeof harness.stateDir !== "string" || !isAbsolute(harness.stateDir) || !existsSync(harness.stateDir)) {
        throw new Error("Harness config stateDir must be an existing absolute path");
    }
    return { ...file, harnessStateDir: harness.stateDir };
}
function loadChallenge(path) {
    assertSecureAbsoluteFile(path, "approval challenge");
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value.version !== 1
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
        || (value.consumedAt !== null && !Number.isFinite(Date.parse(value.consumedAt)))) {
        throw new Error("approval challenge state is invalid");
    }
    return value;
}
function saveChallenge(path, challenge) {
    if (existsSync(path))
        assertSecureAbsoluteFile(path, "approval challenge");
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temp = join(directory, ".state.json.tmp");
    writeFileSync(temp, `${JSON.stringify(challenge, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
}
function assertSecureAbsoluteFile(path, label) {
    if (!isAbsolute(path))
        throw new Error(`${label} path must be absolute`);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0)
        throw new Error(`${label} must not be a symlink or group/other writable`);
}
function digestToken(token) {
    const hash = createHash("sha256");
    hash.update(token);
    return hash.digest("hex");
}
function actionLabel(action) {
    return action === "retry_fresh_worker" ? "启动全新 Worker" : "启动全新 Reviewer（保持当前 HEAD）";
}
function requiredFlag(argv, name) {
    const index = argv.indexOf(name);
    const value = index >= 0 ? argv[index + 1] : undefined;
    if (!value?.trim())
        throw new Error(`${name} is required`);
    return value;
}
function clean(value, max) {
    return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function message(error) {
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
//# sourceMappingURL=hermes-approval.js.map