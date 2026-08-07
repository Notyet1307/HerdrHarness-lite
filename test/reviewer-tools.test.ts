import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Tool = {
  execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }>;
};

type ToolCallEvent = { toolCallId: string; toolName: string; input: Record<string, unknown> };
type ToolResultEvent = ToolCallEvent & {
  content: Array<{ type: string; text: string }>;
  details: unknown;
  isError: boolean;
};
type ToolCallHook = (event: ToolCallEvent) => Promise<{ block: true; reason: string } | undefined>;
type ToolResultHook = (event: ToolResultEvent) => Promise<undefined> | undefined;

const reviewTasks = [
  { agent: "herdr-harness-review-axis", task: "Axis: Standards\nReview repository standards." },
  { agent: "herdr-harness-review-axis", task: "Axis: Spec\nReview the supplied specification." },
];

const reviewCall = {
  artifacts: false,
  agentScope: "user",
  context: "fresh",
  async: false,
  tasks: reviewTasks,
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
  try {
    for (const path of [source, validation, dockerConfig, join(scratch, "home"), join(scratch, "tmp"), join(scratch, "cache"), join(scratch, "pycache")]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(join(source, "product.txt"), "source\n");
    writeFileSync(join(validation, "product.txt"), "source\n");
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
        "const fs=require('node:fs');fs.writeFileSync('validation-only.txt','ok');fs.writeFileSync('validation-env.json',JSON.stringify(process.env))",
      ],
      dockerHost: null,
      validationPath: validation,
      scratchPath: scratch,
      resultPath,
    }));
    process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR = descriptorPath;

    const tools = new Map<string, Tool>();
    let toolCallHook: ToolCallHook | undefined;
    let toolResultHook: ToolResultHook | undefined;
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
    const preflight = tools.get("review_preflight");
    const validate = tools.get("review_validate");
    const submit = tools.get("review_submit");
    assert.ok(preflight);
    assert.ok(validate);
    assert.ok(submit);
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
      toolCallId: "unsafe-scope",
      toolName: "subagent",
      input: { ...reviewCall, agentScope: "both" },
    }))?.block, true);
    assert.equal((await toolCallHook({
      toolCallId: "wrong-agent",
      toolName: "subagent",
      input: {
        artifacts: false,
        agentScope: "user",
        context: "fresh",
        async: false,
        tasks: [
          { agent: "worker", task: "write" },
          { agent: "herdr-harness-review-axis", task: "Axis: Spec\nReview" },
        ],
      },
    }))?.block, true);
    const defaultedScopeReviewCall: Record<string, unknown> = {
      artifacts: false,
      context: "fresh",
      async: false,
      tasks: reviewTasks,
    };
    assert.equal((await toolCallHook({
      toolCallId: "axes",
      toolName: "subagent",
      input: defaultedScopeReviewCall,
    })), undefined);
    assert.equal(defaultedScopeReviewCall.agentScope, "user");
    assert.equal((await toolCallHook({ toolCallId: "axes-again", toolName: "subagent", input: reviewCall }))?.block, true);

    await toolResultHook({
      toolCallId: "axes",
      toolName: "subagent",
      input: defaultedScopeReviewCall,
      content: [],
      isError: false,
      details: {
        mode: "parallel",
        results: reviewTasks.map((task, index) => ({
          ...task,
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

    await toolResultHook({
      toolCallId: "axes",
      toolName: "subagent",
      input: reviewCall,
      content: [],
      isError: false,
      details: {
        mode: "parallel",
        results: reviewTasks.map((task, index) => ({
          ...task,
          index,
          exitCode: 0,
          finalOutput: index === 0 ? "Standards: no findings" : "Spec: no findings",
        })),
      },
    });

    await assert.rejects(() => submit.execute("submit-before-validation", {
      status: "pass",
      summary: "premature",
      findings: [],
    }), /requires a review_validate run/);
    process.env.HERDR_REVIEWER_TEST_SECRET = "must-not-leak";
    await validate.execute("validate", {});
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reviewer environment preflight blocks review axes but still permits a durable blocked result", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-review-preflight-failure-"));
  const descriptorPath = join(root, "descriptor.json");
  const resultPath = join(root, "result.json");
  const previousDescriptor = process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR;
  try {
    for (const path of ["source", "validation", "scratch", "scratch/home", "scratch/tmp", "scratch/cache", "scratch/pycache"]) {
      mkdirSync(join(root, path), { recursive: true });
    }
    writeFileSync(descriptorPath, JSON.stringify({
      version: 1,
      jobId: "job-2",
      attemptId: "reviewer-2",
      reviewedHeadSha: "c".repeat(40),
      validationArgv: ["definitely-missing-review-command"],
      dockerHost: null,
      validationPath: join(root, "validation"),
      scratchPath: join(root, "scratch"),
      resultPath,
    }));
    process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR = descriptorPath;

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
    rmSync(root, { recursive: true, force: true });
  }
});
