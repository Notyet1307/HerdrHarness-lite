import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
test("Reviewer tools isolate validation and write one identity-bound result", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-review-tools-"));
    const source = join(root, "source");
    const validation = join(root, "validation");
    const scratch = join(root, "scratch");
    const resultPath = join(root, "result.json");
    const descriptorPath = join(root, "descriptor.json");
    const previousDescriptor = process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR;
    try {
        for (const path of [source, validation, join(scratch, "home"), join(scratch, "tmp"), join(scratch, "cache"), join(scratch, "pycache")]) {
            mkdirSync(path, { recursive: true });
        }
        writeFileSync(join(source, "product.txt"), "source\n");
        writeFileSync(join(validation, "product.txt"), "source\n");
        writeFileSync(descriptorPath, JSON.stringify({
            version: 1,
            jobId: "job-1",
            attemptId: "reviewer-1",
            reviewedHeadSha: "b".repeat(40),
            validationArgv: [process.execPath, "-e", "require('node:fs').writeFileSync('validation-only.txt','ok')"],
            validationPath: validation,
            scratchPath: scratch,
            resultPath,
        }));
        process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR = descriptorPath;
        const tools = new Map();
        let toolCallHook;
        const extension = await import(pathToFileURL(resolve("pi/extensions/reviewer-tools.js")).href);
        extension.default({
            registerTool(tool) { tools.set(tool.name, tool); },
            on(_event, hook) { toolCallHook = hook; },
        });
        const validate = tools.get("review_validate");
        const submit = tools.get("review_submit");
        assert.ok(validate);
        assert.ok(submit);
        assert.ok(toolCallHook);
        assert.equal((await toolCallHook({ toolName: "subagent", input: { action: "create" } }))?.block, true);
        assert.equal((await toolCallHook({
            toolName: "subagent",
            input: {
                artifacts: false,
                agentScope: "user",
                context: "fresh",
                async: false,
                tasks: [
                    { agent: "worker", task: "write" },
                    { agent: "herdr-harness-review-axis", task: "Spec" },
                ],
            },
        }))?.block, true);
        assert.equal((await toolCallHook({
            toolName: "subagent",
            input: {
                artifacts: false,
                agentScope: "user",
                context: "fresh",
                async: false,
                tasks: [
                    { agent: "herdr-harness-review-axis", task: "Standards" },
                    { agent: "herdr-harness-review-axis", task: "Spec" },
                ],
            },
        })), undefined);
        await assert.rejects(() => submit.execute("submit-before-validation", {
            status: "pass",
            summary: "premature",
            findings: [],
        }), /requires a review_validate run/);
        await validate.execute("validate", {});
        assert.equal(readFileSync(join(validation, "validation-only.txt"), "utf8"), "ok");
        assert.equal(readFileSync(join(source, "product.txt"), "utf8"), "source\n");
        await submit.execute("submit", { status: "pass", summary: "accepted", findings: [] });
        const result = JSON.parse(readFileSync(resultPath, "utf8"));
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
        await assert.rejects(() => submit.execute("submit-again", {
            status: "changes",
            summary: "overwrite",
            findings: [],
        }), /already submitted/);
    }
    finally {
        if (previousDescriptor === undefined)
            delete process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR;
        else
            process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR = previousDescriptor;
        rmSync(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=reviewer-tools.test.js.map