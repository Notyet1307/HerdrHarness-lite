import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  pi?: { skills?: string[]; subagents?: { agents?: string[] } };
};
const exampleConfig = JSON.parse(readFileSync("harness.config.example.json", "utf8")) as {
  workerArgv: string[];
  reviewerArgv: string[];
};

test("Pi package exposes the Harness review skill and child agent", () => {
  assert.deepEqual(packageJson.pi?.skills, ["./pi/skills"]);
  assert.deepEqual(packageJson.pi?.subagents?.agents, ["./pi/agents"]);
});

test("Pi review adapter uses fresh foreground user-scope reviewers", () => {
  const skill = readFileSync("pi/skills/code-review/SKILL.md", "utf8");
  const invocation = skill.match(/subagent\(\{[\s\S]*?\n\}\)/)?.[0] ?? "";
  assert.match(skill, /^---\nname: code-review\n/m);
  assert.match(invocation, /artifacts:\s*false/);
  assert.match(skill, /agentScope:\s*"user"/);
  assert.match(skill, /context:\s*"fresh"/);
  assert.match(skill, /async:\s*false/);
  assert.match(skill, /agent:\s*"herdr-harness-review-axis"/);
  assert.match(skill, /tasks:\s*\[/);
});

test("Pi child reviewer has a strict non-writing, non-recursive tool list", () => {
  const agent = readFileSync("pi/agents/herdr-harness-review-axis.md", "utf8");
  const tools = agent.match(/^tools:\s*(.+)$/m)?.[1]?.split(",").map((tool) => tool.trim()) ?? [];

  assert.deepEqual(tools, ["read", "grep", "find", "ls", "bash"]);
  assert.equal(/^tools:.*\b(?:edit|write|subagent)\b/m.test(agent), false);
  assert.match(agent, /^thinking:\s*high$/m);
  assert.match(agent, /^inheritProjectContext:\s*true$/m);
  assert.match(agent, /^inheritSkills:\s*false$/m);
  assert.match(agent, /^defaultContext:\s*fresh$/m);
  assert.match(agent, /^extensions:\s*$/m);
  assert.match(agent, /Do not run\s+project validation commands/);
});

test("example config pins the Worker and Reviewer Pi role contracts", () => {
  assert.deepEqual(flagValues(exampleConfig.workerArgv, "--skill").map(lastPathPart), [
    "implement",
    "tdd",
    "code-review",
  ]);
  assert.deepEqual(flagValues(exampleConfig.reviewerArgv, "--skill").map(lastPathPart), ["code-review"]);
  assert.deepEqual(flagValues(exampleConfig.workerArgv, "--tools"), ["read,bash,edit,write,grep,find,ls,subagent"]);
  assert.deepEqual(flagValues(exampleConfig.reviewerArgv, "--tools"), ["read,bash,grep,find,ls,subagent"]);
  assert.deepEqual(flagValues(exampleConfig.workerArgv, "--thinking"), ["high"]);
  assert.deepEqual(flagValues(exampleConfig.reviewerArgv, "--thinking"), ["high"]);
});

function flagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((value, index) => value === flag && argv[index + 1] ? [argv[index + 1]!] : []);
}

function lastPathPart(value: string): string {
  return value.replace(/\/$/, "").split("/").at(-1) ?? "";
}
