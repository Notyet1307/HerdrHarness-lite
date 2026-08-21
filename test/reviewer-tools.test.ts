import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REVIEWER_CONTEXT_BUDGET_BYTES, REVIEWER_CONTEXT_BUDGET_RESERVE_BYTES } from "../src/reviewer-context-budget.js";

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
type ToolCallHook = (event: ToolCallEvent) => Promise<{ block: true; reason: string; terminate?: boolean } | undefined>;
type ToolResultProjection = { content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean };
type ToolResultHook = (event: ToolResultEvent) => Promise<ToolResultProjection | undefined> | undefined;

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

test("Reviewer tools read one bound validation receipt and write one identity-bound result", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-review-tools-"));
  const source = join(root, "source");
  const privateEvidenceDir = join(root, "evidence");
  const resultPath = join(root, "result.json");
  const descriptorPath = join(root, "descriptor.json");
  const previousDescriptor = process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOriginalAgentDir = process.env.HERDR_HARNESS_REVIEW_ORIGINAL_PI_AGENT_DIR;
  const previousCanonicalAgentDir = process.env.HERDR_HARNESS_REVIEW_CANONICAL_PI_AGENT_DIR;
  const previousSubagentPiBinary = process.env.PI_SUBAGENT_PI_BINARY;
  const previousPiPackageRoot = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
  const previousAxisOutputBytes = process.env.FAKE_PI_REVIEW_AXIS_OUTPUT_BYTES;
  try {
    for (const path of [source, privateEvidenceDir]) {
      mkdirSync(path, { recursive: true });
    }
    chmodSync(privateEvidenceDir, 0o700);
    writeFileSync(join(source, "product.txt"), "source\n");
    const runtime = prepareReviewRuntime(root, source);
    const descriptor = withValidationReceipt(root, {
      version: 1,
      jobId: "job-1",
      attemptId: "reviewer-1",
      reviewedHeadSha: "b".repeat(40),
      piAgentDir: join(root, "original-agent"),
      ...runtime,
      resultPath,
      privateEvidenceDir,
      initialContextBytes: 10_000,
      contextBudgetBytes: REVIEWER_CONTEXT_BUDGET_BYTES,
      contextBudgetReserveBytes: REVIEWER_CONTEXT_BUDGET_RESERVE_BYTES,
    }, "passed");
    writeFileSync(descriptorPath, JSON.stringify(descriptor));
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
    assert.equal(validate, undefined);
    assert.ok(submit);
    assert.ok(subagent);
    assert.ok(toolCallHook);
    assert.ok(toolResultHook);
    await assert.rejects(() => submit.execute("submit-before-axes", {
      status: "pass",
      summary: "premature",
      findings: [],
    }), /completed Standards and Spec/);
    assert.equal((await toolCallHook({ toolCallId: "axes-too-early", toolName: "subagent", input: reviewCall }))?.block, true);
    const preflightResult = JSON.parse((await preflight.execute("preflight", {})).content[0]?.text ?? "{}") as {
      ok?: boolean;
      validationReceipt?: { status?: string; exitCode?: number };
    };
    assert.equal(preflightResult.ok, true);
    assert.deepEqual(preflightResult.validationReceipt && {
      status: preflightResult.validationReceipt.status,
      exitCode: preflightResult.validationReceipt.exitCode,
    }, { status: "passed", exitCode: 0 });
    const largeRead = `read-head\n${"r".repeat(1024 * 1024)}\nread-tail`;
    const readProjection = await toolResultHook({
      toolCallId: "large-read",
      toolName: "read",
      input: { path: "review-evidence.txt" },
      content: [{ type: "text", text: largeRead }],
      isError: false,
      details: { private: largeRead },
    });
    assert.ok(readProjection);
    assert.ok(Buffer.byteLength(readProjection.content[0]?.text ?? "") < 20 * 1024);
    assert.equal(JSON.stringify(readProjection.details).includes("private"), false);
    assert.match(readProjection.content[0]?.text ?? "", /read-head/);
    assert.match(readProjection.content[0]?.text ?? "", /read-tail/);
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

    process.env.FAKE_PI_REVIEW_AXIS_OUTPUT_BYTES = String(1024 * 1024);
    const workflowResult = await subagent.execute("axes", defaultedScopeReviewCall);
    restoreEnv("FAKE_PI_REVIEW_AXIS_OUTPUT_BYTES", previousAxisOutputBytes);
    assert.ok(JSON.stringify(workflowResult.details).length > 2 * 1024 * 1024);
    const projectedWorkflow = await toolResultHook({
      toolCallId: "axes",
      toolName: "subagent",
      input: defaultedScopeReviewCall,
      content: workflowResult.content,
      isError: workflowResult.isError === true,
      details: workflowResult.details,
    });
    assert.ok(projectedWorkflow);
    assert.equal(projectedWorkflow.isError, undefined);
    assert.ok(Buffer.byteLength(projectedWorkflow.content[0]?.text ?? "") < 25 * 1024);
    assert.equal(JSON.stringify(projectedWorkflow.details).includes("finalOutput"), false);
    const projectedAxes = projectedWorkflow.details as Record<"Standards" | "Spec", {
      status: string;
      summary: string;
      findings: unknown[];
      evidenceRefs: unknown[];
      outputByteCount: number;
      digest: string;
      truncated: boolean;
    }>;
    for (const [axis, projection] of Object.entries(projectedAxes)) {
      assert.equal(projection.status, "pass");
      assert.equal(projection.findings.length, 0);
      assert.equal(projection.evidenceRefs.length, 0);
      assert.ok(projection.outputByteCount > 1024 * 1024);
      assert.match(projection.digest, /^[0-9a-f]{64}$/);
      assert.equal(projection.truncated, true);
      assert.match(projection.summary, new RegExp(`^${axis.toLowerCase()}-head`));
      assert.match(projection.summary, new RegExp(`${axis.toLowerCase()}-tail$`));
      assert.ok(Buffer.byteLength(JSON.stringify(projection)) <= 12 * 1024);
      const evidenceName = readdirSync(privateEvidenceDir).find((name) => name.startsWith(`axis-${axis.toLowerCase()}-`));
      assert.ok(evidenceName);
      const evidence = readFileSync(join(privateEvidenceDir, evidenceName));
      assert.equal(evidence.length, projection.outputByteCount);
      assert.equal(sha256(evidence), projection.digest);
    }

    assert.equal(readFileSync(join(source, "product.txt"), "utf8"), "source\n");

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
    restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
    restoreEnv("HERDR_HARNESS_REVIEW_ORIGINAL_PI_AGENT_DIR", previousOriginalAgentDir);
    restoreEnv("HERDR_HARNESS_REVIEW_CANONICAL_PI_AGENT_DIR", previousCanonicalAgentDir);
    restoreEnv("PI_SUBAGENT_PI_BINARY", previousSubagentPiBinary);
    restoreEnv("PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT", previousPiPackageRoot);
    restoreEnv("FAKE_PI_REVIEW_AXIS_OUTPUT_BYTES", previousAxisOutputBytes);
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
    for (const path of ["source", "evidence"]) {
      mkdirSync(join(root, path), { recursive: true });
    }
    chmodSync(join(root, "evidence"), 0o700);
    const runtime = prepareReviewRuntime(root, join(root, "source"));
    writeFileSync(descriptorPath, JSON.stringify({
      version: 1,
      jobId: "job-2",
      attemptId: "reviewer-2",
      reviewedHeadSha: "c".repeat(40),
      validationReceiptPath: join(root, "missing-validation-receipt.json"),
      validationReceiptDigest: "0".repeat(64),
      validationStatus: "passed",
      piAgentDir: join(root, "original-agent"),
      ...runtime,
      resultPath,
      privateEvidenceDir: join(root, "evidence"),
      initialContextBytes: 10_000,
      contextBudgetBytes: REVIEWER_CONTEXT_BUDGET_BYTES,
      contextBudgetReserveBytes: REVIEWER_CONTEXT_BUDGET_RESERVE_BYTES,
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
    const failure = JSON.parse((await preflight.execute("preflight", {})).content[0]?.text ?? "{}") as {
      ok?: boolean;
      error?: string;
      failure?: Record<string, unknown>;
    };
    assert.equal(failure.ok, false);
    assert.match(failure.error ?? "", /missing-validation-receipt|no such file/i);
    assert.deepEqual(failure.failure, {
      domain: "acceptance",
      code: "validation_infrastructure",
      stage: "review-preflight",
      retryable: true,
    });
    assert.equal((await toolCallHook({ toolCallId: "axes", toolName: "subagent", input: reviewCall }))?.block, true);

    await submit.execute("blocked", {
      status: "blocked",
      summary: failure.error ?? "Reviewer environment unavailable",
      findings: [],
    });
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as { status?: string };
    assert.equal(result.status, "blocked");

    const descriptorBase = JSON.parse(readFileSync(descriptorPath, "utf8")) as Record<string, unknown>;
    const deterministicResultPath = join(root, "result-reviewer-3.json");
    const deterministicDescriptor = withValidationReceipt(root, {
      ...descriptorBase,
      attemptId: "reviewer-3",
      resultPath: deterministicResultPath,
    }, "failed-checks");
    writeFileSync(descriptorPath, JSON.stringify(deterministicDescriptor));
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    configExtension.default();
    const deterministicTools = new Map<string, Tool>();
    let deterministicToolCallHook: ToolCallHook | undefined;
    let deterministicToolResultHook: ToolResultHook | undefined;
    extension.default({
      registerTool(tool) { deterministicTools.set(tool.name, tool); },
      on(event, hook) {
        if (event === "tool_call") deterministicToolCallHook = hook as ToolCallHook;
        else deterministicToolResultHook = hook as ToolResultHook;
      },
    });
    const deterministicPreflight = JSON.parse((await deterministicTools.get("review_preflight")!.execute("preflight", {})).content[0]!.text) as {
      ok?: boolean;
      validationReceipt?: { exitCode?: number; status?: string };
      validationFindings?: Array<{ severity: "major"; summary: string; evidence: string }>;
    };
    assert.equal(deterministicPreflight.ok, true);
    assert.deepEqual(deterministicPreflight.validationReceipt && {
      exitCode: deterministicPreflight.validationReceipt.exitCode,
      status: deterministicPreflight.validationReceipt.status,
    }, { exitCode: 7, status: "failed-checks" });
    assert.equal(deterministicTools.has("review_validate"), false);
    assert.ok(deterministicToolCallHook);
    assert.ok(deterministicToolResultHook);
    const changesCall = { ...reviewCall };
    assert.equal(await deterministicToolCallHook({ toolCallId: "changes-axes", toolName: "subagent", input: changesCall }), undefined);
    const changesTasks = workflowEntries(changesCall.workflowScript).map((entry) => entry.task);
    const axisFinding = { severity: "major", summary: "Fix the shared root cause", evidenceRefs: ["src/shared.ts:10"] };
    const changesProjection = await deterministicToolResultHook({
      toolCallId: "changes-axes",
      toolName: "subagent",
      input: changesCall,
      content: [{ type: "text", text: "workflow complete" }],
      isError: false,
      details: {
        mode: "workflow",
        results: changesTasks.map((task, index) => ({
          agent: "herdr-harness-review-axis",
          task,
          exitCode: 0,
          finalOutput: JSON.stringify(index === 0
            ? { status: "changes", summary: "Standards finding", findings: [axisFinding], evidenceRefs: [] }
            : { status: "pass", summary: "Spec satisfied", findings: [], evidenceRefs: [] }),
        })),
      },
    });
    assert.equal(changesProjection?.isError, undefined);
    await assert.rejects(() => deterministicTools.get("review_submit")!.execute("missing-finding", {
      status: "changes",
      summary: "omitted finding",
      findings: [],
    }), /preserve every Review Axis and validation finding identity/);
    await assert.rejects(() => deterministicTools.get("review_submit")!.execute("forged-finding", {
      status: "changes",
      summary: "forged finding",
      findings: [{ severity: "major", summary: "Different identity", evidence: "src/shared.ts:10" }],
    }), /preserve every Review Axis and validation finding identity/);
    const validationFinding = deterministicPreflight.validationFindings?.[0];
    assert.ok(validationFinding);
    await deterministicTools.get("review_submit")!.execute("bound-changes", {
      status: "changes",
      summary: "axis and deterministic validation findings",
      findings: [
        { severity: "major", summary: axisFinding.summary, evidence: axisFinding.evidenceRefs.join("\n") },
        validationFinding,
      ],
    });
    assert.equal(JSON.parse(readFileSync(deterministicResultPath, "utf8")).status, "changes");

    const malformedDescriptor = withValidationReceipt(root, {
      ...deterministicDescriptor,
      attemptId: "reviewer-malformed",
      resultPath: join(root, "result-malformed.json"),
    }, "passed");
    writeFileSync(descriptorPath, JSON.stringify(malformedDescriptor));
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    configExtension.default();
    const malformedTools = new Map<string, Tool>();
    let malformedToolCallHook: ToolCallHook | undefined;
    let malformedToolResultHook: ToolResultHook | undefined;
    extension.default({
      registerTool(tool) { malformedTools.set(tool.name, tool); },
      on(event, hook) {
        if (event === "tool_call") malformedToolCallHook = hook as ToolCallHook;
        else malformedToolResultHook = hook as ToolResultHook;
      },
    });
    assert.equal(JSON.parse((await malformedTools.get("review_preflight")!.execute("preflight", {})).content[0]!.text).ok, true);
    assert.ok(malformedToolCallHook);
    assert.ok(malformedToolResultHook);
    const malformedCall = { ...reviewCall };
    assert.equal(await malformedToolCallHook({ toolCallId: "malformed-axes", toolName: "subagent", input: malformedCall }), undefined);
    const malformedTasks = workflowEntries(malformedCall.workflowScript).map((entry) => entry.task);
    const malformedProjection = await malformedToolResultHook({
      toolCallId: "malformed-axes",
      toolName: "subagent",
      input: malformedCall,
      content: [{ type: "text", text: "raw child output" }],
      isError: false,
      details: {
        mode: "workflow",
        results: malformedTasks.map((task, index) => ({
          agent: "herdr-harness-review-axis",
          task,
          exitCode: 0,
          finalOutput: index === 0
            ? "not structured JSON"
            : JSON.stringify({
                status: "changes",
                summary: "ambiguous evidence identity",
                findings: [{ severity: "major", summary: "ambiguous ref", evidenceRefs: ["a\nb"] }],
                evidenceRefs: [],
              }),
        })),
      },
    });
    assert.equal(malformedProjection?.isError, true);
    assert.equal(JSON.stringify(malformedProjection?.details).includes("not structured JSON"), false);
    assert.match(JSON.stringify(malformedProjection?.details), /structured contract/);
    await assert.rejects(() => malformedTools.get("review_submit")!.execute("invalid-pass", {
      status: "pass",
      summary: "invalid axes",
      findings: [],
    }), /completed Standards and Spec/);

    const budgetDescriptor = withValidationReceipt(root, {
      ...malformedDescriptor,
      attemptId: "reviewer-budget",
      resultPath: join(root, "result-budget.json"),
    }, "passed");
    budgetDescriptor.initialContextBytes = REVIEWER_CONTEXT_BUDGET_BYTES - REVIEWER_CONTEXT_BUDGET_RESERVE_BYTES - 1;
    writeFileSync(descriptorPath, JSON.stringify(budgetDescriptor));
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    configExtension.default();
    const budgetTools = new Map<string, Tool>();
    let budgetToolCallHook: ToolCallHook | undefined;
    let budgetToolResultHook: ToolResultHook | undefined;
    extension.default({
      registerTool(tool) { budgetTools.set(tool.name, tool); },
      on(event, hook) {
        if (event === "tool_call") budgetToolCallHook = hook as ToolCallHook;
        else budgetToolResultHook = hook as ToolResultHook;
      },
    });
    assert.ok(budgetToolCallHook);
    assert.ok(budgetToolResultHook);
    const budgetRead = await budgetToolResultHook({
      toolCallId: "budget-read",
      toolName: "read",
      input: { path: "review-evidence.txt" },
      content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
      isError: false,
      details: {},
    });
    assert.match(budgetRead?.content[0]?.text ?? "", /reviewer_context_budget_exceeded/);
    assert.equal(budgetRead?.isError, true);
    assert.deepEqual(await budgetToolCallHook({ toolCallId: "budget-axes", toolName: "subagent", input: { ...reviewCall } }), {
      block: true,
      reason: "reviewer_context_budget_exceeded",
      terminate: true,
    });
    await assert.rejects(() => budgetTools.get("review_submit")!.execute("budget-pass", {
      status: "pass",
      summary: "must fail closed",
      findings: [],
    }), /forbidden after reviewer_context_budget_exceeded/);
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

function withValidationReceipt(
  root: string,
  descriptor: Record<string, unknown>,
  status: "passed" | "failed-checks",
): Record<string, unknown> {
  const privateEvidenceDir = String(descriptor.privateEvidenceDir);
  const emptyDigest = sha256("");
  assert.ok(privateEvidenceDir);
  const validationArgv = ["npm", "run", "verify"];
  const output = () => ({
    text: "",
    truncated: false,
    redacted: false,
    byteCount: 0,
    sha256: emptyDigest,
  });
  const receipt = {
    version: 1,
    status,
    jobId: descriptor.jobId,
    attemptId: descriptor.attemptId,
    taskDigest: "1".repeat(64),
    baseSha: "a".repeat(40),
    reviewedHeadSha: descriptor.reviewedHeadSha,
    validationArgv,
    validationArgvDigest: sha256(JSON.stringify(validationArgv)),
    startedAt: "2026-08-21T00:00:00.000Z",
    completedAt: "2026-08-21T00:00:01.000Z",
    durationMs: 1_000,
    exitCode: status === "passed" ? 0 : 7,
    signal: null,
    timeout: false,
    error: null,
    stdout: output(),
    stderr: output(),
    dockerHost: null,
    relevantEnvironmentDigest: "2".repeat(64),
    resourceDigest: "3".repeat(64),
    sourceSnapshotDigest: "4".repeat(64),
  };
  const body = JSON.stringify(receipt);
  const validationReceiptPath = join(root, `validation-receipt-${String(descriptor.attemptId)}.json`);
  writeFileSync(validationReceiptPath, body, { mode: 0o400 });
  chmodSync(validationReceiptPath, 0o400);
  return {
    ...descriptor,
    validationReceiptPath,
    validationReceiptDigest: sha256(body),
    validationStatus: status,
  };
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

function sha256(value: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}
