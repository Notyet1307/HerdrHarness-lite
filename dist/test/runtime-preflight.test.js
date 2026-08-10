import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RuntimePreflightCli } from "../src/adapters/runtime-preflight.js";
import { executionResource, executionResourceDigest } from "../src/attempt-plan.js";
class RecordingRunner {
    responses;
    onRun;
    calls = [];
    constructor(responses, onRun) {
        this.responses = responses;
        this.onRun = onRun;
    }
    run(command, args, options = {}) {
        this.calls.push({ command, args: [...args], ...options });
        this.onRun?.();
        const response = this.responses.shift();
        if (!response)
            throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        return response;
    }
}
test("Pi inspection resolves and versions one exact executable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "harness-pi-"));
    const executable = join(directory, "pi-test");
    writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
    chmodSync(executable, 0o700);
    const runner = new RecordingRunner([ok("0.84.0\n")]);
    const result = await new RuntimePreflightCli(runner, { PATH: directory }).inspectPi({ cwd: "/repo", piBin: "pi-test" });
    assert.deepEqual(result, { executable: realpathSync(executable), version: "0.84.0" });
    assert.equal(runner.calls[0]?.command, realpathSync(executable));
    assert.deepEqual(runner.calls[0]?.args, ["--version"]);
});
test("ambient Pi SYSTEM prompts fail closed while an empty bound agent directory is accepted", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-pi-context-"));
    const cwd = join(root, "repo");
    const agentDir = join(root, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    const preflight = new RuntimePreflightCli(new RecordingRunner([]), { PI_CODING_AGENT_DIR: agentDir });
    assert.deepEqual(await preflight.assertNoAmbientSystemPrompt({ cwd }), { agentDir: resolve(agentDir) });
    writeFileSync(join(agentDir, "SYSTEM.md"), "ambient\n");
    await assert.rejects(() => preflight.assertNoAmbientSystemPrompt({ cwd }), /ambient Pi system prompt is not allowed/);
    await assert.rejects(() => new RuntimePreflightCli(new RecordingRunner([]), { PI_CODING_AGENT_DIR: "relative-agent" }).assertNoAmbientSystemPrompt({ cwd }), /absolute lock identity/);
});
test("RPC Provider preflight uses canonical OAuth with an Attempt-private settings directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-pi-rpc-preflight-"));
    const sourceAgentDir = join(root, "source-agent");
    const isolatedAgentDir = join(root, "runtime", "pi-agent");
    const rpcHost = createRpcHost(root);
    mkdirSync(sourceAgentDir);
    writeFileSync(join(sourceAgentDir, "auth.json"), '{"oauth":"must-not-share"}\n', { mode: 0o600 });
    writeFileSync(join(sourceAgentDir, "models.json"), "{}\n", { mode: 0o600 });
    const runner = new RecordingRunner([ok("HERDR_HARNESS_PROVIDER_OK\n")]);
    try {
        await new RuntimePreflightCli(runner, {
            PI_CODING_AGENT_DIR: sourceAgentDir,
        }).probeProvider({
            lane: "worker",
            cwd: "/repo",
            piBin: "/opt/pi",
            agentDir: isolatedAgentDir,
            credentialAgentDir: sourceAgentDir,
            credentialMode: "canonical-oauth",
            rpcHost,
            roleArgv: [
                "--no-approve",
                "--skill", "/private/implement",
                "--provider", "provider-a",
                "--model", "model-a",
                "--tools", "read,bash,write",
                "--thinking", "max",
            ],
        });
        assert.deepEqual(runner.calls, [{
                command: process.execPath,
                args: [
                    rpcHost.path,
                    "--pi-executable", "/opt/pi",
                    "--expected-version", "0.84.0",
                    "--credential-mode", "canonical-oauth",
                    "--credential-agent-dir", sourceAgentDir,
                    "--private-agent-dir", isolatedAgentDir,
                    "--probe-message", "Reply with exactly HERDR_HARNESS_PROVIDER_OK",
                    "--",
                    "--no-session", "--no-approve", "--no-skills", "--no-extensions",
                    "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-tools",
                    "--provider", "provider-a", "--model", "model-a", "--thinking", "max",
                ],
                cwd: "/repo",
                timeoutMs: 120_000,
                env: { PI_CODING_AGENT_DIR: isolatedAgentDir },
            }]);
        assert.equal(readFileSync(join(sourceAgentDir, "auth.json"), "utf8"), '{"oauth":"must-not-share"}\n');
        assert.equal(existsSync(join(isolatedAgentDir, "auth.json")), false);
        assert.equal(existsSync(join(isolatedAgentDir, "models.json")), false);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("Provider preflight rejects a successful process with no model marker", async () => {
    const runner = new RecordingRunner([ok("provider banner only\n")]);
    await assert.rejects(() => new RuntimePreflightCli(runner, {}).probeProvider({
        lane: "reviewer",
        cwd: "/repo",
        piBin: "pi",
        roleArgv: ["--thinking", "max"],
    }), /no success marker/);
});
test("RPC Reviewer preflight passes one bound canonical models.json to the SDK host", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-reviewer-rpc-preflight-"));
    const credentialAgentDir = join(root, "credential-agent");
    const isolatedAgentDir = join(root, "runtime", "pi-agent");
    const rpcHost = createRpcHost(root);
    mkdirSync(credentialAgentDir);
    const modelsPath = join(credentialAgentDir, "models.json");
    writeFileSync(modelsPath, '{"providers":{}}\n', { mode: 0o600 });
    const modelConfig = executionResource("model-config", modelsPath);
    const runner = new RecordingRunner([ok("HERDR_HARNESS_PROVIDER_OK\n")]);
    try {
        await new RuntimePreflightCli(runner, {}).probeProvider({
            lane: "reviewer",
            cwd: "/repo",
            piBin: "/opt/pi",
            agentDir: isolatedAgentDir,
            credentialAgentDir,
            credentialMode: "canonical-model-config",
            modelConfig,
            rpcHost,
            roleArgv: ["--provider", "custom", "--model", "review-model", "--thinking", "max"],
        });
        assert.deepEqual(runner.calls[0]?.args.slice(0, 15), [
            rpcHost.path,
            "--pi-executable", "/opt/pi",
            "--expected-version", "0.84.0",
            "--credential-mode", "canonical-model-config",
            "--credential-agent-dir", credentialAgentDir,
            "--model-config-path", modelConfig.path,
            "--model-config-digest", modelConfig.digest,
            "--private-agent-dir", isolatedAgentDir,
        ]);
        assert.equal(existsSync(join(isolatedAgentDir, "models.json")), false);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("RPC Provider preflight rejects credentials persisted into private auth", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-pi-rpc-auth-write-"));
    const sourceAgentDir = join(root, "source-agent");
    const isolatedAgentDir = join(root, "runtime", "pi-agent");
    const rpcHost = createRpcHost(root);
    mkdirSync(sourceAgentDir);
    writeFileSync(join(sourceAgentDir, "auth.json"), "{}\n", { mode: 0o600 });
    const runner = new RecordingRunner([ok("HERDR_HARNESS_PROVIDER_OK\n")], () => {
        const authPath = join(isolatedAgentDir, "auth.json");
        writeFileSync(authPath, '{"oauth":"persisted"}\n', { mode: 0o600 });
    });
    try {
        await assert.rejects(() => new RuntimePreflightCli(runner, {}).probeProvider({
            lane: "worker",
            cwd: "/repo",
            piBin: "/opt/pi",
            agentDir: isolatedAgentDir,
            credentialAgentDir: sourceAgentDir,
            credentialMode: "canonical-oauth",
            rpcHost,
            roleArgv: ["--provider", "provider-a", "--model", "model-a", "--thinking", "max"],
        }), /must not contain auth\.json/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("Docker preflight binds the active local Unix socket and proves daemon plus Compose V2", async () => {
    const runner = new RecordingRunner([
        ok('[{"Endpoints":{"docker":{"Host":"unix:///tmp/docker.sock"}}}]\n'),
        ok("28.3.2\n"),
        ok("2.39.1\n"),
    ]);
    const result = await new RuntimePreflightCli(runner, {}).probeDocker({ cwd: "/repo" });
    assert.deepEqual(result, { host: "unix:///tmp/docker.sock" });
    assert.deepEqual(runner.calls.map(({ command, args }) => ({ command, args })), [
        { command: "docker", args: ["context", "inspect"] },
        { command: "docker", args: ["--host", "unix:///tmp/docker.sock", "version", "--format", "{{.Server.Version}}"] },
        { command: "docker", args: ["--host", "unix:///tmp/docker.sock", "compose", "version", "--short"] },
    ]);
});
test("Docker preflight refuses remote contexts that would need unbound credentials", async () => {
    const runner = new RecordingRunner([
        ok('[{"Endpoints":{"docker":{"Host":"tcp://example.test:2376"}}}]\n'),
    ]);
    await assert.rejects(() => new RuntimePreflightCli(runner, {}).probeDocker({ cwd: "/repo" }), /requires a local Unix socket/);
    assert.equal(runner.calls.length, 1);
});
function ok(stdout) {
    return { ok: true, code: 0, stdout, stderr: "", error: null };
}
function createRpcHost(root) {
    const directory = join(root, "sdk-host");
    const path = join(directory, "pi-rpc-sdk-entry.js");
    mkdirSync(directory);
    writeFileSync(path, "export {};\n");
    return { kind: "runtime", path, digest: executionResourceDigest(directory) };
}
//# sourceMappingURL=runtime-preflight.test.js.map