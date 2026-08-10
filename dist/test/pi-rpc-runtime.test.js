import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PiRpcRuntime } from "../src/adapters/pi-rpc-runtime.js";
import { SyncCommandRunner } from "../src/adapters/command.js";
import { digest } from "../src/model.js";
import { executionResourceDigest } from "../src/attempt-plan.js";
import { StrictJsonlDecoder } from "../src/pi-rpc-runner.js";
import { readJson, rpcGeneration, writeAtomicJson, writeExclusiveJson, } from "../src/pi-rpc-spool.js";
test("Pi RPC adapter persists one launch and one dispatch across Controller restarts", async () => {
    const fixture = rpcFixture();
    try {
        let launches = 0;
        const host = {
            async runInPane(input) {
                launches += 1;
                const plan = readJson(input.argv.at(-1));
                const identity = receiptIdentity(plan);
                writeExclusiveJson(join(plan.runtimeRoot, "owner.json"), { ...identity, ok: true, runnerPid: process.pid });
                writeAtomicJson(join(plan.runtimeRoot, "ready.json"), {
                    ...identity,
                    ok: true,
                    autoRetryDisableAccepted: true,
                    autoCompactionEnabled: false,
                    credentialMode: "canonical-oauth",
                    isolatedAgentDir: join(plan.runtimeRoot, "pi-agent"),
                });
            },
        };
        const runtime = new PiRpcRuntime(host);
        await runtime.startAgent({ handle: fixture.handle, attempt: fixture.attempt, cwd: fixture.root, argv: fixture.snapshot.argv });
        await new PiRpcRuntime(host).startAgent({
            handle: fixture.handle,
            attempt: fixture.attempt,
            cwd: fixture.root,
            argv: fixture.snapshot.argv,
        });
        assert.equal(launches, 1);
        const plan = readJson(join(fixture.runtimeRoot, "plan.json"));
        const identity = receiptIdentity(plan);
        writeAtomicJson(join(plan.runtimeRoot, "accepted.json"), { ...identity, ok: true, dispatchId: fixture.attempt.id });
        await runtime.prompt({
            handle: fixture.handle,
            attempt: fixture.attempt,
            dispatchId: fixture.attempt.id,
            skill: "implement",
            text: "implement",
        });
        const firstDispatch = readFileSync(join(plan.runtimeRoot, "dispatch.json"), "utf8");
        await new PiRpcRuntime(host).prompt({
            handle: fixture.handle,
            attempt: fixture.attempt,
            dispatchId: fixture.attempt.id,
            skill: "implement",
            text: "implement",
        });
        assert.equal(readFileSync(join(plan.runtimeRoot, "dispatch.json"), "utf8"), firstDispatch);
        writeFileSync(fixture.attempt.resultPath, `${JSON.stringify(workerResult(fixture.attempt.id))}\n`);
        writeAtomicJson(join(plan.runtimeRoot, "terminal.json"), { ...identity, ok: true });
        writeAtomicJson(join(plan.runtimeRoot, "terminated.json"), { ...identity, ok: true });
        const observation = await runtime.wait({
            handle: fixture.handle,
            attempt: fixture.attempt,
            resultPath: fixture.attempt.resultPath,
            expectedJobId: "job-1",
            expectedAttemptId: fixture.attempt.id,
            expectedLane: "worker",
        });
        assert.equal(observation.result?.attemptId, fixture.attempt.id);
        await runtime.terminate({ handle: fixture.handle, attempt: fixture.attempt, reason: "completed" });
    }
    finally {
        rmSync(fixture.root, { recursive: true, force: true });
    }
});
test("Pi RPC adapter never invents a missing dispatch and fails closed on policy terminal", async () => {
    const fixture = rpcFixture();
    try {
        const plan = fixture.plan();
        writeExclusiveJson(join(plan.runtimeRoot, "plan.json"), plan);
        await assert.rejects(() => new PiRpcRuntime({ runInPane: async () => undefined }).wait({
            handle: fixture.handle,
            attempt: fixture.attempt,
            resultPath: fixture.attempt.resultPath,
            expectedJobId: "job-1",
            expectedAttemptId: fixture.attempt.id,
            expectedLane: "worker",
        }), /no durable dispatch intent/);
        writeExclusiveJson(join(plan.runtimeRoot, "dispatch.json"), { version: 1 });
        writeAtomicJson(join(plan.runtimeRoot, "terminal.json"), {
            ...receiptIdentity(plan),
            ok: false,
            error: "forbidden Pi RPC event: auto_retry_start",
        });
        await assert.rejects(() => new PiRpcRuntime({ runInPane: async () => undefined }).wait({
            handle: fixture.handle,
            attempt: fixture.attempt,
            resultPath: fixture.attempt.resultPath,
            expectedJobId: "job-1",
            expectedAttemptId: fixture.attempt.id,
            expectedLane: "worker",
        }), /auto_retry_start/);
    }
    finally {
        rmSync(fixture.root, { recursive: true, force: true });
    }
});
test("Pi RPC adapter rejects an unqualified Pi protocol version", async () => {
    const fixture = rpcFixture();
    try {
        fixture.snapshot.runtimeVersion = "0.85.0";
        await assert.rejects(() => new PiRpcRuntime({ runInPane: async () => undefined }).startAgent({
            handle: fixture.handle,
            attempt: fixture.attempt,
            cwd: fixture.root,
            argv: fixture.snapshot.argv,
        }), /requires the qualified Pi version 0\.84\.0/);
    }
    finally {
        rmSync(fixture.root, { recursive: true, force: true });
    }
});
test("Pi RPC adapter rejects a changed SDK host before pane launch", async () => {
    const fixture = rpcFixture();
    try {
        const sdkHost = fixture.snapshot.resources.find((resource) => resource.kind === "runtime" && resource.path.endsWith("pi-rpc-sdk-entry.js"));
        assert.ok(sdkHost);
        sdkHost.digest = "0".repeat(64);
        let launches = 0;
        await assert.rejects(() => new PiRpcRuntime({ runInPane: async () => { launches += 1; } }).startAgent({
            handle: fixture.handle,
            attempt: fixture.attempt,
            cwd: fixture.root,
            argv: fixture.snapshot.argv,
        }), /runtime resource changed/);
        assert.equal(launches, 0);
    }
    finally {
        rmSync(fixture.root, { recursive: true, force: true });
    }
});
test("strict Pi RPC JSONL keeps Unicode separators inside one record", () => {
    const decoder = new StrictJsonlDecoder();
    const records = decoder.push('{"type":"message_end","text":"left\u2028right\u2029done"}\r\n');
    decoder.finish();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.text, "left\u2028right\u2029done");
    assert.throws(() => new StrictJsonlDecoder().push(`${"x".repeat(1024 * 1024 + 1)}`), /maximum size/);
});
test("durable runner disables retry and compaction before dispatch and settles through result", () => {
    const fixture = rpcFixture();
    const previous = {
        result: process.env.FAKE_PI_RESULT_PATH,
        job: process.env.FAKE_PI_JOB_ID,
        attempt: process.env.FAKE_PI_ATTEMPT_ID,
        malformed: process.env.FAKE_PI_MALFORMED_AFTER_PROMPT,
    };
    try {
        const plan = fixture.plan({
            executable: process.execPath,
            argv: [
                resolve("test/fixtures/fake-pi-rpc.js"),
                "--no-session",
                "--no-context-files",
                "--no-prompt-templates",
                "--no-themes",
                "--provider",
                "test",
                "--model",
                "model",
                "--mode",
                "rpc",
            ],
        });
        const sourceAgentDir = plan.snapshot.context.agentDir;
        mkdirSync(sourceAgentDir, { recursive: true });
        writeFileSync(join(sourceAgentDir, "settings.json"), "{\"retry\":{\"enabled\":true},\"compaction\":{\"enabled\":true}}\n");
        writeFileSync(join(sourceAgentDir, "auth.json"), '{"oauth":"must-not-share"}\n', { mode: 0o600 });
        writeFileSync(join(sourceAgentDir, "models.json"), "{}\n");
        const sourceSettings = readFileSync(join(sourceAgentDir, "settings.json"), "utf8");
        const sourceAuth = readFileSync(join(sourceAgentDir, "auth.json"), "utf8");
        writeExclusiveJson(join(plan.runtimeRoot, "plan.json"), plan);
        writeExclusiveJson(join(plan.runtimeRoot, "dispatch.json"), {
            version: 1,
            attemptId: plan.attemptId,
            generation: plan.generation,
            planDigest: plan.planDigest,
            dispatchId: plan.attemptId,
            promptDigest: fixture.attempt.promptDigest,
            message: "/skill:implement [harness-dispatch:worker-1]\nimplement",
        });
        process.env.FAKE_PI_RESULT_PATH = fixture.attempt.resultPath;
        process.env.FAKE_PI_JOB_ID = "job-1";
        process.env.FAKE_PI_ATTEMPT_ID = fixture.attempt.id;
        const execution = new SyncCommandRunner().run(process.execPath, [
            resolve("dist/src/pi-rpc-runner.js"),
            "--sdk-entry",
            resolve("test/fixtures/pi-rpc-sdk-entry.js"),
            "--plan",
            join(plan.runtimeRoot, "plan.json"),
        ], { cwd: fixture.root, timeoutMs: 10_000 });
        assert.equal(execution.ok, true, execution.stderr);
        assert.equal(readJson(join(plan.runtimeRoot, "ready.json")).ok, true);
        assert.equal(readJson(join(plan.runtimeRoot, "ready.json")).autoRetryDisableAccepted, true);
        assert.equal(readJson(join(plan.runtimeRoot, "ready.json")).autoCompactionEnabled, false);
        assert.equal(readJson(join(plan.runtimeRoot, "ready.json")).credentialMode, "canonical-oauth");
        const isolatedAgentDir = join(plan.runtimeRoot, "pi-agent");
        assert.equal(readJson(join(plan.runtimeRoot, "ready.json")).isolatedAgentDir, isolatedAgentDir);
        assert.equal(readFileSync(join(sourceAgentDir, "settings.json"), "utf8"), sourceSettings);
        assert.equal(existsSync(join(isolatedAgentDir, "settings.json")), false);
        assert.equal(readFileSync(join(sourceAgentDir, "auth.json"), "utf8"), sourceAuth);
        assert.equal(existsSync(join(isolatedAgentDir, "auth.json")), false);
        assert.equal(existsSync(join(isolatedAgentDir, "models.json")), false);
        assert.equal(readJson(join(plan.runtimeRoot, "accepted.json")).ok, true);
        assert.equal(readJson(join(plan.runtimeRoot, "terminal.json")).agentSettled, true);
        assert.equal(readJson(join(plan.runtimeRoot, "terminated.json")).ok, true);
        assert.equal(JSON.parse(readFileSync(fixture.attempt.resultPath, "utf8")).attemptId, fixture.attempt.id);
    }
    finally {
        restoreEnv("FAKE_PI_RESULT_PATH", previous.result);
        restoreEnv("FAKE_PI_JOB_ID", previous.job);
        restoreEnv("FAKE_PI_ATTEMPT_ID", previous.attempt);
        restoreEnv("FAKE_PI_MALFORMED_AFTER_PROMPT", previous.malformed);
        rmSync(fixture.root, { recursive: true, force: true });
    }
});
test("durable runner rejects private auth writes before ready or after settlement", () => {
    for (const authWriteVariable of ["FAKE_PI_WRITE_AUTH_BEFORE_READY", "FAKE_PI_WRITE_AUTH_AFTER_SETTLED"]) {
        const fixture = rpcFixture();
        const previous = {
            result: process.env.FAKE_PI_RESULT_PATH,
            job: process.env.FAKE_PI_JOB_ID,
            attempt: process.env.FAKE_PI_ATTEMPT_ID,
            authWrite: process.env[authWriteVariable],
        };
        try {
            const plan = fixture.plan({
                executable: process.execPath,
                argv: [
                    resolve("test/fixtures/fake-pi-rpc.js"),
                    "--no-session",
                    "--no-context-files",
                    "--no-prompt-templates",
                    "--no-themes",
                    "--provider",
                    "test",
                    "--model",
                    "model",
                    "--mode",
                    "rpc",
                ],
            });
            writeExclusiveJson(join(plan.runtimeRoot, "plan.json"), plan);
            writeExclusiveJson(join(plan.runtimeRoot, "dispatch.json"), {
                version: 1,
                attemptId: plan.attemptId,
                generation: plan.generation,
                planDigest: plan.planDigest,
                dispatchId: plan.attemptId,
                promptDigest: fixture.attempt.promptDigest,
                message: "/skill:implement [harness-dispatch:worker-1]\nimplement",
            });
            process.env.FAKE_PI_RESULT_PATH = fixture.attempt.resultPath;
            process.env.FAKE_PI_JOB_ID = "job-1";
            process.env.FAKE_PI_ATTEMPT_ID = fixture.attempt.id;
            process.env[authWriteVariable] = "1";
            const execution = new SyncCommandRunner().run(process.execPath, [
                resolve("dist/src/pi-rpc-runner.js"),
                "--sdk-entry",
                resolve("test/fixtures/pi-rpc-sdk-entry.js"),
                "--plan",
                join(plan.runtimeRoot, "plan.json"),
            ], { cwd: fixture.root, timeoutMs: 10_000 });
            assert.equal(execution.ok, false, authWriteVariable);
            assert.equal(readJson(join(plan.runtimeRoot, "terminal.json")).ok, false);
            assert.equal(readJson(join(plan.runtimeRoot, "terminated.json")).ok, true);
        }
        finally {
            restoreEnv("FAKE_PI_RESULT_PATH", previous.result);
            restoreEnv("FAKE_PI_JOB_ID", previous.job);
            restoreEnv("FAKE_PI_ATTEMPT_ID", previous.attempt);
            restoreEnv(authWriteVariable, previous.authWrite);
            rmSync(fixture.root, { recursive: true, force: true });
        }
    }
});
test("durable runner never persists child Provider diagnostics", () => {
    const fixture = rpcFixture();
    const sentinel = "access_token_SENTINEL";
    const previous = process.env.FAKE_PI_SECRET_ERROR;
    try {
        const plan = fixture.plan({
            executable: process.execPath,
            argv: [
                resolve("test/fixtures/fake-pi-rpc.js"),
                "--no-session", "--no-context-files", "--no-prompt-templates", "--no-themes",
                "--provider", "test", "--model", "model", "--mode", "rpc",
            ],
        });
        writeExclusiveJson(join(plan.runtimeRoot, "plan.json"), plan);
        process.env.FAKE_PI_SECRET_ERROR = sentinel;
        const execution = new SyncCommandRunner().run(process.execPath, [
            resolve("dist/src/pi-rpc-runner.js"),
            "--sdk-entry", resolve("test/fixtures/pi-rpc-sdk-entry.js"),
            "--plan", join(plan.runtimeRoot, "plan.json"),
        ], { cwd: fixture.root, timeoutMs: 10_000 });
        assert.equal(execution.ok, false);
        for (const path of filesUnder(plan.runtimeRoot)) {
            assert.equal(readFileSync(path, "utf8").includes(sentinel), false, path);
        }
    }
    finally {
        restoreEnv("FAKE_PI_SECRET_ERROR", previous);
        rmSync(fixture.root, { recursive: true, force: true });
    }
});
test("durable runner redacts malformed Provider output before ready or after settlement", () => {
    const sentinel = "access_token_SENTINEL";
    for (const phase of ["before-ready", "after-settled"]) {
        const fixture = rpcFixture();
        const previous = {
            result: process.env.FAKE_PI_RESULT_PATH,
            job: process.env.FAKE_PI_JOB_ID,
            attempt: process.env.FAKE_PI_ATTEMPT_ID,
            secret: process.env.FAKE_PI_MALFORMED_SECRET,
            phase: process.env.FAKE_PI_MALFORMED_SECRET_PHASE,
        };
        try {
            const plan = fixture.plan({
                executable: process.execPath,
                argv: [
                    resolve("test/fixtures/fake-pi-rpc.js"),
                    "--no-session", "--no-context-files", "--no-prompt-templates", "--no-themes",
                    "--provider", "test", "--model", "model", "--mode", "rpc",
                ],
            });
            writeExclusiveJson(join(plan.runtimeRoot, "plan.json"), plan);
            writeExclusiveJson(join(plan.runtimeRoot, "dispatch.json"), {
                version: 1,
                attemptId: plan.attemptId,
                generation: plan.generation,
                planDigest: plan.planDigest,
                dispatchId: plan.attemptId,
                promptDigest: fixture.attempt.promptDigest,
                message: "/skill:implement [harness-dispatch:worker-1]\nimplement",
            });
            process.env.FAKE_PI_RESULT_PATH = fixture.attempt.resultPath;
            process.env.FAKE_PI_JOB_ID = "job-1";
            process.env.FAKE_PI_ATTEMPT_ID = fixture.attempt.id;
            process.env.FAKE_PI_MALFORMED_SECRET = sentinel;
            process.env.FAKE_PI_MALFORMED_SECRET_PHASE = phase;
            const execution = new SyncCommandRunner().run(process.execPath, [
                resolve("dist/src/pi-rpc-runner.js"),
                "--sdk-entry", resolve("test/fixtures/pi-rpc-sdk-entry.js"),
                "--plan", join(plan.runtimeRoot, "plan.json"),
            ], { cwd: fixture.root, timeoutMs: 10_000 });
            assert.equal(execution.ok, false, phase);
            assert.equal(execution.stderr, "FAIL: Pi RPC runner failed\n");
            for (const path of filesUnder(plan.runtimeRoot)) {
                assert.equal(readFileSync(path, "utf8").includes(sentinel), false, path);
            }
        }
        finally {
            restoreEnv("FAKE_PI_RESULT_PATH", previous.result);
            restoreEnv("FAKE_PI_JOB_ID", previous.job);
            restoreEnv("FAKE_PI_ATTEMPT_ID", previous.attempt);
            restoreEnv("FAKE_PI_MALFORMED_SECRET", previous.secret);
            restoreEnv("FAKE_PI_MALFORMED_SECRET_PHASE", previous.phase);
            rmSync(fixture.root, { recursive: true, force: true });
        }
    }
});
test("durable runner fails closed when RPC JSONL breaks before or after settlement", () => {
    for (const malformedVariable of ["FAKE_PI_MALFORMED_AFTER_PROMPT", "FAKE_PI_MALFORMED_AFTER_SETTLED"]) {
        const fixture = rpcFixture();
        const previous = {
            result: process.env.FAKE_PI_RESULT_PATH,
            job: process.env.FAKE_PI_JOB_ID,
            attempt: process.env.FAKE_PI_ATTEMPT_ID,
            malformed: process.env[malformedVariable],
        };
        try {
            const plan = fixture.plan({
                executable: process.execPath,
                argv: [
                    resolve("test/fixtures/fake-pi-rpc.js"),
                    "--no-session",
                    "--no-context-files",
                    "--no-prompt-templates",
                    "--no-themes",
                    "--provider",
                    "test",
                    "--model",
                    "model",
                    "--mode",
                    "rpc",
                ],
            });
            writeExclusiveJson(join(plan.runtimeRoot, "plan.json"), plan);
            writeExclusiveJson(join(plan.runtimeRoot, "dispatch.json"), {
                version: 1,
                attemptId: plan.attemptId,
                generation: plan.generation,
                planDigest: plan.planDigest,
                dispatchId: plan.attemptId,
                promptDigest: fixture.attempt.promptDigest,
                message: "/skill:implement [harness-dispatch:worker-1]\nimplement",
            });
            process.env.FAKE_PI_RESULT_PATH = fixture.attempt.resultPath;
            process.env.FAKE_PI_JOB_ID = "job-1";
            process.env.FAKE_PI_ATTEMPT_ID = fixture.attempt.id;
            process.env[malformedVariable] = "1";
            const execution = new SyncCommandRunner().run(process.execPath, [
                resolve("dist/src/pi-rpc-runner.js"),
                "--sdk-entry",
                resolve("test/fixtures/pi-rpc-sdk-entry.js"),
                "--plan",
                join(plan.runtimeRoot, "plan.json"),
            ], { cwd: fixture.root, timeoutMs: 10_000 });
            assert.equal(execution.ok, false, malformedVariable);
            // A later malformed record may share the stdout chunk with the prompt ack;
            // the durable dispatch intent, not an invented acceptance, prevents replay.
            assert.equal(readJson(join(plan.runtimeRoot, "terminal.json")).ok, false);
            assert.equal(readJson(join(plan.runtimeRoot, "terminated.json")).ok, true);
        }
        finally {
            restoreEnv("FAKE_PI_RESULT_PATH", previous.result);
            restoreEnv("FAKE_PI_JOB_ID", previous.job);
            restoreEnv("FAKE_PI_ATTEMPT_ID", previous.attempt);
            restoreEnv(malformedVariable, previous.malformed);
            rmSync(fixture.root, { recursive: true, force: true });
        }
    }
});
test("durable runner confirms child exit before acknowledging Controller termination", async () => {
    const fixture = rpcFixture();
    try {
        const plan = fixture.plan({
            executable: process.execPath,
            argv: [
                resolve("test/fixtures/fake-pi-rpc.js"),
                "--no-session",
                "--no-context-files",
                "--no-prompt-templates",
                "--no-themes",
                "--provider",
                "test",
                "--model",
                "model",
                "--mode",
                "rpc",
            ],
        });
        writeExclusiveJson(join(plan.runtimeRoot, "plan.json"), plan);
        writeExclusiveJson(join(plan.runtimeRoot, "dispatch.json"), {
            version: 1,
            attemptId: plan.attemptId,
            generation: plan.generation,
            planDigest: plan.planDigest,
            dispatchId: plan.attemptId,
            promptDigest: fixture.attempt.promptDigest,
            message: "/skill:implement [harness-dispatch:worker-1]\nimplement",
        });
        const child = spawn(process.execPath, [
            resolve("dist/src/pi-rpc-runner.js"),
            "--sdk-entry",
            resolve("test/fixtures/pi-rpc-sdk-entry.js"),
            "--plan",
            join(plan.runtimeRoot, "plan.json"),
        ], {
            cwd: fixture.root,
            env: {
                ...process.env,
                FAKE_PI_WAIT_FOR_ABORT: "1",
            },
            stdio: "ignore",
        });
        await waitForFile(join(plan.runtimeRoot, "accepted.json"));
        writeExclusiveJson(join(plan.runtimeRoot, "terminate.json"), {
            version: 1,
            attemptId: plan.attemptId,
            generation: plan.generation,
            planDigest: plan.planDigest,
            reason: "recovery",
        });
        const code = await new Promise((resolveExit) => child.on("exit", resolveExit));
        assert.equal(code, 0);
        assert.equal(readJson(join(plan.runtimeRoot, "terminal.json")).ok, false);
        assert.equal(readJson(join(plan.runtimeRoot, "terminated.json")).ok, true);
    }
    finally {
        rmSync(fixture.root, { recursive: true, force: true });
    }
});
function rpcFixture() {
    const root = mkdtempSync(join(tmpdir(), "harness-rpc-"));
    const attemptRoot = join(root, "attempt");
    const runtimeRoot = join(attemptRoot, "runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    const handle = { agentName: "worker-1", paneId: "pane-1", tabId: "tab-1", workspaceId: "workspace-1" };
    const snapshot = {
        version: 1,
        adapter: "pi-rpc",
        executable: "/opt/pi",
        runtimeVersion: "0.84.0",
        argv: ["--no-session", "--no-context-files", "--no-prompt-templates", "--no-themes", "--provider", "test", "--model", "model", "--mode", "rpc"],
        provider: "test",
        model: "model",
        thinking: "high",
        tools: ["read", "bash", "worker_submit"],
        sessionMode: "ephemeral",
        retryMode: "disabled",
        compactionMode: "disabled",
        credentialMode: "canonical-oauth",
        dockerHost: null,
        resources: [
            ...["implement", "tdd", "focused-self-check"].map((name) => ({
                kind: "skill",
                path: join("/skills", name),
                digest: "e".repeat(64),
            })),
            runtimeResource(resolve("dist/src/pi-rpc-runner.js")),
            runtimeResource(resolve("test/fixtures/pi-rpc-sdk-entry.js")),
        ],
        context: {
            version: 1,
            mode: "explicit-v1",
            lane: "worker",
            trustAnchorSha: "a".repeat(40),
            entries: [],
            bundlePath: join(attemptRoot, "trusted-context.md"),
            bundleDigest: "c".repeat(64),
            manifestPath: join(attemptRoot, "trusted-context.json"),
            manifestDigest: "d".repeat(64),
            agentDir: join(root, "agent"),
        },
    };
    const attempt = {
        id: "worker-1",
        lane: "worker",
        phase: "pane_ready",
        round: 1,
        baseSha: "a".repeat(40),
        expectedHeadSha: null,
        expectedRemoteHeadSha: null,
        resultPath: join(root, "result.json"),
        promptDigest: digest("implement"),
        executionSnapshot: snapshot,
        planDigest: "b".repeat(64),
        handle,
        result: null,
        reconciliationAttempts: 0,
        startedAt: "2026-08-09T00:00:00.000Z",
        completedAt: null,
    };
    const plan = (overrides = {}) => {
        const effectiveSnapshot = { ...snapshot, ...overrides };
        return {
            version: 1,
            attemptId: attempt.id,
            generation: rpcGeneration(attempt.id, attempt.planDigest, handle),
            planDigest: attempt.planDigest,
            promptDigest: attempt.promptDigest,
            handle,
            cwd: root,
            resultPath: attempt.resultPath,
            runtimeRoot,
            snapshot: effectiveSnapshot,
        };
    };
    return { root, runtimeRoot, handle, snapshot, attempt, plan };
}
function receiptIdentity(plan) {
    return { version: 1, attemptId: plan.attemptId, generation: plan.generation, planDigest: plan.planDigest };
}
function runtimeResource(path) {
    return { kind: "runtime", path, digest: executionResourceDigest(dirname(path)) };
}
function workerResult(attemptId) {
    return {
        version: 1,
        jobId: "job-1",
        attemptId,
        lane: "worker",
        status: "completed",
        summary: "done",
        headSha: "b".repeat(40),
        failedCommands: [],
    };
}
function restoreEnv(name, value) {
    if (value === undefined)
        delete process.env[name];
    else
        process.env[name] = value;
}
async function waitForFile(path) {
    const deadline = Date.now() + 5_000;
    while (!existsSync(path)) {
        if (Date.now() >= deadline)
            throw new Error(`timed out waiting for ${path}`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
}
function filesUnder(root) {
    return readdirSync(root).flatMap((name) => {
        const path = join(root, name);
        return lstatSync(path).isDirectory() ? filesUnder(path) : [path];
    });
}
//# sourceMappingURL=pi-rpc-runtime.test.js.map