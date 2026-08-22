import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SyncCommandRunner } from "../src/adapters/command.js";
import { executionResourceDigest } from "../src/attempt-plan.js";
import { QUALIFIED_PI_RPC_VERSIONS } from "../src/compatibility.js";
import {
  MAX_UNKNOWN_PI_RPC_EVENT_BYTES,
  PI_RPC_EVENT_CONTRACT,
  type PiRpcEventClassification,
} from "../src/pi-rpc-events.js";
import { fakePiSdkSource } from "./fixtures/fake-pi-sdk.js";
import {
  installWorkerContextControls,
  projectPiRpcEvent,
  withProjectedPiRpcEvents,
} from "../src/pi-rpc-sdk-entry.js";
import { StrictJsonlDecoder } from "../src/pi-rpc-runner.js";

test("Pi RPC event adapter bounds a large agent_end without mutating Pi session data", () => {
  const sentinel = "FULL_TRANSCRIPT_SENTINEL";
  const event = {
    type: "agent_end",
    willRetry: false,
    messages: [
      { role: "assistant", content: [{ type: "text", text: sentinel }] },
      { role: "toolResult", content: [{ type: "text", text: "x".repeat(1024 * 1024) }] },
    ],
  };

  const projected = projectPiRpcEvent(event, "0.84.2");
  const line = `${JSON.stringify(projected)}\n`;

  assert.equal(new StrictJsonlDecoder().push(line).length, 1);
  assert.ok(Buffer.byteLength(line) < 1024 * 1024);
  assert.deepEqual(projected, {
    type: "agent_end",
    willRetry: false,
    messageCount: 2,
    roleCounts: { assistant: 1, toolResult: 1, other: 0 },
    payloadBytes: Buffer.byteLength(JSON.stringify(event)),
    payloadDigest: projected.payloadDigest,
  });
  assert.match(String(projected.payloadDigest), /^[0-9a-f]{64}$/);
  assert.equal(line.includes(sentinel), false);
  assert.equal(event.messages[0]?.content[0]?.text, sentinel);
  assert.equal(event.messages[1]?.content[0]?.text.length, 1024 * 1024);
});

test("Pi RPC event adapter keeps Pi 0.84.2 message_update serialization fields", () => {
  const event = {
    type: "message_update",
    message: {
      role: "assistant",
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
      content: [{ type: "text", text: "PRIVATE_CUMULATIVE_SNAPSHOT" }],
    },
    assistantMessageEvent: {
      type: "text_delta",
      delta: "safe delta",
      partial: "PRIVATE_PARTIAL_SNAPSHOT",
    },
  };

  const projected = projectPiRpcEvent(event, "0.84.2");
  const message = projected.message as Record<string, unknown>;
  assert.equal(message.role, "assistant");
  assert.deepEqual(message.usage, event.message.usage);
  assert.equal((projected.assistantMessageEvent as Record<string, unknown>).type, "text_delta");
  assert.equal((projected.assistantMessageEvent as Record<string, unknown>).partial, undefined);
  assert.equal(projected.assistantContentObserved, true);
  assert.equal(projected.toolCallObserved, false);
  assert.equal(JSON.stringify(projected).includes("PRIVATE_"), false);
});

test("Pi RPC event adapter projects tool-call observation without tool arguments", () => {
  const projected = projectPiRpcEvent({
    type: "message_start",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: { token: "PRIVATE_TOOL_ARGUMENT" } }],
    },
  }, "0.84.2");
  assert.equal(projected.assistantContentObserved, false);
  assert.equal(projected.toolCallObserved, true);
  assert.equal(JSON.stringify(projected).includes("PRIVATE_TOOL_ARGUMENT"), false);
});

test("Pi RPC event adapter strips controlled compaction summary content", () => {
  const event = {
    type: "compaction_end",
    source: "harness-controlled",
    reason: "threshold",
    count: 1,
    triggerPercent: 75,
    willRetry: false,
    outcome: "completed",
    tokensBefore: 96_000,
    estimatedTokensAfter: 18_000,
    summaryDigest: "a".repeat(64),
    result: { summary: "PRIVATE_COMPACTION_SUMMARY" },
  };

  const projected = projectPiRpcEvent(event, "0.84.2");

  assert.equal(projected.type, "compaction_end");
  assert.equal(projected.source, "harness-controlled");
  assert.equal(projected.reason, "threshold");
  assert.equal(projected.willRetry, false);
  assert.equal(projected.summaryDigest, "a".repeat(64));
  assert.equal(JSON.stringify(projected).includes("PRIVATE_COMPACTION_SUMMARY"), false);
  assert.equal(projected.result, undefined);
});

test("Pi RPC event adapter strips forbidden payloads and keeps only validated UI cleanup fields", () => {
  const retry = projectPiRpcEvent({
    type: "auto_retry_start",
    privatePayload: "PRIVATE_RETRY_PAYLOAD",
  }, "0.84.2");
  assert.equal(retry.type, "auto_retry_start");
  assert.equal(retry.privatePayload, undefined);
  assert.match(String(retry.payloadDigest), /^[0-9a-f]{64}$/u);

  const ui = projectPiRpcEvent({
    type: "extension_ui_request",
    id: "cleanup",
    method: "setWidget",
    widgetKey: "subagent-async",
    privatePayload: "PRIVATE_UI_PAYLOAD",
  }, "0.84.2");
  assert.equal(ui.id, "cleanup");
  assert.equal(ui.method, "setWidget");
  assert.equal(ui.widgetKey, "subagent-async");
  assert.equal(ui.privatePayload, undefined);
  assert.match(String(ui.payloadDigest), /^[0-9a-f]{64}$/u);
});

test("qualified Pi versions pin explicit known and unknown event contracts", () => {
  const fixture = JSON.parse(readFileSync(resolve("test/fixtures/pi-rpc-event-contract.json"), "utf8")) as {
    version: number;
    qualifiedVersions: Record<string, string>;
    contracts: Record<string, Partial<Record<PiRpcEventClassification, string[]>>>;
    unknownCases: Array<{
      name: string;
      event: Record<string, unknown>;
      classification: "unknown-safe" | "unknown-unsafe";
    }>;
  };
  const knownClasses: PiRpcEventClassification[] = ["observational", "progress", "authority-changing", "forbidden"];
  const actualContract = Object.fromEntries(knownClasses.map((classification) => [
    classification,
    Object.entries(PI_RPC_EVENT_CONTRACT)
      .filter(([, value]) => value === classification)
      .map(([type]) => type)
      .sort(),
  ]));

  assert.equal(fixture.version, 1);
  assert.deepEqual(Object.keys(fixture.qualifiedVersions).sort(), [...QUALIFIED_PI_RPC_VERSIONS].sort());
  for (const version of QUALIFIED_PI_RPC_VERSIONS) {
    const contract = fixture.contracts[fixture.qualifiedVersions[version] ?? ""];
    assert.ok(contract, `missing event contract for Pi ${version}`);
    assert.deepEqual(
      Object.fromEntries(knownClasses.map((classification) => [classification, [...(contract[classification] ?? [])].sort()])),
      actualContract,
    );
    for (const contractCase of fixture.unknownCases) {
      const projected = projectPiRpcEvent(contractCase.event, version);
      assert.equal(projected.classification, contractCase.classification, `${version}: ${contractCase.name}`);
      assert.equal(projected.refreshesProgress, false);
      assert.ok(Number.isSafeInteger(projected.payloadBytes));
      assert.match(String(projected.payloadDigest), /^[0-9a-f]{64}$/u);
      assert.equal(JSON.stringify(projected).includes("SENTINEL"), false);
    }
  }

  const unqualified = projectPiRpcEvent(fixture.unknownCases[0]!.event, "0.85.0");
  assert.equal(unqualified.classification, "unknown-unsafe");
  assert.equal(unqualified.unsafeReason, "unqualified-version");
  const oversize = projectPiRpcEvent({
    type: "future_telemetry",
    payload: `PRIVATE_OVERSIZE_SENTINEL${"x".repeat(MAX_UNKNOWN_PI_RPC_EVENT_BYTES)}`,
  }, "0.84.2");
  assert.equal(oversize.classification, "unknown-unsafe");
  assert.equal(oversize.unsafeReason, "oversize");
  assert.ok(Buffer.byteLength(JSON.stringify(oversize)) < 1024);
  assert.equal(JSON.stringify(oversize).includes("PRIVATE_OVERSIZE_SENTINEL"), false);
});

test("Pi RPC event adapter projects only the RPC subscriber and preserves diagnostic fields", () => {
  const listeners: Array<(event: Record<string, unknown>) => void> = [];
  const messages = [{ role: "assistant", content: [{ type: "text", text: "private session text" }] }];
  const runtime = {
    session: {
      state: { messages },
      subscribe(listener: (event: Record<string, unknown>) => void) {
        listeners.push(listener);
        return () => undefined;
      },
    },
  };
  const projectedRuntime = withProjectedPiRpcEvents(runtime, "0.84.2");
  const received: Record<string, unknown>[] = [];
  projectedRuntime.session.subscribe((event) => received.push(event));

  const providerError = "HTTP 429 rate limit ".repeat(1024);
  const event = {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: providerError,
      content: [{ type: "text", text: "untrusted provider response" }],
    },
  };
  listeners[0]?.(event);

  assert.equal(projectedRuntime.session.state.messages, messages);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, "message_end");
  assert.equal((received[0]?.message as Record<string, unknown>).role, "assistant");
  assert.equal((received[0]?.message as Record<string, unknown>).stopReason, "error");
  assert.equal(received[0]?.assistantContentObserved, true);
  assert.equal(received[0]?.toolCallObserved, false);
  assert.match(String((received[0]?.message as Record<string, unknown>).errorMessage), /^HTTP 429 rate limit/);
  assert.ok(Buffer.byteLength(String((received[0]?.message as Record<string, unknown>).errorMessage)) <= 16 * 1024);
  assert.equal(JSON.stringify(received[0]).includes("untrusted provider response"), false);
  assert.deepEqual(event.message.content, [{ type: "text", text: "untrusted provider response" }]);
});

test("Worker context controls pin exact task data and compact once between tool turns", async () => {
  const pinned = "<harness-pinned-task-data>EXACT_OBJECTIVE_AND_AC</harness-pinned-task-data>";
  const events: Record<string, unknown>[] = [];
  const branch = [{ id: "entry-1" }];
  const compactedMessages = [{ role: "compactionSummary", summary: "private", timestamp: 1 }];
  let compactions = 0;
  let preparedSettings: Record<string, unknown> | null = null;
  const session = {
    model: { provider: "test", id: "model", contextWindow: 100_000 },
    thinkingLevel: "high",
    modelRuntime: { async getAuth() { return undefined; } },
    sessionManager: {
      getBranch() { return branch; },
      appendCompaction() { return "compaction-1"; },
      buildSessionContext() { return { messages: compactedMessages }; },
    },
    agent: {
      state: { messages: [{ role: "user", content: [{ type: "text", text: "history" }] }], systemPrompt: "trusted repository policy" },
      streamFunction: () => undefined,
      async transformContext(messages: unknown[]) { return [...messages]; },
      async prepareNextTurnWithContext(_turn?: unknown) { return undefined; },
    },
  };
  const pi = {
    calculateContextTokens(usage: { totalTokens: number }) { return usage.totalTokens; },
    estimateTokens() { return 1; },
    prepareCompaction(_entries: unknown[], settings: Record<string, unknown>) {
      preparedSettings = settings;
      return { firstKeptEntryId: "entry-1" };
    },
    async compact() {
      compactions += 1;
      return {
        summary: "PRIVATE_SUMMARY",
        firstKeptEntryId: "entry-1",
        tokensBefore: 80_000,
        estimatedTokensAfter: 12_000,
      };
    },
  };
  installWorkerContextControls(
    pi,
    session,
    pinned,
    { triggerPercent: 75, maxCompactions: 1, keepRecentTokens: 20_000, overflowContinuation: false },
    (event: Record<string, unknown>) => events.push(event),
  );

  const original = [{ role: "user", content: [{ type: "text", text: "recent" }] }];
  const firstRequest = await session.agent.transformContext(original);
  const secondRequest = await session.agent.transformContext(original);
  assert.equal(JSON.stringify(firstRequest).split("EXACT_OBJECTIVE_AND_AC").length - 1, 1);
  assert.deepEqual(firstRequest, secondRequest);
  assert.deepEqual(original, [{ role: "user", content: [{ type: "text", text: "recent" }] }]);
  assert.match(session.agent.state.systemPrompt, /harness-worker-contract/);
  assert.match(session.agent.state.systemPrompt, /worker_submit exactly once/);

  const turn = {
    message: { usage: { totalTokens: 80_000 } },
    context: { systemPrompt: "trusted", tools: [], messages: original },
  };
  const nextTurn = session.agent.prepareNextTurnWithContext as unknown as (
    value: typeof turn,
  ) => Promise<{ context: { messages: unknown[]; systemPrompt?: string } } | undefined>;
  const afterCompact = await nextTurn(turn);
  const afterCeiling = await nextTurn(turn);
  assert.equal(compactions, 1);
  assert.deepEqual(preparedSettings, { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 });
  assert.ok(afterCompact);
  assert.deepEqual(afterCompact.context.messages, compactedMessages);
  assert.ok(afterCeiling);
  assert.match(String(afterCompact.context.systemPrompt), /harness-worker-contract/);
  assert.match(String(afterCeiling.context.systemPrompt), /harness-worker-contract/);
  const postCompactRequest = await session.agent.transformContext(compactedMessages);
  assert.equal(JSON.stringify(postCompactRequest).split("EXACT_OBJECTIVE_AND_AC").length - 1, 1);
  assert.deepEqual(session.agent.state.messages, compactedMessages);
  assert.deepEqual(events.map((event) => event.type), ["compaction_start", "compaction_end"]);
  assert.equal(JSON.stringify(events).includes("PRIVATE_SUMMARY"), false);
  assert.equal(events[1]?.summaryDigest && String(events[1]?.summaryDigest).length, 64);
});

test("controlled compaction Provider failure emits only a content-free failed event", async () => {
  const events: Record<string, unknown>[] = [];
  const secret = "access_token_COMPACTION_SENTINEL";
  const session = {
    model: { provider: "test", id: "model", contextWindow: 100_000 },
    thinkingLevel: "high",
    modelRuntime: { async getAuth() { return { auth: { apiKey: secret } }; } },
    sessionManager: {
      getBranch() { return [{ id: "entry-1" }]; },
      appendCompaction() { return "unused"; },
      buildSessionContext() { return { messages: [] }; },
    },
    agent: {
      state: { messages: [], systemPrompt: "trusted" },
      async transformContext(messages: unknown[]) { return messages; },
      async prepareNextTurnWithContext() { return undefined; },
    },
  };
  installWorkerContextControls({
    calculateContextTokens(usage: { totalTokens: number }) { return usage.totalTokens; },
    estimateTokens() { return 0; },
    prepareCompaction() { return { firstKeptEntryId: "entry-1" }; },
    async compact() { throw new Error(`Provider failed ${secret}`); },
  }, session, "exact task", {
    triggerPercent: 75,
    maxCompactions: 1,
    keepRecentTokens: 20_000,
    overflowContinuation: false,
  }, (event: Record<string, unknown>) => events.push(event));

  const nextTurn = session.agent.prepareNextTurnWithContext as unknown as (turn: unknown) => Promise<unknown>;
  await assert.rejects(() => nextTurn({
    message: { usage: { totalTokens: 80_000 } },
    context: { messages: [], systemPrompt: "trusted" },
  }), /Harness controlled compaction failed/);
  assert.deepEqual(events.map(({ type, outcome, willRetry }) => ({ type, outcome, willRetry })), [
    { type: "compaction_start", outcome: undefined, willRetry: false },
    { type: "compaction_end", outcome: "failed", willRetry: false },
  ]);
  assert.equal(JSON.stringify(events).includes(secret), false);
});

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
  writeFileSync(join(dist, "index.js"), fakePiSdkSource());
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
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, unknown>;
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

    const cached = runner.run(process.execPath, commandArgs, {
      ...options,
      env: { ...options.env, FAKE_PI_SDK_PROBE_FAIL: "1" },
    });
    assert.equal(cached.ok, true, cached.stderr);
    assert.equal((JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, unknown>).promptCount, undefined);

    const sentinel = "refresh_token_SENTINEL";
    const authFailure = runner.run(process.execPath, commandArgs, {
      ...options,
      env: { ...options.env, FAKE_PI_SDK_AUTH_ERROR: sentinel },
    });
    assert.equal(authFailure.ok, false);
    assert.equal(authFailure.stderr.includes(sentinel), false);

    const invalidated = runner.run(process.execPath, commandArgs, {
      ...options,
      env: { ...options.env, FAKE_PI_SDK_PROBE_FAIL: "1" },
    });
    assert.equal(invalidated.ok, false);
    assert.match(invalidated.stdout, /"code":"oauth_probe_failed"/);

    const refreshTimeout = runner.run(process.execPath, commandArgs, {
      ...options,
      env: { ...options.env, FAKE_PI_SDK_AUTH_TIMEOUT: "1" },
    });
    assert.equal(refreshTimeout.ok, false);
    assert.match(refreshTimeout.stdout, /"code":"oauth_refresh_timeout"/);
    assert.equal(refreshTimeout.stdout.includes("access_token_SENTINEL"), false);

    const lockContention = runner.run(process.execPath, commandArgs, {
      ...options,
      env: { ...options.env, FAKE_PI_SDK_OAUTH_LOCK_CONTENTION: "1" },
    });
    assert.equal(lockContention.ok, false);
    assert.equal(lockContention.stderr, "FAIL: Pi RPC SDK host failed at oauth-refresh\n");
    assert.match(lockContention.stdout, /"code":"oauth_probe_failed"/);

    linkSync(authPath, join(root, "auth-hardlink.json"));
    const rejected = runner.run(process.execPath, commandArgs, options);
    assert.equal(rejected.ok, false);
    assert.match(rejected.stderr, /Pi RPC SDK host failed/);
  } finally {
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
  writeFileSync(join(dist, "index.js"), fakePiSdkSource());
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
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      modelOptions: Record<string, unknown>;
      registeredProvider: string;
      registeredBaseUrl: string;
      registeredModel: Record<string, unknown>;
    };
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
