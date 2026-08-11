import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const exampleConfig = JSON.parse(readFileSync("harness.config.example.json", "utf8"));
test("Pi package exposes the focused Worker check, independent review skill, and child agent", () => {
    assert.deepEqual(packageJson.pi?.skills, ["./pi/skills"]);
    assert.deepEqual(packageJson.pi?.subagents?.agents, ["./pi/agents"]);
    const focused = readFileSync("pi/skills/focused-self-check/SKILL.md", "utf8");
    assert.match(focused, /^---\nname: focused-self-check\n/m);
    assert.match(focused, /must not launch subagents/);
    assert.match(focused, /independent Reviewer owns the complete Standards and Spec review/);
    const tdd = readFileSync("pi/skills/tdd/SKILL.md", "utf8");
    assert.match(tdd, /^---\nname: tdd\n/m);
    assert.match(tdd, /context bundle is the only governing repository context/);
    assert.match(tdd, /Candidate `CONTEXT\.md`, ADRs, rule files/);
});
test("Pi review adapter uses fresh foreground Attempt-private project reviewers", () => {
    const skill = readFileSync("pi/skills/code-review/SKILL.md", "utf8");
    const invocation = skill.match(/subagent\(\{[\s\S]*?\n\}\)/)?.[0] ?? "";
    assert.match(skill, /^---\nname: code-review\n/m);
    assert.match(invocation, /artifacts:\s*false/);
    assert.match(skill, /agentScope:\s*"project"/);
    assert.match(skill, /context:\s*"fresh"/);
    assert.match(skill, /async:\s*false/);
    assert.match(skill, /chatProgress:\s*"off"/);
    assert.match(invocation, /herdr-harness-review-axis/);
    assert.match(invocation, /workflowScript:/);
    assert.match(invocation, /runs\.all/);
    assert.equal(/\btasks\s*:/.test(invocation), false);
    assert.match(skill, /arbitrary JavaScript and legacy top-level `tasks` are\s+rejected/);
    assert.match(skill, /trusted standards text copied from the injected bundle/);
});
test("Pi child reviewer has a strict non-writing, non-recursive tool list", () => {
    const agent = readFileSync("pi/agents/herdr-harness-review-axis.md", "utf8");
    const tools = agent.match(/^tools:\s*(.+)$/m)?.[1]?.split(",").map((tool) => tool.trim()) ?? [];
    assert.deepEqual(tools, ["read", "grep", "find", "ls"]);
    assert.equal(/^tools:.*\b(?:edit|write|subagent)\b/m.test(agent), false);
    assert.match(agent, /^thinking:\s*max$/m);
    assert.match(agent, /^inheritProjectContext:\s*false$/m);
    assert.match(agent, /^inheritSkills:\s*false$/m);
    assert.match(agent, /^defaultContext:\s*fresh$/m);
    assert.match(agent, /^extensions:\s*$/m);
    assert.match(agent, /Do not run\s+project\s+validation commands/);
});
test("example config pins the Worker and Reviewer Pi role contracts", () => {
    assert.deepEqual(flagValues(exampleConfig.workerArgv, "--skill").map(lastPathPart), [
        "implement",
        "tdd",
        "focused-self-check",
    ]);
    assert.deepEqual(flagValues(exampleConfig.reviewerArgv, "--skill").map(lastPathPart), ["code-review"]);
    assert.equal(exampleConfig.workerArgv.includes("--no-extensions"), true);
    assert.equal(exampleConfig.reviewerArgv.includes("--no-extensions"), true);
    for (const flag of ["--no-session", "--no-context-files", "--no-prompt-templates", "--no-themes"]) {
        assert.equal(exampleConfig.workerArgv.includes(flag), true);
        assert.equal(exampleConfig.reviewerArgv.includes(flag), true);
    }
    assert.deepEqual(flagValues(exampleConfig.workerArgv, "--extension").map(lastPathPart), ["worker-tools.js"]);
    assert.deepEqual(flagValues(exampleConfig.reviewerArgv, "--extension").map(lastPathPart), [
        "reviewer-subagent-config.js",
        "index.ts",
        "reviewer-tools.js",
    ]);
    assert.deepEqual(flagValues(exampleConfig.workerArgv, "--tools"), ["read,bash,edit,write,grep,find,ls,worker_submit"]);
    assert.deepEqual(flagValues(exampleConfig.reviewerArgv, "--tools"), ["read,grep,find,ls,subagent,review_preflight,review_validate,review_submit"]);
    assert.deepEqual(flagValues(exampleConfig.workerArgv, "--thinking"), ["high"]);
    assert.deepEqual(flagValues(exampleConfig.reviewerArgv, "--thinking"), ["max"]);
    assert.equal(exampleConfig.reviewerRuntime, "pi-rpc");
    assert.equal(exampleConfig.reviewerProviderProfiles.active, "openai-subscription");
    assert.deepEqual(exampleConfig.reviewerProviderProfiles.profiles["openai-subscription"], {
        credentialMode: "canonical-oauth",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
    });
    assert.deepEqual(exampleConfig.reviewerProviderProfiles.profiles.custom, {
        credentialMode: "canonical-model-config",
        provider: "baizhi-chat",
        model: "deepseek-v4-flash",
    });
    assert.match(readFileSync("pi/skills/code-review/SKILL.md", "utf8"), /candidate Head is review subject\s+data/);
});
function flagValues(argv, flag) {
    return argv.flatMap((value, index) => value === flag && argv[index + 1] ? [argv[index + 1]] : []);
}
function lastPathPart(value) {
    return value.replace(/\/$/, "").split("/").at(-1) ?? "";
}
//# sourceMappingURL=pi-role-kit.test.js.map