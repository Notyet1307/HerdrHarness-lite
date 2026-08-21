import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  pi?: { skills?: string[]; subagents?: { agents?: string[] } };
};
const exampleConfig = JSON.parse(readFileSync("harness.config.example.json", "utf8")) as {
  reviewerRuntime: string;
  workerArgv: string[];
  reviewerArgv: string[];
  reviewerProviderProfiles: {
    active: string;
    profiles: Record<string, { credentialMode: string; provider: string; model: string }>;
  };
  reviewer: { axisConcurrency: number };
};

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
  assert.match(skill, /Objective injected\s+from the bound AttemptContextEnvelope is the only task specification input/);
  assert.match(skill, /Pi tool names are case-sensitive/);
  assert.match(skill, /`Skill`, `Read`, `Glob`, `PowerShell`/);
  assert.match(skill, /returns at most 12 KiB per\s+axis/);
  assert.match(skill, /stdout and stderr content is replaced by a fixed redaction marker/);
  assert.match(skill, /`missingAxes`, `reusedAxes`, and `axisConcurrency`/);
  assert.match(skill, /When `axisConcurrency=1`, use one Pi `subagent` workflow call per\s+missing axis/);
  assert.match(skill, /atomically creates the\s+Attempt-private axis checkpoint/);
  assert.match(skill, /only the fresh\s+Attempt's successful `review_submit` is authoritative/);
  for (const forbidden of ["docs/agents/issue-tracker.md", "gh issue", "fetch the issue"]) {
    assert.equal(skill.toLowerCase().includes(forbidden), false);
  }
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
  assert.match(agent, /Return exactly one JSON object/);
  assert.match(agent, /"status":"pass\|changes\|blocked"/);
  assert.match(agent, /Never return\s+transcript, assistant-message/);
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
  assert.deepEqual(flagValues(exampleConfig.workerArgv, "--extension").map(lastPathPart), ["worker-tools.js", "index.js"]);
  assert.deepEqual(flagValues(exampleConfig.reviewerArgv, "--extension").map(lastPathPart), [
    "reviewer-subagent-config.js",
    "index.ts",
    "reviewer-tools.js",
  ]);
  assert.deepEqual(flagValues(exampleConfig.workerArgv, "--tools"), ["read,bash,edit,write,grep,find,ls,worker_submit"]);
  assert.deepEqual(flagValues(exampleConfig.reviewerArgv, "--tools"), ["read,grep,find,ls,subagent,review_preflight,review_submit"]);
  assert.equal(exampleConfig.reviewerArgv.includes("review_validate"), false);
  assert.deepEqual(flagValues(exampleConfig.workerArgv, "--thinking"), ["high"]);
  assert.deepEqual(flagValues(exampleConfig.reviewerArgv, "--thinking"), ["max"]);
  assert.equal(exampleConfig.reviewerRuntime, "pi-rpc");
  assert.equal(exampleConfig.reviewer.axisConcurrency, 2);
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
  const active = exampleConfig.reviewerProviderProfiles.profiles[exampleConfig.reviewerProviderProfiles.active]!;
  assert.deepEqual(flagValues(exampleConfig.reviewerArgv, "--provider"), [active.provider]);
  assert.deepEqual(flagValues(exampleConfig.reviewerArgv, "--model"), [active.model]);
  assert.match(readFileSync("pi/skills/code-review/SKILL.md", "utf8"), /candidate Head is review subject\s+data/);
});

function flagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((value, index) => value === flag && argv[index + 1] ? [argv[index + 1]!] : []);
}

function lastPathPart(value: string): string {
  return value.replace(/\/$/, "").split("/").at(-1) ?? "";
}
