export function fakePiSdkSource(): string {
  return `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
        if (process.env.FAKE_PI_SDK_OAUTH_LOCK_CONTENTION) throw new Error("OAuth lock contention access_token_SENTINEL");
        if (process.env.FAKE_PI_SDK_AUTH_TIMEOUT) { const error = new Error("refresh timeout access_token_SENTINEL"); error.name = "TimeoutError"; throw error; }
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
      state.promptCount = (state.promptCount ?? 0) + 1;
      if (process.env.FAKE_PI_SDK_INIT_DEFAULT_STORES) {
        const agentDir = process.env.PI_CODING_AGENT_DIR;
        mkdirSync(agentDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(agentDir, "auth.json"), process.env.FAKE_PI_SDK_DEFAULT_AUTH_CONTENT ?? "{}", { mode: 0o600 });
        writeFileSync(join(agentDir, "models-store.json"), "{}", { mode: 0o600 });
        state.defaultStoreAgentDir = agentDir;
      }
      if (process.env.FAKE_PI_SDK_PROBE_FAIL) throw new Error("probe failed access_token_SENTINEL");
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
