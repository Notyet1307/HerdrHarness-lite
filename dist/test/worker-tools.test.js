import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
test("Worker submit tool writes one result with Harness-owned identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-worker-tools-"));
    const descriptorPath = join(root, "descriptor.json");
    const resultPath = join(root, "worktree", ".harness", "result.json");
    const previousDescriptor = process.env.HERDR_HARNESS_WORKER_DESCRIPTOR;
    try {
        mkdirSync(join(root, "worktree", ".harness"), { recursive: true });
        writeFileSync(descriptorPath, `${JSON.stringify({
            version: 1,
            jobId: "job-680a9811-c498-44e2-9863-10b091b944a2",
            attemptId: "worker-eafd204e-c214-4faf-96bb-f84f2e2bd4b6",
            resultPath,
        })}\n`, { mode: 0o400 });
        process.env.HERDR_HARNESS_WORKER_DESCRIPTOR = descriptorPath;
        const tools = new Map();
        const extension = await import(pathToFileURL(resolve("pi/extensions/worker-tools.js")).href);
        extension.default({ registerTool(tool) { tools.set(tool.name, tool); } });
        const submit = tools.get("worker_submit");
        assert.ok(submit);
        await submit.execute("submit", {
            status: "completed",
            summary: "validated implementation",
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
            headSha: "b".repeat(40),
            failedCommands: [],
        });
        await assert.rejects(() => submit.execute("submit-again", {
            status: "completed",
            summary: "overwrite",
            headSha: "c".repeat(40),
            failedCommands: [],
        }), /already submitted/);
    }
    finally {
        if (previousDescriptor === undefined)
            delete process.env.HERDR_HARNESS_WORKER_DESCRIPTOR;
        else
            process.env.HERDR_HARNESS_WORKER_DESCRIPTOR = previousDescriptor;
        rmSync(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=worker-tools.test.js.map