import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Tool = {
  execute(id: string, params: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    details?: unknown;
    isError?: boolean;
  }>;
};

type ToolCallEvent = { toolCallId: string; toolName: string; input: Record<string, unknown> };
type ToolResultEvent = ToolCallEvent & {
  content: Array<{ type: string; text: string }>;
  details: unknown;
  isError: boolean;
};
type ToolCallHook = (event: ToolCallEvent) => Promise<{ block: true; reason: string } | undefined>;
type ToolResultHook = (event: ToolResultEvent) => Promise<{
  content?: Array<{ type: string; text: string }>;
  details?: unknown;
  isError?: boolean;
} | undefined> | undefined;

const reviewTasks = [
  { agent: "herdr-harness-review-axis", task: "Axis: Standards\nReview repository standards." },
  { agent: "herdr-harness-review-axis", task: "Axis: Spec\nReview the supplied specification." },
];

function reviewWorkflowScript(tasks = reviewTasks): string {
  const entries = tasks.map((task, index) => ({ key: index === 0 ? "standards" : "spec", ...task }));
  return `return await runs.all(${JSON.stringify(entries)});`;
}

const reviewCall = {
  artifacts: false,
  agentScope: "project",
  context: "fresh",
  async: false,
  chatProgress: "off",
  workflowScript: reviewWorkflowScript(),
};

test("Reviewer tools isolate validation and write one identity-bound result", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-review-tools-"));
  const source = join(root, "source");
  const validation = join(root, "validation");
  const scratch = join(root, "scratch");
  const dockerConfig = join(root, "docker-config");
  const resultPath = join(root, "result.json");
  const descriptorPath = join(root, "descriptor.json");
  const previousDescriptor = process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR;
  const previousSecret = process.env.HERDR_REVIEWER_TEST_SECRET;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOriginalAgentDir = process.env.HERDR_HARNESS_REVIEW_ORIGINAL_PI_AGENT_DIR;
  const previousCanonicalAgentDir = process.env.HERDR_HARNESS_REVIEW_CANONICAL_PI_AGENT_DIR;
  const previousSubagentPiBinary = process.env.PI_SUBAGENT_PI_BINARY;
  const previousPiPackageRoot = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
  try {
    for (const path of [source, validation, dockerConfig, join(scratch, "home"), join(scratch, "tmp"), join(scratch, "cache"), join(scratch, "pycache")]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(join(source, "product.txt"), "source\n");
    writeFileSync(join(validation, "product.txt"), "source\n");
    const runtime = prepareReviewRuntime(root, source);
    writeFileSync(descriptorPath, JSON.stringify({
      version: 1,
      jobId: "job-1",
      attemptId: "reviewer-1",
      reviewedHeadSha: "b".repeat(40),
      validationArgv: [
        "/usr/bin/env",
        `DOCKER_CONFIG=${dockerConfig}`,
        process.execPath,
        "-e",
        "const fs=require('node:fs');fs.writeFileSync('validation-only.txt','ok');fs.writeFileSync('validation-env.json',JSON.stringify(process.env));process.stdout.write('x'.repeat(100000)+'STDOUT_END');process.stderr.write('y'.repeat(100000)+'STDERR_END')",
      ],
      dockerHost: null,
      piAgentDir: join(root, "original-agent"),
      ...runtime,
      validationPath: validation,
      scratchPath: scratch,
      resultPath,
    }));
    process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR = descriptorPath;
    const originalAgentDir = join(root, "original-agent");
    mkdirSync(join(originalAgentDir, "extensions", "subagent"), { recursive: true });
    writeFileSync(join(originalAgentDir, "extensions", "subagent", "config.json"), JSON.stringify({
      forceTopLevelAsync: true,
      fleetView: true,
      intercomBridge: { mode: "always", instructionFile: "candidate-controlled.md" },
    }));
    const privateAgentDir = join(root, "top-level-private-agent");
    mkdirSync(privateAgentDir);
    process.env.PI_CODING_AGENT_DIR = privateAgentDir;
    process.env.HERDR_HARNESS_REVIEW_CANONICAL_PI_AGENT_DIR = originalAgentDir;
    process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = join(root, "malicious-pi-package");
    const configExtension = await import(pathToFileURL(resolve("pi/extensions/reviewer-subagent-config.js")).href) as {
      default(): void;
    };
    configExtension.default();
    assert.equal(process.env.PI_CODING_AGENT_DIR, realpathSync(runtime.subagentConfigDir));
    assert.equal(process.env.HERDR_HARNESS_REVIEW_CANONICAL_PI_AGENT_DIR, undefined);
    assert.equal(process.env.PI_SUBAGENT_PI_BINARY, realpathSync(runtime.piSubagentWrapperPath));
    assert.equal(process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT, undefined);

    const tools = new Map<string, Tool>();
    let toolCallHook: ToolCallHook | undefined;
    let toolResultHook: ToolResultHook | undefined;
    const subagentExtension = await import(pathToFileURL(resolve("test/fixtures/pi-subagents/index.js")).href) as {
      default(pi: { registerTool(tool: Tool & { name: string }): void }): void;
    };
    subagentExtension.default({ registerTool(tool) { tools.set(tool.name, tool); } });
    const extension = await import(pathToFileURL(resolve("pi/extensions/reviewer-tools.js")).href) as {
      default(pi: {
        registerTool(tool: Tool & { name: string }): void;
        on(event: "tool_call", hook: ToolCallHook): void;
        on(event: "tool_result", hook: ToolResultHook): void;
      }): void;
    };
    extension.default({
      registerTool(tool) { tools.set(tool.name, tool); },
      on(event: "tool_call" | "tool_result", hook: ToolCallHook | ToolResultHook) {
        if (event === "tool_call") toolCallHook = hook as ToolCallHook;
        else toolResultHook = hook as ToolResultHook;
      },
    });
    assert.equal(process.env.PI_CODING_AGENT_DIR, originalAgentDir);
    assert.equal(process.env.PI_SUBAGENT_PI_BINARY, realpathSync(runtime.piSubagentWrapperPath));
    const preflight = tools.get("review_preflight");
    const validate = tools.get("review_validate");
    const submit = tools.get("review_submit");
    const subagent = tools.get("subagent");
    assert.ok(preflight);
    assert.ok(validate);
    assert.ok(submit);
    assert.ok(subagent);
    assert.ok(toolCallHook);
    assert.ok(toolResultHook);
    await assert.rejects(() => submit.execute("submit-before-axes", {
      status: "pass",
      summary: "premature",
      findings: [],
    }), /completed Standards and Spec/);
    await assert.rejects(() => validate.execute("validate-before-preflight", {}), /successful review_preflight/);
    assert.equal((await toolCallHook({ toolCallId: "axes-too-early", toolName: "subagent", input: reviewCall }))?.block, true);
    const preflightResult = JSON.parse((await preflight.execute("preflight", {})).content[0]?.text ?? "{}") as { ok?: boolean };
    assert.equal(preflightResult.ok, true);
    assert.equal((await toolCallHook({ toolCallId: "wrong", toolName: "subagent", input: { action: "create" } }))?.block, true);
    assert.equal((await toolCallHook({
      toolCallId: "legacy-tasks",
      toolName: "subagent",
      input: { artifacts: false, agentScope: "project", context: "fresh", async: false, tasks: reviewTasks },
    }))?.block, true);
    assert.equal((await toolCallHook({
      toolCallId: "arbitrary-script",
      toolName: "subagent",
      input: { ...reviewCall, workflowScript: `${reviewWorkflowScript()} console.log("unexpected")` },
    }))?.block, true);
    assert.equal((await toolCallHook({
      toolCallId: "unsafe-scope",
      toolName: "subagent",
      input: { ...reviewCall, agentScope: "both" },
    }))?.block, true);
    assert.equal((await toolCallHook({
      toolCallId: "wrong-agent",
      toolName: "subagent",
      input: {
        artifacts: false,
        agentScope: "project",
        context: "fresh",
        async: false,
        chatProgress: "off",
        workflowScript: reviewWorkflowScript([
          { agent: "worker", task: "write" },
          { agent: "herdr-harness-review-axis", task: "Axis: Spec\nReview" },
        ]),
      },
    }))?.block, true);
    const boundAgent = readFileSync(runtime.reviewAxisAgentPath, "utf8");
    chmodSync(runtime.reviewAxisAgentPath, 0o600);
    writeFileSync(runtime.reviewAxisAgentPath, `${boundAgent}\ntampered\n`);
    const drift = await toolCallHook({ toolCallId: "drift", toolName: "subagent", input: { ...reviewCall } });
    assert.match(drift?.reason ?? "", /snapshot changed/);
    writeFileSync(runtime.reviewAxisAgentPath, boundAgent);
    chmodSync(runtime.reviewAxisAgentPath, 0o400);
    const boundPi = readFileSync(runtime.piExecutable, "utf8");
    chmodSync(runtime.piExecutable, 0o700);
    writeFileSync(runtime.piExecutable, "#!/bin/sh\nprintf '0.85.0\\n'\n");
    chmodSync(runtime.piExecutable, 0o500);
    const runtimeDrift = await toolCallHook({ toolCallId: "runtime-drift", toolName: "subagent", input: { ...reviewCall } });
    assert.match(runtimeDrift?.reason ?? "", /runtime version changed/);
    chmodSync(runtime.piExecutable, 0o700);
    writeFileSync(runtime.piExecutable, boundPi);
    chmodSync(runtime.piExecutable, 0o500);
    const defaultedScopeReviewCall: Record<string, unknown> = {
      artifacts: false,
      context: "fresh",
      async: false,
      chatProgress: "off",
      workflowScript: reviewWorkflowScript(),
    };
    assert.equal((await toolCallHook({
      toolCallId: "axes",
      toolName: "subagent",
      input: defaultedScopeReviewCall,
    })), undefined);
    assert.equal(defaultedScopeReviewCall.agentScope, "project");
    assert.equal(defaultedScopeReviewCall.cwd, runtime.runtimePath);
    assert.equal(defaultedScopeReviewCall.foregroundOnly, true);
    const transformedTasks = workflowEntries(defaultedScopeReviewCall.workflowScript).map((entry) => entry.task);
    assert.equal(transformedTasks.every((task) => task.includes(`Read-only candidate source root: ${source}`)), true);
    assert.equal((await toolCallHook({ toolCallId: "axes-again", toolName: "subagent", input: reviewCall }))?.block, true);

    await toolResultHook({
      toolCallId: "axes",
      toolName: "subagent",
      input: defaultedScopeReviewCall,
      content: [],
      isError: false,
      details: {
        mode: "workflow",
        results: transformedTasks.map((task, index) => ({
          agent: "herdr-harness-review-axis",
          task,
          index,
          exitCode: index,
          finalOutput: index === 0 ? "Standards: no findings" : "Spec provider failed",
        })),
      },
    });
    await assert.rejects(() => submit.execute("submit-after-failed-axis", {
      status: "pass",
      summary: "one axis failed",
      findings: [],
    }), /completed Standards and Spec/);

    const workflowResult = await subagent.execute("axes", defaultedScopeReviewCall);
    const oversizedDetails = {
      ...(workflowResult.details as { mode: string; results: Array<Record<string, unknown>> }),
      results: (workflowResult.details as { results: Array<Record<string, unknown>> }).results.map((result, index) => ({
        ...result,
        finalOutput: `${index === 0 ? "S" : "P"}`.repeat(100_000) + `_AXIS_${index}_END`,
      })),
    };
    const projectedAxes = await toolResultHook({
      toolCallId: "axes",
      toolName: "subagent",
      input: defaultedScopeReviewCall,
      content: [{ type: "text", text: "unbounded child transcript".repeat(20_000) }],
      isError: workflowResult.isError === true,
      details: oversizedDetails,
    });
    assert.ok(projectedAxes);
    assert.equal(projectedAxes.isError, false);
    assert.ok(Buffer.byteLength(projectedAxes.content?.[0]?.text ?? "") <= 32 * 1024);
    const projectedDetails = projectedAxes.details as { mode: string; results: Array<Record<string, unknown>> };
    assert.equal(projectedDetails.mode, "workflow");
    assert.equal(projectedDetails.results.length, 2);
    for (const [index, projected] of projectedDetails.results.entries()) {
      assert.deepEqual(Object.keys(projected).sort(), ["axis", "exitCode", "finalOutput", "outputBytes", "outputDigest"]);
      assert.ok(Buffer.byteLength(String(projected.finalOutput)) <= 12 * 1024);
      assert.match(String(projected.finalOutput), new RegExp(`_AXIS_${index}_END$`));
      assert.equal(projected.outputBytes, 100_011);
      assert.match(String(projected.outputDigest), /^[0-9a-f]{64}$/);
    }

    await assert.rejects(() => submit.execute("submit-before-validation", {
      status: "pass",
      summary: "premature",
      findings: [],
    }), /requires a review_validate run/);
    process.env.HERDR_REVIEWER_TEST_SECRET = "must-not-leak";
    const validationResult = await validate.execute("validate", {});
    const validationDetails = JSON.parse(validationResult.content[0]?.text ?? "{}") as Record<string, unknown>;
    assert.ok(Buffer.byteLength(String(validationDetails.stdout)) <= 8 * 1024);
    assert.ok(Buffer.byteLength(String(validationDetails.stderr)) <= 8 * 1024);
    assert.match(String(validationDetails.stdout), /\[truncated\]\n.*STDOUT_END$/s);
    assert.match(String(validationDetails.stderr), /\[truncated\]\n.*STDERR_END$/s);
    assert.equal(validationDetails.stdoutBytes, 100010);
    assert.equal(validationDetails.stderrBytes, 100010);
    assert.match(String(validationDetails.stdoutDigest), /^[0-9a-f]{64}$/);
    assert.match(String(validationDetails.stderrDigest), /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(join(validation, "validation-only.txt"), "utf8"), "ok");
    assert.equal(readFileSync(join(source, "product.txt"), "utf8"), "source\n");
    const validationEnv = JSON.parse(readFileSync(join(validation, "validation-env.json"), "utf8")) as Record<string, string>;
    assert.equal(validationEnv.HERDR_REVIEWER_TEST_SECRET, undefined);
    assert.equal(validationEnv.HOME, join(scratch, "home"));
    assert.equal(validationEnv.TMPDIR, join(scratch, "tmp"));
    assert.equal(validationEnv.TMP, join(scratch, "tmp"));
    assert.equal(validationEnv.TEMP, join(scratch, "tmp"));
    assert.equal(validationEnv.DOCKER_CONFIG, dockerConfig);

    await submit.execute("submit", { status: "pass", summary: "accepted", findings: [] });
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(result, {
      version: 1,
      jobId: "job-1",
      attemptId: "reviewer-1",
      lane: "reviewer",
      status: "pass",
      summary: "accepted",
      reviewedHeadSha: "b".repeat(40),
      findings: [],
    });
    assert.equal(readdirSync(root).some((name) => name.endsWith(".tmp")), false);
    await assert.rejects(() => submit.execute("submit-again", {
      status: "changes",
      summary: "overwrite",
      findings: [],
    }), /already submitted/);
  } finally {
    if (previousDescriptor === undefined) delete process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR;
    else process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR = previousDescriptor;
    if (previousSecret === undefined) delete process.env.HERDR_REVIEWER_TEST_SECRET;
    else process.env.HERDR_REVIEWER_TEST_SECRET = previousSecret;
    restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
    restoreEnv("HERDR_HARNESS_REVIEW_ORIGINAL_PI_AGENT_DIR", previousOriginalAgentDir);
    restoreEnv("HERDR_HARNESS_REVIEW_CANONICAL_PI_AGENT_DIR", previousCanonicalAgentDir);
    restoreEnv("PI_SUBAGENT_PI_BINARY", previousSubagentPiBinary);
    restoreEnv("PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT", previousPiPackageRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reviewer environment preflight blocks review axes but still permits a durable blocked result", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-review-preflight-failure-"));
  const descriptorPath = join(root, "descriptor.json");
  const resultPath = join(root, "result.json");
  const previousDescriptor = process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOriginalAgentDir = process.env.HERDR_HARNESS_REVIEW_ORIGINAL_PI_AGENT_DIR;
  const previousSubagentPiBinary = process.env.PI_SUBAGENT_PI_BINARY;
  const previousPiPackageRoot = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
  try {
    for (const path of ["source", "validation", "scratch", "scratch/home", "scratch/tmp", "scratch/cache", "scratch/pycache"]) {
      mkdirSync(join(root, path), { recursive: true });
    }
    const runtime = prepareReviewRuntime(root, join(root, "source"));
    writeFileSync(descriptorPath, JSON.stringify({
      version: 1,
      jobId: "job-2",
      attemptId: "reviewer-2",
      reviewedHeadSha: "c".repeat(40),
      validationArgv: ["definitely-missing-review-command"],
      dockerHost: null,
      piAgentDir: join(root, "original-agent"),
      ...runtime,
      validationPath: join(root, "validation"),
      scratchPath: join(root, "scratch"),
      resultPath,
    }));
    process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR = descriptorPath;
    const originalAgentDir = join(root, "original-agent");
    mkdirSync(originalAgentDir);
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    const configExtension = await import(pathToFileURL(resolve("pi/extensions/reviewer-subagent-config.js")).href) as {
      default(): void;
    };
    configExtension.default();

    const tools = new Map<string, Tool>();
    let toolCallHook: ToolCallHook | undefined;
    const extension = await import(pathToFileURL(resolve("pi/extensions/reviewer-tools.js")).href) as {
      default(pi: {
        registerTool(tool: Tool & { name: string }): void;
        on(event: "tool_call" | "tool_result", hook: ToolCallHook | ToolResultHook): void;
      }): void;
    };
    extension.default({
      registerTool(tool) { tools.set(tool.name, tool); },
      on(event, hook) { if (event === "tool_call") toolCallHook = hook as ToolCallHook; },
    });

    const preflight = tools.get("review_preflight");
    const submit = tools.get("review_submit");
    assert.ok(preflight);
    assert.ok(submit);
    assert.ok(toolCallHook);
    const failure = JSON.parse((await preflight.execute("preflight", {})).content[0]?.text ?? "{}") as { ok?: boolean; error?: string };
    assert.equal(failure.ok, false);
    assert.match(failure.error ?? "", /validation executable is unavailable/);
    assert.equal((await toolCallHook({ toolCallId: "axes", toolName: "subagent", input: reviewCall }))?.block, true);

    await submit.execute("blocked", {
      status: "blocked",
      summary: failure.error ?? "Reviewer environment unavailable",
      findings: [],
    });
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as { status?: string };
    assert.equal(result.status, "blocked");
  } finally {
    if (previousDescriptor === undefined) delete process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR;
    else process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR = previousDescriptor;
    restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
    restoreEnv("HERDR_HARNESS_REVIEW_ORIGINAL_PI_AGENT_DIR", previousOriginalAgentDir);
    restoreEnv("PI_SUBAGENT_PI_BINARY", previousSubagentPiBinary);
    restoreEnv("PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT", previousPiPackageRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

function workflowEntries(script: unknown): Array<{ key: string; agent: string; task: string }> {
  if (typeof script !== "string") throw new Error("workflowScript must be a string");
  const prefix = "return await runs.all(";
  const suffix = ");";
  assert.equal(script.startsWith(prefix), true);
  assert.equal(script.endsWith(suffix), true);
  return JSON.parse(script.slice(prefix.length, -suffix.length)) as Array<{ key: string; agent: string; task: string }>;
}

function prepareReviewRuntime(root: string, reviewPath: string): {
  reviewPath: string;
  runtimePath: string;
  reviewAxisAgentPath: string;
  reviewAxisAgentDigest: string;
  subagentConfigDir: string;
  subagentConfigPath: string;
  subagentConfigDigest: string;
  emptyAppendSystemPromptPath: string;
  emptyAppendSystemPromptDigest: string;
  piSubagentWrapperPath: string;
  piSubagentWrapperDigest: string;
  piExecutable: string;
  piRuntimeVersion: string;
} {
  const runtimePath = join(root, "review-runtime");
  const reviewAxisAgentPath = join(runtimePath, ".agents", "herdr-harness-review-axis.md");
  const content = readFileSync(resolve("pi/agents/herdr-harness-review-axis.md"), "utf8");
  const subagentConfigDir = join(root, "subagent-config");
  const subagentConfigPath = join(subagentConfigDir, "extensions", "subagent", "config.json");
  const emptyAppendSystemPromptPath = join(runtimePath, "empty-append-system.md");
  const piSubagentWrapperPath = join(runtimePath, "pi-subagent");
  const piExecutable = join(root, "fake-pi");
  const piRuntimeVersion = "0.84.0";
  const configContent = `${JSON.stringify({
    asyncByDefault: false,
    forceTopLevelAsync: false,
    fleetView: false,
    intercomBridge: { mode: "off" },
  }, null, 2)}\n`;
  mkdirSync(join(runtimePath, ".agents"), { recursive: true });
  mkdirSync(join(subagentConfigDir, "extensions", "subagent"), { recursive: true });
  writeFileSync(reviewAxisAgentPath, content, { mode: 0o400 });
  writeFileSync(subagentConfigPath, configContent, { mode: 0o400 });
  writeFileSync(emptyAppendSystemPromptPath, "", { mode: 0o400 });
  writeFileSync(piExecutable, `#!/bin/sh\nprintf '${piRuntimeVersion}\\n'\n`, { mode: 0o500 });
  const wrapperContent = `#!/bin/sh\nactual_version=$(${JSON.stringify(piExecutable)} --version) || exit $?\nif [ "$actual_version" != ${JSON.stringify(piRuntimeVersion)} ]; then exit 70; fi\nexec ${JSON.stringify(piExecutable)} --append-system-prompt ${JSON.stringify(emptyAppendSystemPromptPath)} "$@"\n`;
  writeFileSync(piSubagentWrapperPath, wrapperContent, { mode: 0o500 });
  chmodSync(reviewAxisAgentPath, 0o400);
  chmodSync(subagentConfigPath, 0o400);
  const hash = createHash("sha256");
  hash.update(content);
  const configHash = createHash("sha256");
  configHash.update(configContent);
  const wrapperHash = createHash("sha256");
  wrapperHash.update(wrapperContent);
  const emptyAppendHash = createHash("sha256");
  emptyAppendHash.update("");
  return {
    reviewPath,
    runtimePath,
    reviewAxisAgentPath,
    reviewAxisAgentDigest: hash.digest("hex"),
    subagentConfigDir,
    subagentConfigPath,
    subagentConfigDigest: configHash.digest("hex"),
    emptyAppendSystemPromptPath,
    emptyAppendSystemPromptDigest: emptyAppendHash.digest("hex"),
    piSubagentWrapperPath,
    piSubagentWrapperDigest: wrapperHash.digest("hex"),
    piExecutable,
    piRuntimeVersion,
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
