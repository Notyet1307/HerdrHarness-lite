import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SyncCommandRunner } from "../src/adapters/command.js";
test("Pi RPC SDK host shares only canonical subscription OAuth and keeps settings in memory", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-pi-sdk-"));
    const dist = join(root, "pi", "dist");
    const oauthAgentDir = join(root, "oauth-agent");
    const privateAgentDir = join(root, "attempt", "pi-agent");
    const capturePath = join(root, "capture.json");
    mkdirSync(dist, { recursive: true });
    mkdirSync(join(dist, "core"));
    mkdirSync(oauthAgentDir);
    writeFileSync(join(root, "pi", "package.json"), '{"type":"module"}\n');
    writeFileSync(join(dist, "cli.js"), "#!/usr/bin/env node\n", { mode: 0o700 });
    writeFileSync(join(dist, "index.js"), fakePiSdk());
    writeFileSync(join(dist, "core", "http-dispatcher.js"), "export function configureHttpDispatcher() {}\n");
    const authPath = join(oauthAgentDir, "auth.json");
    const authBefore = '{"openai-codex":{"type":"oauth"}}\n';
    writeFileSync(authPath, authBefore, { mode: 0o600 });
    try {
        const commandArgs = [
            resolve("dist/src/pi-rpc-sdk-entry.js"),
            "--pi-executable", join(dist, "cli.js"),
            "--expected-version", "0.84.0",
            "--oauth-agent-dir", oauthAgentDir,
            "--private-agent-dir", privateAgentDir,
            "--probe-message", "Reply with exactly HERDR_HARNESS_PROVIDER_OK",
            "--",
            "--no-session", "--no-approve", "--no-skills", "--no-extensions",
            "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-tools",
            "--provider", "openai-codex", "--model", "gpt-test", "--thinking", "high",
        ];
        const runner = new SyncCommandRunner();
        const options = {
            cwd: root,
            env: { ...process.env, PI_CODING_AGENT_DIR: privateAgentDir, FAKE_PI_SDK_CAPTURE: capturePath },
            timeoutMs: 10_000,
        };
        const result = runner.run(process.execPath, commandArgs, options);
        assert.equal(result.ok, true, result.stderr);
        assert.match(result.stdout, /HERDR_HARNESS_PROVIDER_OK/);
        const capture = JSON.parse(readFileSync(capturePath, "utf8"));
        assert.deepEqual(capture.modelOptions, {
            authPath,
            modelsPath: null,
            allowModelNetwork: false,
        });
        assert.deepEqual(capture.settings, {
            values: { retry: { enabled: false }, compaction: { enabled: false } },
            options: { projectTrusted: false },
        });
        assert.equal(capture.authChecked, true);
        assert.equal(readFileSync(authPath, "utf8"), authBefore);
        assert.equal(existsSync(join(privateAgentDir, "auth.json")), false);
        assert.equal(existsSync(join(privateAgentDir, "models.json")), false);
        assert.equal(existsSync(join(privateAgentDir, "settings.json")), false);
        const sentinel = "refresh_token_SENTINEL";
        const authFailure = runner.run(process.execPath, commandArgs, {
            ...options,
            env: { ...options.env, FAKE_PI_SDK_AUTH_ERROR: sentinel },
        });
        assert.equal(authFailure.ok, false);
        assert.equal(authFailure.stderr.includes(sentinel), false);
        linkSync(authPath, join(root, "auth-hardlink.json"));
        const rejected = runner.run(process.execPath, commandArgs, options);
        assert.equal(rejected.ok, false);
        assert.match(rejected.stderr, /Pi RPC SDK host failed/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
function fakePiSdk() {
    return `
import { writeFileSync } from "node:fs";
export const VERSION = "0.84.0";
const state = {};
export const SettingsManager = {
  inMemory(values, options) {
    state.settings = { values, options };
    return { kind: "settings" };
  },
};
export const ModelRuntime = {
  async create(options) {
    state.modelOptions = options;
    return {
      getModel(provider, id) { return { provider, id }; },
      async getAuth() {
        if (process.env.FAKE_PI_SDK_AUTH_ERROR) throw new Error(process.env.FAKE_PI_SDK_AUTH_ERROR);
        state.authChecked = true;
        return { auth: { token: "redacted" } };
      },
      isUsingSubscription() { return true; },
    };
  },
};
export const SessionManager = { inMemory(cwd) { return { cwd }; } };
export async function createAgentSessionServices() {
  return { diagnostics: [], resourceLoader: { getExtensions() { return { errors: [] }; } } };
}
export async function createAgentSessionFromServices() {
  const session = {
    state: { messages: [] },
    async prompt() {
      session.state.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "HERDR_HARNESS_PROVIDER_OK" }] });
    },
  };
  return { session };
}
export async function createAgentSessionRuntime(factory, options) {
  const runtime = await factory(options);
  return {
    ...runtime,
    async dispose() { writeFileSync(process.env.FAKE_PI_SDK_CAPTURE, JSON.stringify(state)); },
  };
}
export async function runRpcMode() { throw new Error("not used"); }
`;
}
//# sourceMappingURL=pi-rpc-sdk-entry.test.js.map