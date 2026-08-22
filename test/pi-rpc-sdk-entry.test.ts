import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SyncCommandRunner } from "../src/adapters/command.js";
import { executionResourceDigest } from "../src/attempt-plan.js";
import { preparePiRpcToolAgentDirAt } from "../src/pi-rpc-spool.js";
import { QUALIFIED_PI_RPC_VERSIONS } from "../src/compatibility.js";
import {
  MAX_UNKNOWN_PI_RPC_EVENT_BYTES,
  PI_RPC_EVENT_CONTRACT,
  type PiRpcEventClassification,
} from "../src/pi-rpc-events.js";
import { fakePiSdkSource } from "./fixtures/fake-pi-sdk.js";
import {
  projectPiRpcEvent,
  withProjectedPiRpcEvents,
} from "../src/pi-rpc-sdk-entry.js";
import {
  ControlledCompactionFailure,
  installWorkerContextControls,
  installWorkerSystemContract,
  loadWorkerCompactionSdk,
} from "../src/pi-rpc-compaction-compat.js";
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
      diagnostics: [{
        type: "provider_transport_failure",
        timestamp: Date.now(),
        error: {
          name: "WebSocketError",
          message: "access_token_DIAGNOSTIC_SENTINEL",
          stack: "access_token_STACK_SENTINEL",
          code: "ECONNRESET",
        },
        details: {
          configuredTransport: "auto",
          eventsEmitted: true,
          phase: "after_message_stream_start",
          requestBytes: 1234,
        },
      }],
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
  assert.equal((received[0]?.message as Record<string, unknown>).providerFailureCode, "provider_network");
  assert.equal(JSON.stringify(received[0]).includes("DIAGNOSTIC_SENTINEL"), false);
  assert.equal(JSON.stringify(received[0]).includes("STACK_SENTINEL"), false);
  assert.equal(JSON.stringify(received[0]).includes("untrusted provider response"), false);
  assert.deepEqual(event.message.content, [{ type: "text", text: "untrusted provider response" }]);

  const older = projectPiRpcEvent(event, "0.84.1");
  assert.equal((older.message as Record<string, unknown>).providerFailureCode, undefined);
  assert.equal(JSON.stringify(older).includes("DIAGNOSTIC_SENTINEL"), false);
});

test("Worker context controls pin exact task data and compact once between tool turns", async () => {
  const pinnedMarkers = ["EXACT_OBJECTIVE", "EXACT_ACCEPTANCE_CRITERIA", "EXACT_TARGET", "EXACT_HANDOFF", "EXACT_WRITEBACK"];
  const pinned = `<harness-pinned-task-data>${pinnedMarkers.join("|")}</harness-pinned-task-data>`;
  const events: Record<string, unknown>[] = [];
  const branch = [{ id: "entry-1" }];
  const compactedMessages = [{ role: "compactionSummary", summary: "private", timestamp: 1 }];
  let compactions = 0;
  let compactInput: unknown = null;
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
    async compact(preparation: unknown) {
      compactions += 1;
      compactInput = preparation;
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
  for (const marker of pinnedMarkers) assert.equal(JSON.stringify(firstRequest).split(marker).length - 1, 1);
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
  for (const marker of pinnedMarkers) assert.equal(JSON.stringify(compactInput).includes(marker), false);
  assert.deepEqual(preparedSettings, { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 });
  assert.ok(afterCompact);
  assert.deepEqual(afterCompact.context.messages, compactedMessages);
  assert.ok(afterCeiling);
  assert.match(String(afterCompact.context.systemPrompt), /harness-worker-contract/);
  assert.match(String(afterCeiling.context.systemPrompt), /harness-worker-contract/);
  const postCompactRequest = await session.agent.transformContext(compactedMessages);
  for (const marker of pinnedMarkers) assert.equal(JSON.stringify(postCompactRequest).split(marker).length - 1, 1);
  assert.deepEqual(session.agent.state.messages, compactedMessages);
  assert.deepEqual(events.map((event) => event.type), ["compaction_start", "compaction_end"]);
  assert.equal(events[0]?.attemptCount, 1);
  assert.equal(events[1]?.attemptCount, 1);
  assert.equal(events[1]?.usedRetry, false);
  assert.ok(Number.isSafeInteger(events[1]?.payloadByteEstimate));
  assert.ok(Number.isSafeInteger(events[1]?.summaryRequestDurationMs));
  assert.equal(JSON.stringify(events).includes("PRIVATE_SUMMARY"), false);
  assert.equal(events[1]?.summaryDigest && String(events[1]?.summaryDigest).length, 64);
});

test("disabled Worker keeps the trusted system contract without compaction hooks", () => {
  const session = controlledCompactionSession();
  const nextTurn = session.agent.prepareNextTurnWithContext;
  installWorkerSystemContract(session);
  assert.match(session.agent.state.systemPrompt, /harness-worker-contract/);
  assert.equal(session.agent.prepareNextTurnWithContext, nextTurn);
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
  let requests = 0;
  installWorkerContextControls({
    calculateContextTokens(usage: { totalTokens: number }) { return usage.totalTokens; },
    estimateTokens() { return 0; },
    prepareCompaction() { return { firstKeptEntryId: "entry-1" }; },
    async compact() {
      requests += 1;
      throw new Error(`network connection reset ${secret}`);
    },
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
  }), (error: unknown) => error instanceof ControlledCompactionFailure
    && error.code === "compaction_provider_transient");
  assert.equal(requests, 2);
  assert.deepEqual(events.map(({ type, outcome, attemptCount, usedRetry, willRetry, failureCode }) => ({
    type, outcome, attemptCount, usedRetry, willRetry, failureCode,
  })), [
    {
      type: "compaction_start", outcome: undefined, attemptCount: 1, usedRetry: false,
      willRetry: false, failureCode: undefined,
    },
    {
      type: "compaction_end", outcome: "failed", attemptCount: 2, usedRetry: true,
      willRetry: false, failureCode: "compaction_provider_transient",
    },
  ]);
  assert.equal(JSON.stringify(events).includes(secret), false);
});

test("controlled compaction distinguishes permanent, protocol, and context failures without retry", async () => {
  for (const fixture of [
    {
      expected: "compaction_provider_permanent",
      prepare: () => ({ firstKeptEntryId: "entry-1" }),
      compact: async () => { throw Object.assign(new Error("HTTP 401 private response"), { status: 401 }); },
      requests: 1,
    },
    {
      expected: "compaction_provider_permanent",
      prepare: () => ({ firstKeptEntryId: "entry-1" }),
      compact: async () => { throw Object.assign(new Error("service unavailable"), { status: 503 }); },
      requests: 1,
    },
    {
      expected: "compaction_protocol",
      prepare: () => ({ firstKeptEntryId: "entry-1" }),
      compact: async () => ({ summary: "", firstKeptEntryId: "entry-1", tokensBefore: 80_000 }),
      requests: 1,
    },
    {
      expected: "compaction_context_invalid",
      prepare: () => undefined,
      compact: async () => ({ summary: "unused" }),
      requests: 0,
    },
  ] as const) {
    const events: Record<string, unknown>[] = [];
    let requests = 0;
    const session = controlledCompactionSession();
    installWorkerContextControls({
      calculateContextTokens(usage: { totalTokens: number }) { return usage.totalTokens; },
      estimateTokens() { return 0; },
      prepareCompaction: fixture.prepare,
      async compact() {
        requests += 1;
        return fixture.compact();
      },
    }, session, "exact objective acceptance target handoff writeback", {
      triggerPercent: 75,
      maxCompactions: 1,
      keepRecentTokens: 20_000,
      overflowContinuation: false,
    }, (event) => events.push(event));

    const nextTurn = session.agent.prepareNextTurnWithContext as unknown as (turn: unknown) => Promise<unknown>;
    let observed: unknown;
    try {
      await nextTurn({
        message: { usage: { totalTokens: 80_000 } },
        context: { messages: [], systemPrompt: "trusted" },
      });
    } catch (error) {
      observed = error;
    }
    assert.equal(observed instanceof ControlledCompactionFailure && observed.code, fixture.expected);
    assert.equal(requests, fixture.requests);
    assert.equal(events.at(-1)?.failureCode, fixture.expected);
    assert.equal(events.at(-1)?.usedRetry, false);
  }
});

test("controlled compaction compatibility adapter pins the exact private surface", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-compaction-compat-"));
  const dist = join(root, "dist");
  const piIndex = join(dist, "index.js");
  try {
    mkdirSync(join(dist, "core", "compaction"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    writeFileSync(piIndex, "export const VERSION = '0.84.2';\n");
    writeFileSync(join(dist, "core", "compaction", "index.js"), "export function prepareCompaction() { return {}; }\n");
    const publicApi = {
      VERSION: "0.84.2",
      calculateContextTokens() { return 1; },
      estimateTokens() { return 1; },
      async compact() { return {}; },
    };

    const loaded = await loadWorkerCompactionSdk(publicApi, piIndex, "0.84.2");
    assert.equal(typeof loaded.prepareCompaction, "function");
    await assert.rejects(
      () => loadWorkerCompactionSdk(publicApi, piIndex, "0.84.1"),
      (error: unknown) => error instanceof ControlledCompactionFailure
        && error.code === "compaction_internal_api_drift",
    );
    await assert.rejects(
      () => loadWorkerCompactionSdk({ ...publicApi, compact: undefined as never }, piIndex, "0.84.2"),
      (error: unknown) => error instanceof ControlledCompactionFailure
        && error.code === "compaction_internal_api_drift",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disabled Pi RPC SDK host does not load private compaction and keeps OAuth/settings isolated", () => {
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
    const nestedDefaults = runner.run(process.execPath, commandArgs, {
      ...options,
      env: {
        ...options.env,
        FAKE_PI_SDK_INIT_DEFAULT_STORES: "1",
        FAKE_PI_SDK_RESTORE_PARENT_AGENT_DIR: oauthAgentDir,
      },
    });
    assert.equal(nestedDefaults.ok, true, nestedDefaults.stderr);
    const nestedCapture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      defaultStoreAgentDir?: string;
      canonicalAgentDir?: string;
    };
    assert.ok(nestedCapture.defaultStoreAgentDir);
    assert.ok(resolve(nestedCapture.defaultStoreAgentDir) !== resolve(privateAgentDir));
    assert.equal(nestedCapture.canonicalAgentDir, oauthAgentDir);
    assert.equal(existsSync(join(privateAgentDir, "auth.json")), false);
    assert.equal(readFileSync(join(nestedCapture.defaultStoreAgentDir, "auth.json"), "utf8"), "{}");
    assert.equal(readFileSync(join(nestedCapture.defaultStoreAgentDir, "models-store.json"), "utf8"), "{}");
    const result = runner.run(process.execPath, commandArgs, options);

    assert.equal(existsSync(join(dist, "core", "compaction", "index.js")), false);
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

    const unsafeArgs = [...commandArgs];
    unsafeArgs[unsafeArgs.indexOf("--model") + 1] = "gpt-unsafe";
    const credentialSentinel = "NESTED_CREDENTIAL_SENTINEL";
    const unsafeNestedStore = runner.run(process.execPath, unsafeArgs, {
      ...options,
      env: {
        ...options.env,
        FAKE_PI_SDK_INIT_DEFAULT_STORES: "1",
        FAKE_PI_SDK_DEFAULT_AUTH_CONTENT: `{"oauth":"${credentialSentinel}"}`,
      },
    });
    assert.equal(unsafeNestedStore.ok, false);
    assert.equal(unsafeNestedStore.stdout.includes(credentialSentinel) || unsafeNestedStore.stderr.includes(credentialSentinel), false);
    writeFileSync(join(nestedCapture.defaultStoreAgentDir, "auth.json"), "{}", { mode: 0o600 });

    linkSync(authPath, join(root, "auth-hardlink.json"));
    const rejected = runner.run(process.execPath, commandArgs, options);
    assert.equal(rejected.ok, false);
    assert.match(rejected.stderr, /Pi RPC SDK host failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi RPC tool agent directory rejects a symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-pi-tool-agent-"));
  const target = join(root, "target");
  const toolAgentDir = join(root, "tool-agent");
  try {
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, toolAgentDir);
    assert.throws(() => preparePiRpcToolAgentDirAt(toolAgentDir), /must not be a symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function controlledCompactionSession() {
  return {
    model: { provider: "test", id: "model", contextWindow: 100_000 },
    thinkingLevel: "high",
    modelRuntime: { async getAuth() { return undefined; } },
    sessionManager: {
      getBranch() { return [{ id: "entry-1" }]; },
      appendCompaction() { return "compaction-1"; },
      buildSessionContext() { return { messages: [] }; },
    },
    agent: {
      state: { messages: [] as Record<string, unknown>[], systemPrompt: "trusted" },
      async transformContext(messages: Record<string, unknown>[]) { return messages; },
      async prepareNextTurnWithContext() { return undefined; },
    },
  };
}

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
