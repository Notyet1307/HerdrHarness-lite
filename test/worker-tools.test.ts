import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireSuccess, SyncCommandRunner } from "../src/adapters/command.js";
import { GitCli } from "../src/adapters/git-cli.js";

type Tool = {
  parameters: { required: string[]; properties: Record<string, unknown> };
  execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }>;
};

test("Worker submit tool resolves Git HEAD instead of trusting a model-supplied SHA", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-worker-tools-"));
  const worktreePath = join(root, "worktree");
  const resultPath = join(worktreePath, ".harness", "result.json");
  const previousDescriptor = process.env.HERDR_HARNESS_WORKER_DESCRIPTOR;
  try {
    mkdirSync(join(worktreePath, ".harness"), { recursive: true });
    const runner = new SyncCommandRunner();
    const git = (...args: string[]): string => requireSuccess(runner.run("git", ["-C", worktreePath, ...args]), `git ${args[0]}`);
    git("init", "--quiet");
    git("config", "user.email", "worker@example.test");
    git("config", "user.name", "Worker Test");
    writeFileSync(join(worktreePath, "product.txt"), "validated implementation\n");
    git("add", "product.txt");
    git("commit", "--quiet", "-m", "implementation");
    const actualHeadSha = git("rev-parse", "HEAD").trim();
    const { descriptorPath } = await new GitCli(runner).prepareWorkerResult({
      worktree: { path: worktreePath, branch: "agent/issue-1", workspaceId: "w1" },
      rootPath: join(root, "state"),
      resultPath,
      jobId: "job-680a9811-c498-44e2-9863-10b091b944a2",
      attemptId: "worker-eafd204e-c214-4faf-96bb-f84f2e2bd4b6",
    });
    process.env.HERDR_HARNESS_WORKER_DESCRIPTOR = descriptorPath;

    const tools = new Map<string, Tool>();
    const handlers = new Map<string, (event: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>>();
    const extension = await import(pathToFileURL(resolve("pi/extensions/worker-tools.js")).href) as {
      default(pi: {
        registerTool(tool: Tool & { name: string }): void;
        on(event: string, handler: (value: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>): void;
      }): void;
    };
    extension.default({
      registerTool(tool) { tools.set(tool.name, tool); },
      on(event, handler) { handlers.set(event, handler); },
    });
    const submit = tools.get("worker_submit");
    assert.ok(submit);

    await submit.execute("submit", {
      status: "completed",
      summary: "validated implementation",
      // Exercise the production failure mode: a plausible but nonexistent full SHA.
      headSha: "b".repeat(40),
      failedCommands: [],
    });

    assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), {
      version: 1,
      jobId: "job-680a9811-c498-44e2-9863-10b091b944a2",
      attemptId: "worker-eafd204e-c214-4faf-96bb-f84f2e2bd4b6",
      lane: "worker",
      status: "completed",
      summary: "validated implementation",
      headSha: actualHeadSha,
      failedCommands: [],
    });
    assert.equal(submit.parameters.required.includes("headSha"), false);
    assert.equal("headSha" in submit.parameters.properties, false);
    const originalToolOutput = `HEAD\n${"😀".repeat(40_000)}\nTAIL`;
    const bounded = await handlers.get("tool_result")?.({
      type: "tool_result",
      toolName: "bash",
      toolCallId: "large-output",
      input: {},
      content: [{ type: "text", text: originalToolOutput }],
      details: { fullOutputPath: "/tmp/full-output" },
      isError: false,
      usage: { totalTokens: 1 },
    });
    const boundedText = String((bounded?.content as Array<{ text: string }> | undefined)?.[0]?.text ?? "");
    assert.ok(Buffer.byteLength(boundedText) <= 24 * 1024);
    assert.match(boundedText, /^HEAD/);
    assert.match(boundedText, /TAIL$/);
    assert.equal(boundedText.includes("�"), false);
    assert.match(boundedText, /Harness bounded tool output: originalBytes=\d+, sha256=[0-9a-f]{64}/);
    assert.deepEqual(bounded?.details, { fullOutputPath: "/tmp/full-output" });
    assert.equal(bounded?.isError, false);
    assert.deepEqual(bounded?.usage, { totalTokens: 1 });
    await assert.rejects(() => submit.execute("submit-again", {
      status: "completed",
      summary: "overwrite",
      failedCommands: [],
    }), /already submitted/);
  } finally {
    if (previousDescriptor === undefined) delete process.env.HERDR_HARNESS_WORKER_DESCRIPTOR;
    else process.env.HERDR_HARNESS_WORKER_DESCRIPTOR = previousDescriptor;
    rmSync(root, { recursive: true, force: true });
  }
});
