#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { executionResourceDigest } from "./attempt-plan.js";
import { preparePiRpcAgentDirAt } from "./pi-rpc-spool.js";

type Model = { provider: string; id: string };
type Diagnostic = { type: "info" | "warning" | "error"; message: string };
type Services = {
  diagnostics: Diagnostic[];
  resourceLoader: { getExtensions(): { errors: Array<{ path: string; error: unknown }> } };
};
type ModelRuntime = {
  getModel(provider: string, model: string): Model | undefined;
  getAuth(model: Model, options: Record<string, unknown>): Promise<{ source?: string } | undefined>;
  isUsingSubscription(provider: string): boolean;
  getProvider(provider: string): { id: string } | undefined;
  registerProvider(provider: string, config: Record<string, unknown>): void;
};
type RuntimeHost = {
  session: {
    prompt(message: string): Promise<void>;
    state: { messages: Array<{ role?: unknown; stopReason?: unknown; content?: unknown }> };
  };
  dispose(): Promise<void>;
};
type PiSdk = {
  VERSION: string;
  ModelRuntime: { create(options: Record<string, unknown>): Promise<ModelRuntime> };
  SettingsManager: { inMemory(settings: Record<string, unknown>, options: Record<string, unknown>): unknown };
  SessionManager: { inMemory(cwd: string): unknown };
  createAgentSessionServices(options: Record<string, unknown>): Promise<Services>;
  createAgentSessionFromServices(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  createAgentSessionRuntime(
    factory: (options: Record<string, unknown>) => Promise<Record<string, unknown>>,
    options: Record<string, unknown>,
  ): Promise<RuntimeHost>;
  runRpcMode(runtime: RuntimeHost): Promise<never>;
};

type HostArgs = {
  piExecutable: string;
  expectedVersion: string;
  credentialMode: "canonical-oauth" | "canonical-model-config";
  credentialAgentDir: string;
  modelConfigPath: string | null;
  modelConfigDigest: string | null;
  privateAgentDir: string;
  probeMessage: string | null;
  piArgv: string[];
};

type RuntimeArgs = {
  provider: string;
  model: string;
  thinking: string;
  tools: string[] | undefined;
  extensions: string[];
  skills: string[];
  appendSystemPrompt: string[];
  noTools: boolean;
};

let failureStage = "arguments";

async function main(argv: string[]): Promise<void> {
  const host = parseHostArgs(argv);
  failureStage = "runtime-arguments";
  if (!isAbsolute(host.credentialAgentDir) || !isAbsolute(host.privateAgentDir)) {
    throw new Error("Pi RPC SDK host requires absolute credential and private agent directories");
  }
  const runtimeArgs = parseRuntimeArgs(host.piArgv, host.probeMessage !== null);
  failureStage = "private-agent";
  const privateAgentDir = preparePiRpcAgentDirAt(host.privateAgentDir);
  if (resolve(process.env.PI_CODING_AGENT_DIR ?? "") !== privateAgentDir) {
    throw new Error("Pi RPC SDK host is not bound to the Attempt-private agent directory");
  }
  failureStage = "credential-binding";
  const credentialAgentDir = resolve(host.credentialAgentDir);
  if (credentialAgentDir === privateAgentDir) throw new Error("Pi RPC credential and private agent directories must differ");
  const authPath = join(credentialAgentDir, "auth.json");
  const assertCredentialInputs = (): void => {
    if (host.credentialMode === "canonical-oauth") {
      if (host.modelConfigPath || host.modelConfigDigest) throw new Error("subscription OAuth RPC must not load models.json");
      // Keep Pi's exact logical path: AuthStorage locks by pathname with realpath:false.
      assertCanonicalAuthFile(authPath);
      return;
    }
    if (!host.modelConfigPath || !host.modelConfigDigest
      || realpathSync(host.modelConfigPath) !== realpathSync(join(credentialAgentDir, "models.json"))) {
      throw new Error("custom-model RPC requires the canonical models.json identity");
    }
    assertCanonicalModelConfig(host.modelConfigPath, host.modelConfigDigest);
  };
  failureStage = "credentials";
  assertCredentialInputs();

  failureStage = "sdk-import";
  const piIndex = join(dirname(realpathSync(host.piExecutable)), "index.js");
  const pi = await import(pathToFileURL(piIndex).href) as PiSdk;
  if (pi.VERSION !== host.expectedVersion) {
    throw new Error(`Pi SDK version changed: expected ${host.expectedVersion}, got ${String(pi.VERSION)}`);
  }
  const cwd = process.cwd();
  const createRuntime = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    failureStage = "model-runtime";
    if (resolve(String(input.cwd)) !== cwd || resolve(String(input.agentDir)) !== privateAgentDir) {
      throw new Error("Pi RPC attempted to replace its bound cwd or agent directory");
    }
    assertCredentialInputs();
    preparePiRpcAgentDirAt(privateAgentDir);
    const settingsManager = pi.SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    }, { projectTrusted: false });
    let modelRuntime: ModelRuntime;
    if (host.credentialMode === "canonical-oauth") {
      modelRuntime = await pi.ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false });
    } else {
      const providerConfig = loadBoundProviderConfig(
        host.modelConfigPath!,
        host.modelConfigDigest!,
        runtimeArgs.provider,
      );
      modelRuntime = await pi.ModelRuntime.create({
        credentials: emptyCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
      });
      if (modelRuntime.getProvider(runtimeArgs.provider)) {
        throw new Error("Reviewer RPC accepts a standalone custom provider, not a built-in provider override");
      }
      modelRuntime.registerProvider(runtimeArgs.provider, providerConfig);
    }
    assertCredentialInputs();
    const model = modelRuntime.getModel(runtimeArgs.provider, runtimeArgs.model);
    if (!model || model.provider !== runtimeArgs.provider || model.id !== runtimeArgs.model) {
      throw new Error(`Pi RPC model is not the exact configured model: ${runtimeArgs.provider}/${runtimeArgs.model}`);
    }
    const auth = await modelRuntime.getAuth(model, {
      minOAuthValidityMs: 5 * 60_000,
      signal: AbortSignal.timeout(15_000),
    });
    if (!auth || (host.credentialMode === "canonical-oauth"
      ? !modelRuntime.isUsingSubscription(runtimeArgs.provider)
      : auth.source !== "configured API key" || modelRuntime.isUsingSubscription(runtimeArgs.provider))) {
      throw new Error(`Pi RPC credential mode does not match provider ${runtimeArgs.provider}`);
    }
    const services = await pi.createAgentSessionServices({
      cwd,
      agentDir: privateAgentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        additionalExtensionPaths: runtimeArgs.extensions,
        additionalSkillPaths: runtimeArgs.skills,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        appendSystemPrompt: runtimeArgs.appendSystemPrompt,
      },
    });
    const diagnostics = [
      ...services.diagnostics,
      ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => ({
        type: "error" as const,
        message: `Failed to load extension "${path}": ${error instanceof Error ? error.message : String(error)}`,
      })),
    ];
    const failures = diagnostics.filter(({ type }) => type === "error");
    if (failures.length > 0) throw new Error(failures.map(({ message }) => message).join("\n"));
    failureStage = "agent-session";
    const created = await pi.createAgentSessionFromServices({
      services,
      sessionManager: input.sessionManager,
      ...(input.sessionStartEvent ? { sessionStartEvent: input.sessionStartEvent } : {}),
      model,
      thinkingLevel: runtimeArgs.thinking,
      ...(runtimeArgs.tools ? { tools: runtimeArgs.tools } : {}),
      ...(runtimeArgs.noTools ? { noTools: "all" } : {}),
    });
    return { ...created, services, diagnostics };
  };

  const runtime = await pi.createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: privateAgentDir,
    sessionManager: pi.SessionManager.inMemory(cwd),
  });
  if (host.probeMessage !== null) {
    failureStage = "provider-probe";
    await runProbe(runtime, host.probeMessage);
    assertCredentialInputs();
    preparePiRpcAgentDirAt(privateAgentDir);
    return;
  }
  failureStage = "rpc-mode";
  await pi.runRpcMode(runtime);
  assertCredentialInputs();
  preparePiRpcAgentDirAt(privateAgentDir);
}

async function runProbe(runtime: RuntimeHost, prompt: string): Promise<void> {
  const marker = /^Reply with exactly ([A-Z0-9_]{1,100})$/u.exec(prompt)?.[1];
  if (!marker) throw new Error("invalid Pi RPC Provider probe");
  try {
    await runtime.session.prompt(prompt);
    const last = runtime.session.state.messages.at(-1);
    const text = Array.isArray(last?.content)
      ? last.content.flatMap((part) => part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("").trim()
      : "";
    if (last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted" || text !== marker) {
      throw new Error("Pi RPC Provider probe failed");
    }
    process.stdout.write(`${marker}\n`);
  } finally {
    await runtime.dispose();
  }
}

function parseHostArgs(argv: string[]): HostArgs {
  const separator = argv.indexOf("--");
  if (separator < 0) throw new Error("Pi RPC SDK host requires -- before Pi arguments");
  const hostArgv = argv.slice(0, separator);
  const read = (name: string, required = true): string | null => {
    const indexes = hostArgv.flatMap((value, index) => value === name ? [index] : []);
    if (indexes.length > 1) throw new Error(`${name} must appear at most once`);
    if (indexes.length === 0) {
      if (required) throw new Error(`${name} is required`);
      return null;
    }
    const value = hostArgv[indexes[0]! + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    return value;
  };
  const allowed = new Set([
    "--pi-executable", "--expected-version", "--credential-mode", "--credential-agent-dir",
    "--model-config-path", "--model-config-digest", "--private-agent-dir", "--probe-message",
  ]);
  for (let index = 0; index < hostArgv.length; index += 2) {
    if (!allowed.has(hostArgv[index]!)) throw new Error(`unsupported Pi RPC SDK host argument: ${hostArgv[index]}`);
  }
  const credentialMode = read("--credential-mode")!;
  if (credentialMode !== "canonical-oauth" && credentialMode !== "canonical-model-config") {
    throw new Error("unsupported Pi RPC credential mode");
  }
  return {
    piExecutable: read("--pi-executable")!,
    expectedVersion: read("--expected-version")!,
    credentialMode,
    credentialAgentDir: read("--credential-agent-dir")!,
    modelConfigPath: read("--model-config-path", false),
    modelConfigDigest: read("--model-config-digest", false),
    privateAgentDir: read("--private-agent-dir")!,
    probeMessage: read("--probe-message", false),
    piArgv: argv.slice(separator + 1),
  };
}

function parseRuntimeArgs(argv: string[], probe: boolean): RuntimeArgs {
  const booleans = new Set([
    "--no-approve", "--no-skills", "--no-session", "--no-extensions", "--no-context-files",
    "--no-prompt-templates", "--no-themes", "--no-tools",
  ]);
  const repeatable = new Set(["--extension", "--skill", "--append-system-prompt"]);
  const single = new Set(["--tools", "--thinking", "--provider", "--model", "--mode"]);
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if (booleans.has(name)) {
      values.set(name, [...(values.get(name) ?? []), "true"]);
      continue;
    }
    if (!repeatable.has(name) && !single.has(name)) throw new Error(`unsupported Pi RPC argument: ${name}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  const one = (name: string): string => {
    const found = values.get(name) ?? [];
    if (found.length !== 1) throw new Error(`Pi RPC requires exactly one ${name}`);
    return found[0]!;
  };
  for (const name of ["--no-approve", "--no-skills", "--no-session", "--no-extensions", "--no-context-files", "--no-prompt-templates", "--no-themes"]) {
    one(name);
  }
  if (!probe && one("--mode") !== "rpc") throw new Error("Pi RPC SDK host requires --mode rpc");
  if (probe && values.has("--mode")) throw new Error("Pi RPC Provider probe must not select RPC mode");
  const tools = values.has("--tools") ? one("--tools").split(",").map((value) => value.trim()).filter(Boolean) : undefined;
  const noTools = values.has("--no-tools");
  if (probe !== noTools || (!probe && (!tools || tools.length === 0))) {
    throw new Error(probe ? "Pi RPC Provider probe requires --no-tools" : "Pi RPC Worker requires an explicit tool allowlist");
  }
  return {
    provider: one("--provider"),
    model: one("--model"),
    thinking: one("--thinking"),
    tools,
    extensions: values.get("--extension") ?? [],
    skills: values.get("--skill") ?? [],
    appendSystemPrompt: values.get("--append-system-prompt") ?? [],
    noTools,
  };
}

function assertCanonicalAuthFile(path: string): void {
  if (!existsSync(path)) throw new Error(`Pi subscription OAuth is not logged in: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    throw new Error("Pi subscription OAuth auth.json must be a private regular file at its canonical path");
  }
}

function assertCanonicalModelConfig(path: string, expectedDigest: string): void {
  if (!isAbsolute(path) || !/^[0-9a-f]{64}$/i.test(expectedDigest) || !existsSync(path)) {
    throw new Error("canonical models.json is missing or unbound");
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    throw new Error("models.json must be a private regular single-link file");
  }
  if (executionResourceDigest(path) !== expectedDigest) throw new Error("models.json changed after Attempt preparation");
}

function loadBoundProviderConfig(
  path: string,
  expectedDigest: string,
  provider: string,
): Record<string, unknown> {
  const content = readFileSync(path, "utf8");
  if (modelConfigContentDigest(content) !== expectedDigest) {
    throw new Error("models.json bytes differ from the Attempt snapshot");
  }
  const root = exactObject(JSON.parse(content) as unknown, ["providers"], "root");
  const selected = exactObject(object(root.providers)[provider], [
    "name", "baseUrl", "apiKey", "api", "headers", "compat", "authHeader", "models", "modelOverrides",
  ], `provider ${provider}`);
  const definitions = selected.models;
  if (!Array.isArray(definitions) || definitions.length === 0) {
    throw new Error(`Reviewer RPC provider ${provider} requires explicit models`);
  }
  const overrides = selected.modelOverrides === undefined ? {} : object(selected.modelOverrides);
  const normalizedOverrides = new Map(Object.entries(overrides).map(([id, value]) => [id, normalizeModelOverride(value, id)]));
  const providerApi = requiredString(selected, "api");
  const providerBaseUrl = requiredString(selected, "baseUrl");
  const models: Record<string, unknown>[] = [];
  for (const value of definitions) {
    const definition = normalizeModelDefinition(value, selected, providerApi, providerBaseUrl, normalizedOverrides);
    if (models.some((model) => model.id === definition.id)) throw new Error(`models.json has duplicate model ${String(definition.id)}`);
    models.push(definition);
  }
  return deepFreeze({
    ...(optionalString(selected, "name") ? { name: optionalString(selected, "name") } : {}),
    baseUrl: providerBaseUrl,
    apiKey: requiredString(selected, "apiKey"),
    api: providerApi,
    ...(selected.headers === undefined ? {} : { headers: stringMap(selected.headers, "provider headers") }),
    ...(selected.authHeader === undefined ? {} : { authHeader: requiredBoolean(selected, "authHeader") }),
    models,
  });
}

function normalizeModelDefinition(
  value: unknown,
  providerConfig: Record<string, unknown>,
  providerApi: string,
  providerBaseUrl: string,
  overrides: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
  const definition = exactObject(value, [
    "id", "name", "api", "baseUrl", "reasoning", "thinkingLevelMap", "input", "cost",
    "contextWindow", "maxTokens", "samplingParams", "headers", "compat",
  ], "model");
  const id = requiredString(definition, "id");
  const override = overrides.get(id) ?? {};
  const api = optionalString(definition, "api") ?? providerApi;
  const baseUrl = optionalString(definition, "baseUrl") ?? providerBaseUrl;
  const cost = definition.cost === undefined
    ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    : costObject(definition.cost, false);
  const overrideCost = override.cost === undefined ? undefined : costObject(override.cost, true);
  const thinking = mergeRecord(
    definition.thinkingLevelMap === undefined ? undefined : thinkingMap(definition.thinkingLevelMap),
    override.thinkingLevelMap === undefined ? undefined : thinkingMap(override.thinkingLevelMap),
  );
  const sampling = mergeRecord(
    definition.samplingParams === undefined ? undefined : object(definition.samplingParams),
    override.samplingParams === undefined ? undefined : object(override.samplingParams),
  );
  const headers = {
    ...(override.headers === undefined ? {} : stringMap(override.headers, `model ${id} override headers`)),
    ...(definition.headers === undefined ? {} : stringMap(definition.headers, `model ${id} headers`)),
  };
  const compat = mergeCompat(
    mergeCompat(
      providerConfig.compat === undefined ? undefined : compatObject(providerConfig.compat, "provider compat"),
      definition.compat === undefined ? undefined : compatObject(definition.compat, `model ${id} compat`),
    ),
    override.compat === undefined ? undefined : compatObject(override.compat, `model ${id} override compat`),
  );
  return {
    id,
    name: optionalString(override, "name") ?? optionalString(definition, "name") ?? id,
    api,
    baseUrl,
    reasoning: optionalBoolean(override, "reasoning") ?? optionalBoolean(definition, "reasoning") ?? false,
    ...(thinking ? { thinkingLevelMap: thinking } : {}),
    input: override.input === undefined
      ? definition.input === undefined ? ["text"] : inputArray(definition.input, id)
      : inputArray(override.input, id),
    cost: { ...cost, ...overrideCost },
    contextWindow: positiveNumber(override, "contextWindow") ?? positiveNumber(definition, "contextWindow") ?? 128000,
    maxTokens: positiveNumber(override, "maxTokens") ?? positiveNumber(definition, "maxTokens") ?? 16384,
    ...(sampling ? { samplingParams: sampling } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(compat ? { compat } : {}),
  };
}

function normalizeModelOverride(value: unknown, id: string): Record<string, unknown> {
  const override = exactObject(value, [
    "name", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens",
    "samplingParams", "headers", "compat",
  ], `model override ${id}`);
  optionalString(override, "name");
  optionalBoolean(override, "reasoning");
  if (override.thinkingLevelMap !== undefined) thinkingMap(override.thinkingLevelMap);
  if (override.input !== undefined) inputArray(override.input, id);
  if (override.cost !== undefined) costObject(override.cost, true);
  positiveNumber(override, "contextWindow");
  positiveNumber(override, "maxTokens");
  if (override.samplingParams !== undefined) object(override.samplingParams);
  if (override.headers !== undefined) stringMap(override.headers, `model ${id} override headers`);
  if (override.compat !== undefined) compatObject(override.compat, `model ${id} override compat`);
  return override;
}

function modelConfigContentDigest(content: string): string {
  const hash = createHash("sha256");
  hash.update(".\0");
  hash.update(content);
  hash.update("\0");
  return hash.digest("hex");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("models.json has an invalid object shape");
  return value as Record<string, unknown>;
}

function exactObject(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  const record = object(value);
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`models.json ${label} has unsupported field ${key}`);
  }
  return record;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`models.json ${key} must be a non-empty string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  return record[key] === undefined ? undefined : requiredString(record, key);
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`models.json ${key} must be boolean`);
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  return record[key] === undefined ? undefined : requiredBoolean(record, key);
}

function positiveNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`models.json ${key} must be positive`);
  return value;
}

function stringMap(value: unknown, label: string): Record<string, string> {
  const record = object(value);
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") throw new Error(`models.json ${label}.${key} must be string`);
  }
  return record as Record<string, string>;
}

function inputArray(value: unknown, id: string): Array<"text" | "image"> {
  if (!Array.isArray(value) || value.some((entry) => entry !== "text" && entry !== "image")) {
    throw new Error(`models.json model ${id} input is invalid`);
  }
  return value as Array<"text" | "image">;
}

function thinkingMap(value: unknown): Record<string, string | null> {
  const record = exactObject(value, ["off", "minimal", "low", "medium", "high", "xhigh", "max"], "thinkingLevelMap");
  for (const [key, entry] of Object.entries(record)) {
    if (entry !== null && typeof entry !== "string") throw new Error(`models.json thinkingLevelMap.${key} is invalid`);
  }
  return record as Record<string, string | null>;
}

function costObject(value: unknown, partial: boolean): Record<string, unknown> {
  const record = exactObject(value, ["input", "output", "cacheRead", "cacheWrite", "tiers"], "cost");
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    const entry = record[key];
    if ((!partial || entry !== undefined) && (typeof entry !== "number" || !Number.isFinite(entry))) {
      throw new Error(`models.json cost.${key} must be numeric`);
    }
  }
  if (record.tiers !== undefined) {
    if (!Array.isArray(record.tiers)) throw new Error("models.json cost.tiers must be an array");
    for (const tier of record.tiers) {
      const entry = exactObject(tier, ["input", "output", "cacheRead", "cacheWrite", "inputTokensAbove"], "cost tier");
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "inputTokensAbove"]) {
        if (typeof entry[key] !== "number" || !Number.isFinite(entry[key])) throw new Error(`models.json cost tier ${key} must be numeric`);
      }
    }
  }
  return record;
}

function mergeRecord(base: Record<string, unknown> | undefined, override: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!base && !override) return undefined;
  return { ...base, ...override };
}

function compatObject(value: unknown, label: string): Record<string, unknown> {
  const record = exactObject(value, [
    "supportsStore", "supportsDeveloperRole", "requiresReasoningContentOnAssistantMessages", "thinkingFormat",
  ], label);
  for (const key of ["supportsStore", "supportsDeveloperRole", "requiresReasoningContentOnAssistantMessages"]) {
    if (record[key] !== undefined) requiredBoolean(record, key);
  }
  if (record.thinkingFormat !== undefined) {
    const format = requiredString(record, "thinkingFormat");
    if (!["openai", "openrouter", "together", "baseten", "deepseek", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"].includes(format)) {
      throw new Error("models.json thinkingFormat is unsupported");
    }
  }
  return record;
}

function mergeCompat(base: Record<string, unknown> | undefined, override: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return mergeRecord(base, override);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function emptyCredentialStore(): Record<string, unknown> {
  return {
    read: async () => undefined,
    list: async () => [],
    modify: async () => { throw new Error("custom-model RPC credentials are read-only"); },
    delete: async () => { throw new Error("custom-model RPC credentials are read-only"); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write(`FAIL: Pi RPC SDK host failed at ${failureStage}\n`);
    process.exitCode = 1;
  });
}
