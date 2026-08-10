import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SyncCommandRunner } from "../src/adapters/command.js";
import { executionResourceDigest } from "../src/attempt-plan.js";
test("Pi RPC SDK host shares only canonical subscription OAuth and keeps settings in memory", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-pi-sdk-"));
    const dist = join(root, "pi", "dist");
    const oauthAgentDir = join(root, "oauth-agent");
    const privateAgentDir = join(root, "attempt", "pi-agent");
    const capturePath = join(root, "capture.json");
    mkdirSync(dist, { recursive: true });
    mkdirSync(oauthAgentDir);
    writeFileSync(join(root, "pi", "package.json"), '{"type":"module"}\n');
    writeFileSync(join(dist, "cli.js"), "#!/usr/bin/env node\n", { mode: 0o700 });
    writeFileSync(join(dist, "index.js"), fakePiSdk());
    const authPath = join(oauthAgentDir, "auth.json");
    const authBefore = '{"openai-codex":{"type":"oauth"}}\n';
    writeFileSync(authPath, authBefore, { mode: 0o600 });
    try {
        const commandArgs = [
            resolve("dist/src/pi-rpc-sdk-entry.js"),
            "--pi-executable", join(dist, "cli.js"),
            "--expected-version", "0.84.0",
            "--credential-mode", "canonical-oauth",
            "--credential-agent-dir", oauthAgentDir,
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
test("Pi RPC SDK host reads one bound custom models.json without copying its API key", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-pi-sdk-models-"));
    const dist = join(root, "pi", "dist");
    const credentialAgentDir = join(root, "credential-agent");
    const privateAgentDir = join(root, "attempt", "pi-agent");
    const capturePath = join(root, "capture.json");
    mkdirSync(dist, { recursive: true });
    mkdirSync(credentialAgentDir);
    writeFileSync(join(root, "pi", "package.json"), '{"type":"module"}\n');
    writeFileSync(join(dist, "cli.js"), "#!/usr/bin/env node\n", { mode: 0o700 });
    writeFileSync(join(dist, "index.js"), fakePiSdk());
    const modelsPath = join(credentialAgentDir, "models.json");
    const secret = "CUSTOM_API_KEY_SENTINEL";
    const trustedBaseUrl = "https://trusted.invalid/v1";
    const modelsContent = `{"providers":{"custom":{"api":"openai-completions","apiKey":"${secret}","baseUrl":"${trustedBaseUrl}","compat":{"supportsStore":false},"models":[{"id":"custom-model"}],"modelOverrides":{"custom-model":{"contextWindow":64000,"compat":{"supportsDeveloperRole":false}}}}}}\n`;
    writeFileSync(modelsPath, modelsContent, { mode: 0o600 });
    const modelDigest = executionResourceDigest(modelsPath);
    const commandArgs = [
        resolve("dist/src/pi-rpc-sdk-entry.js"),
        "--pi-executable", join(dist, "cli.js"),
        "--expected-version", "0.84.0",
        "--credential-mode", "canonical-model-config",
        "--credential-agent-dir", credentialAgentDir,
        "--model-config-path", modelsPath,
        "--model-config-digest", modelDigest,
        "--private-agent-dir", privateAgentDir,
        "--probe-message", "Reply with exactly HERDR_HARNESS_PROVIDER_OK",
        "--",
        "--no-session", "--no-approve", "--no-skills", "--no-extensions",
        "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-tools",
        "--provider", "custom", "--model", "custom-model", "--thinking", "max",
    ];
    const options = {
        cwd: root,
        env: { ...process.env, PI_CODING_AGENT_DIR: privateAgentDir, FAKE_PI_SDK_CAPTURE: capturePath },
        timeoutMs: 10_000,
    };
    try {
        const runner = new SyncCommandRunner();
        const result = runner.run(process.execPath, commandArgs, options);
        assert.equal(result.ok, true, result.stderr);
        const capture = JSON.parse(readFileSync(capturePath, "utf8"));
        assert.equal(capture.modelOptions.modelsPath, null);
        assert.equal(capture.modelOptions.modelsStorePath, undefined);
        assert.equal(capture.modelOptions.authPath, undefined);
        assert.equal(capture.registeredProvider, "custom");
        assert.equal(capture.registeredBaseUrl, trustedBaseUrl);
        assert.deepEqual(capture.registeredModel, {
            id: "custom-model",
            name: "custom-model",
            api: "openai-completions",
            provider: "custom",
            baseUrl: trustedBaseUrl,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 64000,
            maxTokens: 16384,
            compat: { supportsStore: false, supportsDeveloperRole: false },
        });
        assert.equal(result.stdout.includes(secret) || result.stderr.includes(secret), false);
        assert.equal(existsSync(join(privateAgentDir, "models.json")), false);
        assert.equal(existsSync(join(privateAgentDir, "auth.json")), false);
        const swapped = runner.run(process.execPath, commandArgs, {
            ...options,
            env: {
                ...options.env,
                FAKE_PI_SDK_SWAP_MODEL_PATH: modelsPath,
                FAKE_PI_SDK_SWAP_MODEL_CONTENT: '{"providers":{"custom":{"api":"openai-completions","apiKey":"EVIL","baseUrl":"https://evil.invalid/v1","models":[{"id":"custom-model"}]}}}\n',
            },
        });
        assert.equal(swapped.ok, true, swapped.stderr);
        assert.equal(JSON.parse(readFileSync(capturePath, "utf8")).registeredBaseUrl, trustedBaseUrl);
        assert.equal(readFileSync(modelsPath, "utf8"), modelsContent);
        writeFileSync(modelsPath, `{"providers":{"custom":{"api":"openai-completions","apiKey":"${secret}","baseUrl":"${trustedBaseUrl}","models":[{"id":"custom-model"}],"unsupported":true}}}\n`, { mode: 0o600 });
        const unsupportedArgs = [...commandArgs];
        unsupportedArgs[unsupportedArgs.indexOf("--model-config-digest") + 1] = executionResourceDigest(modelsPath);
        const unsupported = runner.run(process.execPath, unsupportedArgs, options);
        assert.equal(unsupported.ok, false);
        assert.equal(unsupported.stderr.includes(secret), false);
        for (const compat of [{ unknownFlag: true }, { supportsDeveloperRole: "yes" }]) {
            writeFileSync(modelsPath, `${JSON.stringify({
                providers: { custom: {
                        api: "openai-completions", apiKey: secret, baseUrl: trustedBaseUrl,
                        compat, models: [{ id: "custom-model" }],
                    } },
            })}\n`, { mode: 0o600 });
            const invalidCompatArgs = [...commandArgs];
            invalidCompatArgs[invalidCompatArgs.indexOf("--model-config-digest") + 1] = executionResourceDigest(modelsPath);
            const invalidCompat = runner.run(process.execPath, invalidCompatArgs, options);
            assert.equal(invalidCompat.ok, false);
            assert.equal(invalidCompat.stderr.includes(secret), false);
        }
        writeFileSync(modelsPath, '{"providers":{}}\n', { mode: 0o600 });
        const drifted = runner.run(process.execPath, commandArgs, options);
        assert.equal(drifted.ok, false);
        assert.equal(drifted.stderr.includes(secret), false);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
function fakePiSdk() {
    return `
import { readFileSync, writeFileSync } from "node:fs";
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
    let registered = false;
    let registeredModels = [];
    return {
      getModel(provider, id) { return registeredModels.find((model) => model.provider === provider && model.id === id) ?? { provider, id }; },
      getProvider() { return undefined; },
      async getAuth() {
        if (process.env.FAKE_PI_SDK_AUTH_ERROR) throw new Error(process.env.FAKE_PI_SDK_AUTH_ERROR);
        state.authChecked = true;
        return registered ? { source: "configured API key", auth: { token: "redacted" } } : { auth: { token: "redacted" } };
      },
      isUsingSubscription() { return !registered; },
      registerProvider(provider, config) {
        const canonical = process.env.FAKE_PI_SDK_SWAP_MODEL_PATH;
        if (canonical) {
          const original = readFileSync(canonical, "utf8");
          writeFileSync(canonical, process.env.FAKE_PI_SDK_SWAP_MODEL_CONTENT, { mode: 0o600 });
          writeFileSync(canonical, original, { mode: 0o600 });
        }
        registered = true;
        registeredModels = config.models.map((model) => ({ ...model, provider }));
        state.registeredProvider = provider;
        state.registeredBaseUrl = config.baseUrl;
        state.registeredModel = registeredModels[0];
      },
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