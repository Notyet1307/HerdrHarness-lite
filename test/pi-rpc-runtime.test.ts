import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PiRpcRuntime } from "../src/adapters/pi-rpc-runtime.js";
import { SyncCommandRunner } from "../src/adapters/command.js";
import { digest, type AgentHandle, type Attempt, type ExecutionSnapshot } from "../src/model.js";
import { executionResource, executionResourceDigest } from "../src/attempt-plan.js";
import { StrictJsonlDecoder } from "../src/pi-rpc-runner.js";
import {
  classifyProviderFailure,
  makeSafeRuntimeDiagnostic,
  PiRpcRuntimeFailure,
} from "../src/pi-rpc-diagnostics.js";
import {
  readJson,
  rpcGeneration,
  type PiRpcPlan,
  writeAtomicJson,
  writeExclusiveJson,
} from "../src/pi-rpc-spool.js";

test("Pi RPC adapter persists one launch and one dispatch across Controller restarts", async () => {
  const fixture = rpcFixture();
  try {
    let launches = 0;
    const host = {
      async runInPane(input: { argv: string[] }): Promise<void> {
        launches += 1;
        const plan = readJson<PiRpcPlan>(input.argv.at(-1)!);
        const identity = receiptIdentity(plan);
        writeExclusiveJson(join(plan.runtimeRoot, "owner.json"), { ...identity, ok: true, runnerPid: process.pid });
        writeAtomicJson(join(plan.runtimeRoot, "ready.json"), {
          ...identity,
          ok: true,
          autoRetryDisableAccepted: true,
          autoCompactionEnabled: false,
          compactionMode: "controlled-threshold",
          compactionPolicy: fixture.snapshot.compactionPolicy,
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

    const plan = readJson<PiRpcPlan>(join(fixture.runtimeRoot, "plan.json"));
    assert.match(plan.pinnedTaskData?.content ?? "", /Implement the task with exact acceptance criteria/);
    assert.equal(digest(plan.pinnedTaskData?.content ?? ""), plan.pinnedTaskData?.digest);
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
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Pi RPC adapter never invents a missing dispatch and reports only sanitized terminal diagnostics", async () => {
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
      error: "Pi RPC assistant ended with error",
      failureStage: "agent-run",
      failureClass: "rate_limit",
      retryable: true,
      childExit: { code: 0, signal: null },
    });
    await assert.rejects(() => new PiRpcRuntime({ runInPane: async () => undefined }).wait({
      handle: fixture.handle,
      attempt: fixture.attempt,
      resultPath: fixture.attempt.resultPath,
      expectedJobId: "job-1",
      expectedAttemptId: fixture.attempt.id,
      expectedLane: "worker",
    }), /Pi RPC assistant ended with error \(class=rate_limit, retryable=yes, stage=agent-run, child=exit:0\)/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Pi RPC adapter propagates only validated structured diagnostics", async () => {
  const fixture = rpcFixture();
  try {
    const plan = fixture.plan();
    const identity = receiptIdentity(plan);
    const diagnostic = classifyProviderFailure("error", "HTTP 529 overloaded_error access_token_SECRET", {
      providerApi: "anthropic-messages",
      phase: "tool_continuation",
      turnCount: 2,
      assistantMessageCount: 3,
      toolExecutionCount: 1,
      toolErrorCount: 0,
      transcriptBytes: 70_000,
    });
    assert.ok(diagnostic.domain && diagnostic.code && diagnostic.stage);
    const { diagnosticFingerprint: _fingerprint, ...diagnosticFields } = diagnostic;
    const terminalDiagnostic = makeSafeRuntimeDiagnostic({
      ...diagnosticFields,
      domain: diagnostic.domain,
      code: diagnostic.code,
      stage: diagnostic.stage,
      childExit: { code: 0, signal: null },
    });
    writeExclusiveJson(join(plan.runtimeRoot, "plan.json"), plan);
    writeExclusiveJson(join(plan.runtimeRoot, "dispatch.json"), { version: 1 });
    writeAtomicJson(join(plan.runtimeRoot, "terminal.json"), {
      ...identity,
      ok: false,
      error: "Pi RPC assistant ended with error",
      ...terminalDiagnostic,
    });

    let failure: unknown;
    try {
      await new PiRpcRuntime({ runInPane: async () => undefined }).wait({
        handle: fixture.handle,
        attempt: fixture.attempt,
        resultPath: fixture.attempt.resultPath,
        expectedJobId: "job-1",
        expectedAttemptId: fixture.attempt.id,
        expectedLane: "worker",
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof PiRpcRuntimeFailure);
    assert.deepEqual(failure.diagnostic, terminalDiagnostic);
    assert.match(failure.message, /provider\/provider_overloaded/);
    assert.match(failure.message, /api=anthropic-messages/);
    assert.match(failure.message, /phase=tool_continuation/);
    assert.match(failure.message, /status=529/);
    assert.equal(failure.message.includes("access_token_SECRET"), false);

    writeAtomicJson(join(plan.runtimeRoot, "terminal.json"), {
      ...identity,
      ok: false,
      error: "Pi RPC assistant ended with error",
      failureDomain: "provider",
      failureCode: "provider_overloaded",
      retryable: true,
      diagnosticFingerprint: "not-a-digest",
    });
    await assert.rejects(() => new PiRpcRuntime({ runInPane: async () => undefined }).wait({
      handle: fixture.handle,
      attempt: fixture.attempt,
      resultPath: fixture.attempt.resultPath,
      expectedJobId: "job-1",
      expectedAttemptId: fixture.attempt.id,
      expectedLane: "worker",
    }), /invalid runtime diagnostic/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a successful terminal receipt without a durable result is an acceptance failure", async () => {
  const fixture = rpcFixture();
  try {
    const plan = fixture.plan();
    const identity = receiptIdentity(plan);
    writeExclusiveJson(join(plan.runtimeRoot, "plan.json"), plan);
    writeExclusiveJson(join(plan.runtimeRoot, "dispatch.json"), { version: 1 });
    writeAtomicJson(join(plan.runtimeRoot, "terminal.json"), { ...identity, ok: true, agentSettled: true });
    writeAtomicJson(join(plan.runtimeRoot, "terminated.json"), { ...identity, ok: true });

    let failure: unknown;
    try {
      await new PiRpcRuntime({ runInPane: async () => undefined }).wait({
        handle: fixture.handle,
        attempt: fixture.attempt,
        resultPath: fixture.attempt.resultPath,
        expectedJobId: "job-1",
        expectedAttemptId: fixture.attempt.id,
        expectedLane: "worker",
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof PiRpcRuntimeFailure);
    assert.deepEqual(stableFailure(failure.diagnostic as unknown as Record<string, unknown>), {
      domain: "acceptance",
      code: "result_missing",
      stage: "result-validation",
      retryable: false,
    });
  } finally {
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
    }), /Pi RPC version 0\.85\.0 is not qualified/);
  } finally {
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
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("strict Pi RPC JSONL keeps Unicode separators inside one record", () => {
  const decoder = new StrictJsonlDecoder();
  const records = decoder.push('{"type":"message_end","text":"left\u2028right\u2029done"}\r\n');
  decoder.finish();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.text, "left\u2028right\u2029done");
  assert.throws(() => new StrictJsonlDecoder().push(`${"x".repeat(1024 * 1024 + 1)}`), /rpc_event_oversize/);
  const accepted: Record<string, unknown>[] = [];
  assert.throws(
    () => new StrictJsonlDecoder().push('{"type":"agent_settled"}\n{malformed\n', (record) => accepted.push(record)),
    /rpc_invalid_json/,
  );
  assert.deepEqual(accepted, [{ type: "agent_settled" }]);
});

test("durable runner disables retry and compaction before dispatch and settles through result", () => {
  const fixture = rpcFixture();
  const previous = {
    result: process.env.FAKE_PI_RESULT_PATH,
    job: process.env.FAKE_PI_JOB_ID,
    attempt: process.env.FAKE_PI_ATTEMPT_ID,
    malformed: process.env.FAKE_PI_MALFORMED_AFTER_PROMPT,
    modelSecret: process.env.FAKE_PI_MODEL_SECRET,
    controlledCompaction: process.env.FAKE_PI_CONTROLLED_COMPACTION,
    ponytail: process.env.FAKE_PI_EXPECT_PONYTAIL_ENV,
  };
  try {
    const ponytailRoot = join(fixture.root, "ponytail");
    const ponytailExtension = join(ponytailRoot, "pi-extension", "index.js");
    mkdirSync(dirname(ponytailExtension), { recursive: true });
    writeFileSync(ponytailExtension, "export default function ponytail() {}\n");
    writeFileSync(join(ponytailRoot, "package.json"), JSON.stringify({
      name: "@dietrichgebert/ponytail",
      version: "4.9.0",
      pi: { extensions: ["./pi-extension/index.js"] },
    }));
    fixture.snapshot.resources.push(executionResource("extension", ponytailExtension));
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
    const sourceAgentDir = plan.snapshot.context!.agentDir;
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
    const modelSecret = "MODEL_HEADER_SECRET_SENTINEL";
    process.env.FAKE_PI_MODEL_SECRET = modelSecret;
    process.env.FAKE_PI_CONTROLLED_COMPACTION = "1";
    process.env.FAKE_PI_EXPECT_PONYTAIL_ENV = "1";

    const execution = new SyncCommandRunner().run(process.execPath, [
      resolve("dist/src/pi-rpc-runner.js"),
      "--sdk-entry",
      resolve("test/fixtures/pi-rpc-sdk-entry.js"),
      "--plan",
      join(plan.runtimeRoot, "plan.json"),
    ], { cwd: fixture.root, timeoutMs: 10_000 });
    assert.equal(execution.ok, true, execution.stderr);
    assert.equal(readJson<{ ok: boolean; autoRetryDisableAccepted: boolean; autoCompactionEnabled: boolean }>(join(plan.runtimeRoot, "ready.json")).ok, true);
    assert.equal(readJson<{ autoRetryDisableAccepted: boolean }>(join(plan.runtimeRoot, "ready.json")).autoRetryDisableAccepted, true);
    assert.equal(readJson<{ autoCompactionEnabled: boolean }>(join(plan.runtimeRoot, "ready.json")).autoCompactionEnabled, false);
    assert.equal(readJson<{ compactionMode: string }>(join(plan.runtimeRoot, "ready.json")).compactionMode, "controlled-threshold");
    assert.equal(readJson<{ credentialMode: string }>(join(plan.runtimeRoot, "ready.json")).credentialMode, "canonical-oauth");
    const isolatedAgentDir = join(plan.runtimeRoot, "pi-agent");
    assert.equal(readJson<{ isolatedAgentDir: string }>(join(plan.runtimeRoot, "ready.json")).isolatedAgentDir, isolatedAgentDir);
    assert.equal(readFileSync(join(sourceAgentDir, "settings.json"), "utf8"), sourceSettings);
    assert.equal(existsSync(join(isolatedAgentDir, "settings.json")), false);
    assert.equal(readFileSync(join(sourceAgentDir, "auth.json"), "utf8"), sourceAuth);
    assert.equal(existsSync(join(isolatedAgentDir, "auth.json")), false);
    assert.equal(existsSync(join(isolatedAgentDir, "models.json")), false);
    assert.equal(readJson<{ ok: boolean }>(join(plan.runtimeRoot, "accepted.json")).ok, true);
    assert.equal(readJson<{ ok: boolean; agentSettled: boolean }>(join(plan.runtimeRoot, "terminal.json")).agentSettled, true);
    assert.deepEqual(readJson<{ controlledCompaction: Record<string, unknown> }>(join(plan.runtimeRoot, "terminal.json")).controlledCompaction, {
      count: 1,
      triggerPercent: 75,
      contextTokens: 80_000,
      contextWindow: 100_000,
      outcome: "completed",
      tokensBefore: 80_000,
      estimatedTokensAfter: 12_000,
      summaryDigest: "a".repeat(64),
      willRetry: false,
    });
    assert.equal(readJson<{ ok: boolean }>(join(plan.runtimeRoot, "terminated.json")).ok, true);
    assert.equal(JSON.parse(readFileSync(fixture.attempt.resultPath, "utf8")).attemptId, fixture.attempt.id);
    for (const path of filesUnder(plan.runtimeRoot)) assert.equal(readFileSync(path, "utf8").includes(modelSecret), false, path);
  } finally {
    restoreEnv("FAKE_PI_RESULT_PATH", previous.result);
    restoreEnv("FAKE_PI_JOB_ID", previous.job);
    restoreEnv("FAKE_PI_ATTEMPT_ID", previous.attempt);
    restoreEnv("FAKE_PI_MALFORMED_AFTER_PROMPT", previous.malformed);
    restoreEnv("FAKE_PI_MODEL_SECRET", previous.modelSecret);
    restoreEnv("FAKE_PI_CONTROLLED_COMPACTION", previous.controlledCompaction);
    restoreEnv("FAKE_PI_EXPECT_PONYTAIL_ENV", previous.ponytail);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("durable runner dispatches Reviewer code-review with the bound custom model config", () => {
  const fixture = rpcFixture();
  const previous = {
    result: process.env.FAKE_PI_RESULT_PATH,
    job: process.env.FAKE_PI_JOB_ID,
    attempt: process.env.FAKE_PI_ATTEMPT_ID,
    lane: process.env.FAKE_PI_LANE,
    skills: process.env.FAKE_PI_SKILLS,
    thinking: process.env.FAKE_PI_THINKING,
    cleanup: process.env.FAKE_PI_REVIEWER_CLEANUP,
  };
  try {
    const { plan, modelsPath, modelsContent } = reviewerPlan(fixture);
    writeExclusiveJson(join(plan.runtimeRoot, "plan.json"), plan);
    writeExclusiveJson(join(plan.runtimeRoot, "dispatch.json"), {
      version: 1,
      attemptId: plan.attemptId,
      generation: plan.generation,
      planDigest: plan.planDigest,
      dispatchId: plan.attemptId,
      promptDigest: fixture.attempt.promptDigest,
      message: "/skill:code-review [harness-dispatch:reviewer-1]\nreview",
    });
    process.env.FAKE_PI_RESULT_PATH = fixture.attempt.resultPath;
    process.env.FAKE_PI_JOB_ID = "job-1";
    process.env.FAKE_PI_ATTEMPT_ID = fixture.attempt.id;
    process.env.FAKE_PI_LANE = "reviewer";
    process.env.FAKE_PI_SKILLS = "code-review";
    process.env.FAKE_PI_THINKING = "max";
    process.env.FAKE_PI_REVIEWER_CLEANUP = "before-and-after";

    const execution = new SyncCommandRunner().run(process.execPath, [
      resolve("dist/src/pi-rpc-runner.js"),
      "--sdk-entry", resolve("test/fixtures/pi-rpc-sdk-entry.js"),
      "--plan", join(plan.runtimeRoot, "plan.json"),
    ], { cwd: fixture.root, timeoutMs: 10_000 });
    assert.equal(execution.ok, true, execution.stderr);
    assert.equal(readJson<{ ok: boolean }>(join(plan.runtimeRoot, "terminal.json")).ok, true);
    assert.equal(readJson<{ credentialMode: string }>(join(plan.runtimeRoot, "ready.json")).credentialMode, "canonical-model-config");
    assert.equal(JSON.parse(readFileSync(fixture.attempt.resultPath, "utf8")).lane, "reviewer");
    assert.equal(readFileSync(modelsPath, "utf8"), modelsContent);
    assert.equal(existsSync(join(plan.runtimeRoot, "pi-agent", "models.json")), false);
  } finally {
    restoreEnv("FAKE_PI_RESULT_PATH", previous.result);
    restoreEnv("FAKE_PI_JOB_ID", previous.job);
    restoreEnv("FAKE_PI_ATTEMPT_ID", previous.attempt);
    restoreEnv("FAKE_PI_LANE", previous.lane);
    restoreEnv("FAKE_PI_SKILLS", previous.skills);
    restoreEnv("FAKE_PI_THINKING", previous.thinking);
    restoreEnv("FAKE_PI_REVIEWER_CLEANUP", previous.cleanup);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("durable runner accepts Reviewer code-review with canonical subscription OAuth", () => {
  const fixture = rpcFixture();
  const previous = {
    result: process.env.FAKE_PI_RESULT_PATH,
    job: process.env.FAKE_PI_JOB_ID,
    attempt: process.env.FAKE_PI_ATTEMPT_ID,
    lane: process.env.FAKE_PI_LANE,
    skills: process.env.FAKE_PI_SKILLS,
    thinking: process.env.FAKE_PI_THINKING,
  };
  try {
    fixture.snapshot.context!.lane = "reviewer";
    fixture.snapshot.compactionMode = "disabled";
    delete fixture.snapshot.compactionPolicy;
    fixture.snapshot.credentialMode = "canonical-oauth";
    fixture.snapshot.thinking = "max";
    fixture.snapshot.tools = ["read", "subagent", "review_submit"];
    fixture.snapshot.resources = [
      { kind: "skill", path: "/skills/code-review", digest: "e".repeat(64) },
      runtimeResource(resolve("dist/src/pi-rpc-runner.js")),
      runtimeResource(resolve("test/fixtures/pi-rpc-sdk-entry.js")),
    ];
    fixture.attempt.id = "reviewer-oauth-1";
    fixture.attempt.lane = "reviewer";
    fixture.attempt.expectedHeadSha = "b".repeat(40);
    fixture.attempt.promptDigest = digest("review");
    const plan = fixture.plan({
      executable: process.execPath,
      argv: [
        resolve("test/fixtures/fake-pi-rpc.js"),
        "--no-session", "--no-context-files", "--no-prompt-templates", "--no-themes",
        "--provider", "openai-codex", "--model", "gpt-5.6-sol", "--mode", "rpc",
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
      message: "/skill:code-review [harness-dispatch:reviewer-oauth-1]\nreview",
    });
    process.env.FAKE_PI_RESULT_PATH = fixture.attempt.resultPath;
    process.env.FAKE_PI_JOB_ID = "job-1";
    process.env.FAKE_PI_ATTEMPT_ID = fixture.attempt.id;
    process.env.FAKE_PI_LANE = "reviewer";
    process.env.FAKE_PI_SKILLS = "code-review";
    process.env.FAKE_PI_THINKING = "max";

    const execution = new SyncCommandRunner().run(process.execPath, [
      resolve("dist/src/pi-rpc-runner.js"),
      "--sdk-entry", resolve("test/fixtures/pi-rpc-sdk-entry.js"),
      "--plan", join(plan.runtimeRoot, "plan.json"),
    ], { cwd: fixture.root, timeoutMs: 10_000 });
    assert.equal(execution.ok, true, execution.stderr);
    assert.equal(readJson<{ credentialMode: string }>(join(plan.runtimeRoot, "ready.json")).credentialMode, "canonical-oauth");
    assert.equal(JSON.parse(readFileSync(fixture.attempt.resultPath, "utf8")).lane, "reviewer");
  } finally {
    restoreEnv("FAKE_PI_RESULT_PATH", previous.result);
    restoreEnv("FAKE_PI_JOB_ID", previous.job);
    restoreEnv("FAKE_PI_ATTEMPT_ID", previous.attempt);
    restoreEnv("FAKE_PI_LANE", previous.lane);
    restoreEnv("FAKE_PI_SKILLS", previous.skills);
    restoreEnv("FAKE_PI_THINKING", previous.thinking);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("durable runner rejects Reviewer UI requests during an active agent or with the wrong widget", () => {
  for (const cleanup of ["before-settled", "wrong-key"]) {
    const fixture = rpcFixture();
    try {
      const { plan } = reviewerPlan(fixture);
      writeExclusiveJson(join(plan.runtimeRoot, "plan.json"), plan);
      writeExclusiveJson(join(plan.runtimeRoot, "dispatch.json"), {
        version: 1,
        attemptId: plan.attemptId,
        generation: plan.generation,
        planDigest: plan.planDigest,
        dispatchId: plan.attemptId,
        promptDigest: fixture.attempt.promptDigest,
        message: "/skill:code-review [harness-dispatch:reviewer-1]\nreview",
      });
      const execution = new SyncCommandRunner().run(process.execPath, [
        resolve("dist/src/pi-rpc-runner.js"),
        "--sdk-entry", resolve("test/fixtures/pi-rpc-sdk-entry.js"),
        "--plan", join(plan.runtimeRoot, "plan.json"),
      ], {
        cwd: fixture.root,
        timeoutMs: 10_000,
        env: {
          ...process.env,
          FAKE_PI_RESULT_PATH: fixture.attempt.resultPath,
          FAKE_PI_JOB_ID: "job-1",
          FAKE_PI_ATTEMPT_ID: fixture.attempt.id,
          FAKE_PI_LANE: "reviewer",
          FAKE_PI_SKILLS: "code-review",
          FAKE_PI_THINKING: "max",
          FAKE_PI_REVIEWER_CLEANUP: cleanup,
        },
      });
      assert.equal(execution.ok, true, execution.stderr);
      assert.equal(readJson<{ ok: boolean }>(join(plan.runtimeRoot, "terminal.json")).ok, false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("durable runner still rejects every Worker UI request", () => {
  const fixture = rpcFixture();
  try {
    const { execution, plan } = runWorkerFault(fixture, { FAKE_PI_WORKER_UI_REQUEST: "1" });
    assert.equal(execution.ok, true, execution.stderr);
    assert.equal(readJson<{ ok: boolean }>(join(plan.runtimeRoot, "terminal.json")).ok, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("terminal failure remains authoritative when a durable result already exists", async () => {
  const fixture = rpcFixture();
  try {
    const { execution, plan } = runWorkerFault(fixture, { FAKE_PI_TERMINAL_FAILURE_AFTER_RESULT: "1" });

    assert.equal(execution.ok, true, execution.stderr);
    assert.equal(existsSync(fixture.attempt.resultPath), true);
    const terminal = readJson<Record<string, unknown>>(join(plan.runtimeRoot, "terminal.json"));
    assert.equal(terminal.ok, false);
    assert.deepEqual(stableFailure(terminal), {
      domain: "execution",
      code: "policy_violation",
      stage: "agent-run",
      retryable: false,
    });
    assert.equal(readFileSync(join(plan.runtimeRoot, "runtime-events.jsonl"), "utf8").includes("must-not-be-persisted"), false);
    await assert.rejects(() => new PiRpcRuntime({ runInPane: async () => undefined }).wait({
      handle: fixture.handle,
      attempt: fixture.attempt,
      resultPath: fixture.attempt.resultPath,
      expectedJobId: "job-1",
      expectedAttemptId: fixture.attempt.id,
      expectedLane: "worker",
    }), /execution\/policy_violation/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("unknown RPC events produce a content-free policy failure", () => {
  const fixture = rpcFixture();
  try {
    const { execution, plan } = runWorkerFault(fixture, { FAKE_PI_UNKNOWN_EVENT: "1" });
    assert.equal(execution.ok, true, execution.stderr);
    assert.equal(existsSync(fixture.attempt.resultPath), false);
    const terminal = readJson<Record<string, unknown>>(join(plan.runtimeRoot, "terminal.json"));
    assert.deepEqual(stableFailure(terminal), {
      domain: "execution",
      code: "policy_violation",
      stage: "agent-run",
      retryable: false,
    });
    assert.equal(readFileSync(join(plan.runtimeRoot, "runtime-events.jsonl"), "utf8").includes("must-not-be-persisted"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("durable runner records a content-free controlled compaction failure", () => {
  const fixture = rpcFixture();
  try {
    const { execution, plan } = runWorkerFault(fixture, { FAKE_PI_CONTROLLED_COMPACTION: "fail" });
    assert.equal(execution.ok, true, execution.stderr);
    const terminal = readJson<{ ok: boolean; controlledCompaction: Record<string, unknown> }>(join(plan.runtimeRoot, "terminal.json"));
    assert.equal(terminal.ok, false);
    assert.deepEqual(stableFailure(terminal), {
      domain: "execution",
      code: "compaction_failure",
      stage: "compaction",
      retryable: false,
    });
    assert.deepEqual(terminal.controlledCompaction, {
      count: 1,
      triggerPercent: 75,
      contextTokens: 80_000,
      contextWindow: 100_000,
      outcome: "failed",
      willRetry: false,
    });
    assert.equal(JSON.stringify(terminal).includes("summary"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("durable runner rejects Reviewer models.json drift before prompt side effects", async () => {
  const fixture = rpcFixture();
  try {
    const { plan, modelsPath } = reviewerPlan(fixture);
    writeExclusiveJson(join(plan.runtimeRoot, "plan.json"), plan);
    const child = spawn(process.execPath, [
      resolve("dist/src/pi-rpc-runner.js"),
      "--sdk-entry", resolve("test/fixtures/pi-rpc-sdk-entry.js"),
      "--plan", join(plan.runtimeRoot, "plan.json"),
    ], {
      cwd: fixture.root,
      env: {
        ...process.env,
        FAKE_PI_RESULT_PATH: fixture.attempt.resultPath,
        FAKE_PI_JOB_ID: "job-1",
        FAKE_PI_ATTEMPT_ID: fixture.attempt.id,
        FAKE_PI_LANE: "reviewer",
        FAKE_PI_SKILLS: "code-review",
        FAKE_PI_THINKING: "max",
      },
      stdio: "ignore",
    });
    await waitForFile(join(plan.runtimeRoot, "ready.json"));
    writeFileSync(modelsPath, '{"providers":{"custom":{"apiKey":"DRIFTED","models":[]}}}\n', { mode: 0o600 });
    writeExclusiveJson(join(plan.runtimeRoot, "dispatch.json"), {
      version: 1,
      attemptId: plan.attemptId,
      generation: plan.generation,
      planDigest: plan.planDigest,
      dispatchId: plan.attemptId,
      promptDigest: fixture.attempt.promptDigest,
      message: "/skill:code-review [harness-dispatch:reviewer-1]\nreview",
    });
    const code = await new Promise<number | null>((resolveExit) => child.on("exit", resolveExit));
    assert.equal(code, 1);
    assert.equal(readJson<{ ok: boolean }>(join(plan.runtimeRoot, "terminal.json")).ok, false);
    assert.equal(existsSync(join(plan.runtimeRoot, "accepted.json")), false);
    assert.equal(existsSync(fixture.attempt.resultPath), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("durable runner rejects private auth writes before ready or after settlement", () => {
  for (const authWriteVariable of ["FAKE_PI_WRITE_AUTH_BEFORE_READY", "FAKE_PI_WRITE_AUTH_AFTER_SETTLED"] as const) {
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
      assert.equal(readJson<{ ok: boolean }>(join(plan.runtimeRoot, "terminal.json")).ok, false);
      assert.equal(readJson<{ ok: boolean }>(join(plan.runtimeRoot, "terminated.json")).ok, true);
    } finally {
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
  } finally {
    restoreEnv("FAKE_PI_SECRET_ERROR", previous);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("durable runner rejects a settled assistant failure without persisting Provider diagnostics", () => {
  const cases = [
    { stopReason: "error", providerError: "HTTP 429 rate limit", tool: undefined, code: "provider_rate_limited", phase: "initial_generation", retryable: true },
    { stopReason: "error", providerError: "HTTP 529 overloaded_error", tool: "success", code: "provider_overloaded", phase: "tool_continuation", retryable: true },
    { stopReason: "error", providerError: "HTTP 413 request_too_large", tool: "error", code: "provider_request_too_large", phase: "tool_error_recovery", retryable: false },
    { stopReason: "aborted", providerError: "cancelled", tool: undefined, code: "assistant_aborted", phase: "initial_generation", retryable: false },
  ] as const;
  for (const scenario of cases) {
    const { stopReason } = scenario;
    const fixture = rpcFixture();
    const sentinel = `access_token_${stopReason}_SENTINEL`;
    const providerError = `${scenario.providerError}: ${sentinel}`;
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

      const execution = new SyncCommandRunner().run(process.execPath, [
        resolve("dist/src/pi-rpc-runner.js"),
        "--sdk-entry", resolve("test/fixtures/pi-rpc-sdk-entry.js"),
        "--plan", join(plan.runtimeRoot, "plan.json"),
      ], {
        cwd: fixture.root,
        timeoutMs: 10_000,
        env: {
          ...process.env,
          FAKE_PI_ASSISTANT_STOP_REASON: stopReason,
          FAKE_PI_ASSISTANT_ERROR: providerError,
          FAKE_PI_API: "anthropic-messages",
          ...(scenario.tool ? { FAKE_PI_TOOL_BEFORE_FAILURE: scenario.tool } : {}),
        },
      });

      assert.equal(execution.ok, true, execution.stderr);
      const terminal = readJson<Record<string, unknown>>(join(plan.runtimeRoot, "terminal.json"));
      assert.equal(terminal.ok, false);
      assert.equal(terminal.error, `Pi RPC assistant ended with ${stopReason}`);
      assert.equal(terminal.failureStage, "agent-run");
      assert.equal(terminal.failureDomain, stopReason === "error" ? "provider" : "runner_internal");
      assert.equal(terminal.failureCode, scenario.code);
      assert.equal(terminal.retryable, scenario.retryable);
      assert.equal(terminal.providerApi, "anthropic-messages");
      assert.equal(terminal.phase, scenario.phase);
      assert.equal(terminal.turnCount, 1);
      assert.equal(terminal.assistantMessageCount, 1);
      assert.equal(terminal.toolExecutionCount, scenario.tool ? 1 : 0);
      assert.equal(terminal.toolErrorCount, scenario.tool === "error" ? 1 : 0);
      assert.equal(terminal.transcriptSizeBucket, "lt64k");
      assert.match(String(terminal.diagnosticFingerprint), /^[0-9a-f]{64}$/);
      assert.deepEqual(terminal.childExit, { code: 0, signal: null });
      assert.equal(terminal.agentSettled, true);
      const events = readFileSync(join(plan.runtimeRoot, "runtime-events.jsonl"), "utf8");
      assert.match(events, new RegExp(`"type":"message_end".*"role":"assistant".*"stopReason":"${stopReason}"`));
      assert.equal(existsSync(fixture.attempt.resultPath), false);
      for (const path of filesUnder(plan.runtimeRoot)) assert.equal(readFileSync(path, "utf8").includes(sentinel), false, path);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("tool completion followed by child exit is classified as a lost Provider continuation", () => {
  const fixture = rpcFixture();
  try {
    const { execution, plan } = runWorkerFault(fixture, {
      FAKE_PI_TOOL_BEFORE_FAILURE: "success",
      FAKE_PI_CONTINUATION_LOST: "1",
    });
    assert.equal(execution.ok, false);
    const terminal = readJson<Record<string, unknown>>(join(plan.runtimeRoot, "terminal.json"));
    assert.equal(terminal.ok, false);
    assert.equal(terminal.failureCode, "provider_continuation_lost");
    assert.deepEqual(stableFailure(terminal), {
      domain: "observation",
      code: "provider_continuation_lost",
      stage: "agent-run",
      retryable: false,
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a single RPC event over 1 MiB produces a bounded oversize receipt", () => {
  const fixture = rpcFixture();
  try {
    const { execution, plan } = runWorkerFault(fixture, { FAKE_PI_OVERSIZE_EVENT: "1" });
    assert.equal(execution.ok, false);
    const terminal = readJson<Record<string, unknown>>(join(plan.runtimeRoot, "terminal.json"));
    assert.equal(terminal.failureCode, "rpc_event_oversize");
    assert.deepEqual(stableFailure(terminal), {
      domain: "observation",
      code: "rpc_event_oversize",
      stage: "agent-run",
      retryable: false,
    });
    assert.ok(readFileSync(join(plan.runtimeRoot, "runtime-events.jsonl"), "utf8").length < 512 * 1024);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fault fixtures reproduce runtime stalls and result-without-terminal observation gaps", async () => {
  for (const [fault, resultExpected] of [
    ["FAKE_PI_PROVIDER_NEVER_RETURNS", false],
    ["FAKE_PI_RESULT_BEFORE_STALL", true],
  ] as const) {
    const fixture = rpcFixture();
    let child: ReturnType<typeof spawn> | null = null;
    let exit: Promise<number | null> | null = null;
    try {
      const plan = prepareWorkerFault(fixture);
      const running = spawn(process.execPath, [
        resolve("dist/src/pi-rpc-runner.js"),
        "--sdk-entry", resolve("test/fixtures/pi-rpc-sdk-entry.js"),
        "--plan", join(plan.runtimeRoot, "plan.json"),
      ], {
        cwd: fixture.root,
        env: {
          ...process.env,
          FAKE_PI_RESULT_PATH: fixture.attempt.resultPath,
          FAKE_PI_JOB_ID: "job-1",
          FAKE_PI_ATTEMPT_ID: fixture.attempt.id,
          [fault]: "1",
        },
        stdio: "ignore",
      });
      child = running;
      exit = new Promise<number | null>((resolveExit) => running.on("exit", resolveExit));
      await waitForFile(resultExpected ? fixture.attempt.resultPath : join(plan.runtimeRoot, "accepted.json"));
      assert.equal(existsSync(fixture.attempt.resultPath), resultExpected, fault);
      assert.equal(existsSync(join(plan.runtimeRoot, "terminal.json")), false, fault);

      writeExclusiveJson(join(plan.runtimeRoot, "terminate.json"), {
        ...receiptIdentity(plan),
        reason: "recovery",
      });
      const code = await exit;
      assert.equal(code, 0);
      assert.deepEqual(stableFailure(readJson<Record<string, unknown>>(join(plan.runtimeRoot, "terminal.json"))), {
        domain: "execution",
        code: "runtime_terminated",
        stage: "agent-run",
        retryable: false,
      });
    } finally {
      if (child && exit) {
        child.kill("SIGKILL");
        await exit;
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("pre-dispatch termination still writes a classified failure receipt", async () => {
  const fixture = rpcFixture();
  let child: ReturnType<typeof spawn> | null = null;
  let exit: Promise<number | null> | null = null;
  try {
    const plan = prepareWorkerFault(fixture, false);
    const running = spawn(process.execPath, [
      resolve("dist/src/pi-rpc-runner.js"),
      "--sdk-entry", resolve("test/fixtures/pi-rpc-sdk-entry.js"),
      "--plan", join(plan.runtimeRoot, "plan.json"),
    ], { cwd: fixture.root, stdio: "ignore" });
    child = running;
    exit = new Promise<number | null>((resolveExit) => running.on("exit", resolveExit));
    await waitForFile(join(plan.runtimeRoot, "ready.json"));
    writeExclusiveJson(join(plan.runtimeRoot, "terminate.json"), { ...receiptIdentity(plan), reason: "recovery" });
    assert.equal(await exit, 0);
    assert.deepEqual(stableFailure(readJson<Record<string, unknown>>(join(plan.runtimeRoot, "terminal.json"))), {
      domain: "execution",
      code: "runtime_terminated",
      stage: "await-dispatch",
      retryable: false,
    });
  } finally {
    if (child && exit) {
      child.kill("SIGKILL");
      await exit;
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("durable runner redacts malformed Provider output before ready or after settlement", () => {
  const sentinel = "access_token_SENTINEL";
  for (const phase of ["before-ready", "after-settled"] as const) {
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
    } finally {
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
  for (const [malformedVariable, expectedCode] of [
    ["FAKE_PI_MALFORMED_AFTER_PROMPT", "rpc_invalid_json"],
    ["FAKE_PI_MALFORMED_AFTER_SETTLED", "rpc_invalid_json"],
    ["FAKE_PI_INCOMPLETE_AFTER_SETTLED", "rpc_incomplete_jsonl"],
  ] as const) {
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
      const terminal = readJson<Record<string, unknown>>(join(plan.runtimeRoot, "terminal.json"));
      assert.equal(terminal.ok, false);
      assert.equal(terminal.failureDomain, "rpc_protocol");
      assert.equal(terminal.failureCode, expectedCode);
      assert.equal(terminal.retryable, false);
      if (malformedVariable === "FAKE_PI_MALFORMED_AFTER_PROMPT") {
        assert.equal(terminal.failureStage, "agent-run");
      } else {
        assert.match(String(terminal.failureStage), /^(?:agent-run|rpc-output)$/);
      }
      assert.equal(terminal.agentSettled, malformedVariable !== "FAKE_PI_MALFORMED_AFTER_PROMPT");
      assert.equal(terminal.agentEndObserved, malformedVariable !== "FAKE_PI_MALFORMED_AFTER_PROMPT");
      assert.equal(terminal.lastEventType, malformedVariable === "FAKE_PI_MALFORMED_AFTER_PROMPT" ? "turn_start" : "agent_settled");
      assert.match(String(terminal.diagnosticFingerprint), /^[0-9a-f]{64}$/);
      assert.equal(readJson<{ ok: boolean }>(join(plan.runtimeRoot, "terminated.json")).ok, true);
    } finally {
      restoreEnv("FAKE_PI_RESULT_PATH", previous.result);
      restoreEnv("FAKE_PI_JOB_ID", previous.job);
      restoreEnv("FAKE_PI_ATTEMPT_ID", previous.attempt);
      restoreEnv(malformedVariable, previous.malformed);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("durable runner handles child exit races and records sanitized failures", async () => {
  const sentinel = "PROVIDER_SECRET_SENTINEL";
  for (const [mode, expected, ok] of [
    ["success", { code: 0, signal: null }, true],
    ["code", { code: 23, signal: null }, false],
    ["signal", { code: null, signal: "SIGTERM" }, false],
  ] as const) {
    const fixture = rpcFixture();
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

      const execution = new SyncCommandRunner().run(process.execPath, [
        resolve("dist/src/pi-rpc-runner.js"),
        "--sdk-entry", resolve("test/fixtures/pi-rpc-sdk-entry.js"),
        "--plan", join(plan.runtimeRoot, "plan.json"),
      ], {
        cwd: fixture.root,
        timeoutMs: 10_000,
        env: {
          ...process.env,
          FAKE_PI_RESULT_PATH: fixture.attempt.resultPath,
          FAKE_PI_JOB_ID: "job-1",
          FAKE_PI_ATTEMPT_ID: fixture.attempt.id,
          FAKE_PI_EXIT_AFTER_SETTLED: mode,
          FAKE_PI_EXIT_STDERR: sentinel,
        },
      });

      assert.equal(execution.ok, ok, mode);
      const terminal = readJson<Record<string, unknown>>(join(plan.runtimeRoot, "terminal.json"));
      if (ok) {
        assert.deepEqual(terminal, { ...receiptIdentity(plan), ok: true, agentSettled: true });
      } else {
        assert.equal(terminal.ok, false);
        assert.equal(terminal.error, "Pi RPC runner failed");
        assert.equal(terminal.failureStage, "child-exit");
        assert.equal(terminal.failureDomain, "child_process");
        assert.equal(terminal.failureCode, "child_exit_after_settled");
        assert.equal(terminal.retryable, false);
        assert.equal(terminal.agentSettled, true);
        assert.equal(terminal.agentEndObserved, true);
        assert.equal(terminal.lastEventType, "agent_settled");
        assert.deepEqual(terminal.childExit, expected);
        assert.match(String(terminal.diagnosticFingerprint), /^[0-9a-f]{64}$/);
        await assert.rejects(() => new PiRpcRuntime({ runInPane: async () => undefined }).wait({
          handle: fixture.handle,
          attempt: fixture.attempt,
          resultPath: fixture.attempt.resultPath,
          expectedJobId: "job-1",
          expectedAttemptId: fixture.attempt.id,
          expectedLane: "worker",
        }), new RegExp(`Pi RPC runner failed \\(execution/child_exit, retryable=no, detail=child_process/child_exit_after_settled, stage=child-exit, child=${mode === "code" ? "exit:23" : "signal:SIGTERM"}, fingerprint=[0-9a-f]{12}\\)`));
      }
      for (const path of filesUnder(plan.runtimeRoot)) assert.equal(readFileSync(path, "utf8").includes(sentinel), false, path);
    } finally {
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
    const code = await new Promise<number | null>((resolveExit) => child.on("exit", resolveExit));

    assert.equal(code, 0);
    assert.equal(readJson<{ ok: boolean }>(join(plan.runtimeRoot, "terminal.json")).ok, false);
    assert.equal(readJson<{ ok: boolean }>(join(plan.runtimeRoot, "terminated.json")).ok, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function rpcFixture(): {
  root: string;
  runtimeRoot: string;
  handle: AgentHandle;
  snapshot: ExecutionSnapshot & { adapter: "pi-rpc" };
  attempt: Attempt;
  plan(overrides?: Partial<Pick<ExecutionSnapshot, "executable" | "argv">>): PiRpcPlan;
} {
  const root = mkdtempSync(join(tmpdir(), "harness-rpc-"));
  const attemptRoot = join(root, "attempt");
  const runtimeRoot = join(attemptRoot, "runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const handle = { agentName: "worker-1", paneId: "pane-1", tabId: "tab-1", workspaceId: "workspace-1" };
  const snapshot: ExecutionSnapshot & { adapter: "pi-rpc" } = {
    version: 1,
    adapter: "pi-rpc",
    executable: "/opt/pi",
    runtimeVersion: "0.84.2",
    argv: ["--no-session", "--no-context-files", "--no-prompt-templates", "--no-themes", "--provider", "test", "--model", "model", "--mode", "rpc"],
    provider: "test",
    model: "model",
    thinking: "high",
    tools: ["read", "bash", "worker_submit"],
    sessionMode: "ephemeral",
    retryMode: "disabled",
    compactionMode: "controlled-threshold",
    compactionPolicy: {
      triggerPercent: 75,
      maxCompactions: 1,
      keepRecentTokens: 20_000,
      overflowContinuation: false,
    },
    credentialMode: "canonical-oauth",
    dockerHost: null,
    resources: [
      ...["implement", "tdd", "focused-self-check"].map((name) => ({
        kind: "skill" as const,
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
  const attempt: Attempt = {
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
    contextEnvelope: {
      version: 1,
      identity: {
        jobId: "job-1",
        sourceJobRevision: 1,
        attemptId: "worker-1",
        lane: "worker",
        round: 1,
        taskDigest: "f".repeat(64),
        preparedAt: "2026-08-09T00:00:00.000Z",
      },
      authority: {
        roleResources: [],
        repositoryPolicy: {
          trustAnchorSha: "a".repeat(40),
          entries: [],
          bundleDigest: "c".repeat(64),
          manifestDigest: "d".repeat(64),
        },
      },
      task: {
        repo: "owner/repo",
        issueNumber: 1,
        mapNumber: null,
        title: "Task",
        objective: "Implement the task with exact acceptance criteria.",
        labels: ["ready-for-agent"],
        issueUpdatedAt: "2026-08-09T00:00:00.000Z",
        digest: "f".repeat(64),
        trust: "untrusted-task-data",
      },
      target: {
        branch: "agent/issue-1",
        baseSha: "a".repeat(40),
        expectedHeadSha: null,
        expectedRemoteHeadSha: null,
      },
      handoff: null,
      evidence: {
        trust: "untrusted-evidence",
        refs: [],
        reviewEvidencePath: null,
        validationArgv: null,
      },
      runtime: {
        snapshotDigest: "0".repeat(64),
        adapter: "pi-rpc",
        runtimeVersion: "0.84.2",
        provider: "test",
        model: "model",
        thinking: "high",
        tools: ["read", "bash", "worker_submit"],
        sessionMode: "ephemeral",
        retryMode: "disabled",
        compactionMode: "controlled-threshold",
        compactionPolicy: {
          triggerPercent: 75,
          maxCompactions: 1,
          keepRecentTokens: 20_000,
          overflowContinuation: false,
        },
        credentialMode: "canonical-oauth",
      },
      writeback: { tool: "worker_submit", statuses: ["completed", "blocked", "failed"] },
    },
    contextEnvelopeDigest: "1".repeat(64),
    handle,
    result: null,
    reconciliationAttempts: 0,
    startedAt: "2026-08-09T00:00:00.000Z",
    completedAt: null,
  };
  const plan = (overrides: Partial<Pick<ExecutionSnapshot, "executable" | "argv">> = {}): PiRpcPlan => {
    const effectiveSnapshot = { ...snapshot, ...overrides };
    const pinnedContent = `<harness-pinned-task-data>${attempt.id}</harness-pinned-task-data>`;
    return {
      version: 1,
      attemptId: attempt.id,
      generation: rpcGeneration(attempt.id, attempt.planDigest!, handle),
      planDigest: attempt.planDigest!,
      promptDigest: attempt.promptDigest,
      handle,
      cwd: root,
      resultPath: attempt.resultPath,
      runtimeRoot,
      ...(effectiveSnapshot.context?.lane === "worker" ? {
        pinnedTaskData: { version: 1, digest: digest(pinnedContent), content: pinnedContent },
      } : {}),
      snapshot: effectiveSnapshot,
    };
  };
  return { root, runtimeRoot, handle, snapshot, attempt, plan };
}

function reviewerPlan(fixture: ReturnType<typeof rpcFixture>): { plan: PiRpcPlan; modelsPath: string; modelsContent: string } {
  const agentDir = fixture.snapshot.context!.agentDir;
  mkdirSync(agentDir, { recursive: true });
  const modelsPath = join(agentDir, "models.json");
  const modelsContent = '{"providers":{"custom":{"apiKey":"REVIEWER_SECRET","models":[]}}}\n';
  writeFileSync(modelsPath, modelsContent, { mode: 0o600 });
  fixture.snapshot.context!.lane = "reviewer";
  fixture.snapshot.compactionMode = "disabled";
  delete fixture.snapshot.compactionPolicy;
  fixture.snapshot.credentialMode = "canonical-model-config";
  fixture.snapshot.thinking = "max";
  fixture.snapshot.tools = ["read", "subagent", "review_submit"];
  fixture.snapshot.resources = [
    { kind: "skill", path: "/skills/code-review", digest: "e".repeat(64) },
    executionResource("model-config", modelsPath),
    runtimeResource(resolve("dist/src/pi-rpc-runner.js")),
    runtimeResource(resolve("test/fixtures/pi-rpc-sdk-entry.js")),
  ];
  fixture.attempt.id = "reviewer-1";
  fixture.attempt.lane = "reviewer";
  fixture.attempt.expectedHeadSha = "b".repeat(40);
  fixture.attempt.promptDigest = digest("review");
  return {
    modelsPath,
    modelsContent,
    plan: fixture.plan({
      executable: process.execPath,
      argv: [
        resolve("test/fixtures/fake-pi-rpc.js"),
        "--no-session", "--no-context-files", "--no-prompt-templates", "--no-themes",
        "--provider", "test", "--model", "model", "--thinking", "max", "--mode", "rpc",
      ],
    }),
  };
}

function receiptIdentity(plan: PiRpcPlan): Record<string, unknown> {
  return { version: 1, attemptId: plan.attemptId, generation: plan.generation, planDigest: plan.planDigest };
}

function stableFailure(receipt: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(["domain", "code", "stage", "retryable"].map((key) => [key, receipt[key]]));
}

function runWorkerFault(
  fixture: ReturnType<typeof rpcFixture>,
  env: Record<string, string>,
): { plan: PiRpcPlan; execution: ReturnType<SyncCommandRunner["run"]> } {
  const plan = prepareWorkerFault(fixture);
  return {
    plan,
    execution: new SyncCommandRunner().run(process.execPath, [
      resolve("dist/src/pi-rpc-runner.js"),
      "--sdk-entry", resolve("test/fixtures/pi-rpc-sdk-entry.js"),
      "--plan", join(plan.runtimeRoot, "plan.json"),
    ], {
      cwd: fixture.root,
      timeoutMs: 10_000,
      env: {
        ...process.env,
        FAKE_PI_RESULT_PATH: fixture.attempt.resultPath,
        FAKE_PI_JOB_ID: "job-1",
        FAKE_PI_ATTEMPT_ID: fixture.attempt.id,
        ...env,
      },
    }),
  };
}

function prepareWorkerFault(fixture: ReturnType<typeof rpcFixture>, dispatch = true): PiRpcPlan {
  const plan = fixture.plan({
    executable: process.execPath,
    argv: [
      resolve("test/fixtures/fake-pi-rpc.js"),
      "--no-session", "--no-context-files", "--no-prompt-templates", "--no-themes",
      "--provider", "test", "--model", "model", "--mode", "rpc",
    ],
  });
  writeExclusiveJson(join(plan.runtimeRoot, "plan.json"), plan);
  if (dispatch) {
    writeExclusiveJson(join(plan.runtimeRoot, "dispatch.json"), {
      version: 1,
      attemptId: plan.attemptId,
      generation: plan.generation,
      planDigest: plan.planDigest,
      dispatchId: plan.attemptId,
      promptDigest: fixture.attempt.promptDigest,
      message: "/skill:implement [harness-dispatch:worker-1]\nimplement",
    });
  }
  return plan;
}

function runtimeResource(path: string): { kind: "runtime"; path: string; digest: string } {
  return { kind: "runtime", path, digest: executionResourceDigest(dirname(path)) };
}

function workerResult(attemptId: string): Record<string, unknown> {
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return lstatSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}
