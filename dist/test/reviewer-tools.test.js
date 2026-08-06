import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
    const resultPath = join(root, "result.json");
    const descriptorPath = join(root, "descriptor.json");
    const previousDescriptor = process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR;
    const previousSecret = process.env.HERDR_REVIEWER_TEST_SECRET;
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
            validationArgv: [
                process.execPath,
                "-e",
                "const fs=require('node:fs');fs.writeFileSync('validation-only.txt','ok');fs.writeFileSync('validation-env.json',JSON.stringify(process.env))",
            ],
            validationPath: validation,
            scratchPath: scratch,
            resultPath,
        }));
        process.env.HERDR_HARNESS_REVIEW_DESCRIPTOR = descriptorPath;
        const tools = new Map();
        let toolCallHook;
        let toolResultHook;
        const extension = await import(pathToFileURL(resolve("pi/extensions/reviewer-tools.js")).href);
        extension.default({
            registerTool(tool) { tools.set(tool.name, tool); },
            on(event, hook) {
                if (event === "tool_call")
                    toolCallHook = hook;
                else
                    toolResultHook = hook;
            },
        });
        const validate = tools.get("review_validate");
        const submit = tools.get("review_submit");
        assert.ok(validate);
        assert.ok(submit);
        assert.ok(toolCallHook);
        assert.ok(toolResultHook);
        await assert.rejects(() => submit.execute("submit-before-axes", {
            status: "pass",
            summary: "premature",
            findings: [],
        }), /completed Standards and Spec/);
        assert.equal((await toolCallHook({ toolCallId: "wrong", toolName: "subagent", input: { action: "create" } }))?.block, true);
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
        assert.equal((await toolCallHook({
            toolCallId: "axes",
            toolName: "subagent",
            input: reviewCall,
        })), undefined);
        assert.equal((await toolCallHook({ toolCallId: "axes-again", toolName: "subagent", input: reviewCall }))?.block, true);
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
        const validationEnv = JSON.parse(readFileSync(join(validation, "validation-env.json"), "utf8"));
        assert.equal(validationEnv.HERDR_REVIEWER_TEST_SECRET, undefined);
        assert.equal(validationEnv.HOME, join(scratch, "home"));
        assert.equal(validationEnv.TMPDIR, join(scratch, "tmp"));
        assert.equal(validationEnv.TMP, join(scratch, "tmp"));
        assert.equal(validationEnv.TEMP, join(scratch, "tmp"));
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
        assert.equal(readdirSync(root).some((name) => name.endsWith(".tmp")), false);
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
        if (previousSecret === undefined)
            delete process.env.HERDR_REVIEWER_TEST_SECRET;
        else
            process.env.HERDR_REVIEWER_TEST_SECRET = previousSecret;
        rmSync(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=reviewer-tools.test.js.map