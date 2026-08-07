import test from "node:test";
import assert from "node:assert/strict";
import { RuntimePreflightCli } from "../src/adapters/runtime-preflight.js";
class RecordingRunner {
    responses;
    calls = [];
    constructor(responses) {
        this.responses = responses;
    }
    run(command, args, options = {}) {
        this.calls.push({ command, args: [...args], ...options });
        const response = this.responses.shift();
        if (!response)
            throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        return response;
    }
}
test("Provider preflight runs a bounded isolated live probe with only runtime selectors", async () => {
    const runner = new RecordingRunner([ok("HERDR_HARNESS_PROVIDER_OK\n")]);
    await new RuntimePreflightCli(runner, {}).probeProvider({
        lane: "worker",
        cwd: "/repo",
        piBin: "/opt/pi",
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
            command: "/opt/pi",
            args: [
                "--no-session", "--no-approve", "--no-skills", "--no-extensions",
                "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-tools",
                "--provider", "provider-a", "--model", "model-a", "--thinking", "max",
                "-p", "Reply with exactly HERDR_HARNESS_PROVIDER_OK",
            ],
            cwd: "/repo",
            timeoutMs: 120_000,
        }]);
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
//# sourceMappingURL=runtime-preflight.test.js.map