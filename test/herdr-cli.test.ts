import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { HerdrCli } from "../src/adapters/herdr-cli.js";
import type { CommandResult, CommandRunner } from "../src/adapters/command.js";

class RecordingRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  private started = false;

  run(command: string, args: string[]): CommandResult {
    this.calls.push({ command, args: [...args] });
    const plain = args.filter((arg) => arg !== "--session" && arg !== "test-session");
    if (plain[0] === "worktree" && plain[1] === "create") {
      return ok({
        result: {
          workspace: { workspace_id: "ws-1" },
          worktree: { path: "/tmp/worktree", branch: "agent/issue-1" },
        },
      });
    }
    if (plain[0] === "agent" && plain[1] === "get") {
      return this.started
        ? ok({ result: { agent: { pane_id: "pane-1", workspace_id: "ws-1" } } })
        : fail("agent_not_found");
    }
    if (plain[0] === "tab" && plain[1] === "create") {
      return ok({ result: { root_pane: { pane_id: "pane-1" } } });
    }
    if (plain[0] === "agent" && plain[1] === "start") {
      this.started = true;
      return ok({ result: { accepted: true } });
    }
    if (plain[0] === "agent" && plain[1] === "prompt") return ok({ result: { accepted: true } });
    if (plain[0] === "agent" && plain[1] === "wait") {
      return ok({ result: { agent: { agent_status: "done" } } });
    }
    if (plain[0] === "pane" && plain[1] === "close") return ok({ result: { closed: true } });
    return fail(`unexpected command: ${plain.join(" ")}`);
  }
}

function ok(value: unknown): CommandResult {
  return { ok: true, code: 0, stdout: JSON.stringify(value), stderr: "", error: null };
}

function fail(error: string): CommandResult {
  return { ok: false, code: 1, stdout: "", stderr: error, error: null };
}

test("Herdr adapter uses native worktree/tab/agent commands and never emulates agent startup with pane run", async () => {
  const runner = new RecordingRunner();
  const herdr = new HerdrCli({ runner, session: "test-session" });
  const worktree = await herdr.createWorktree({
    sourcePath: "/repo",
    branch: "agent/issue-1",
    baseRef: "a".repeat(40),
    path: "/tmp/worktree",
    label: "issue #1",
  });
  const handle = await herdr.prepareAttempt({
    worktree,
    attempt: { id: "worker-001", lane: "worker" },
    argv: ["pi", "--profile", "worker"],
  });
  await herdr.prompt({ handle, dispatchId: "worker-001", text: "do the work" });

  const resultPath = `${process.cwd()}/.herdr-cli-test-result.json`;
  writeFileSync(resultPath, JSON.stringify({
    version: 1,
    jobId: "job-1",
    attemptId: "worker-001",
    lane: "worker",
    status: "completed",
    summary: "done",
    headSha: "b".repeat(40),
    failedCommands: [],
  }));
  try {
    const observation = await herdr.wait({
      handle,
      resultPath,
      expectedJobId: "job-1",
      expectedAttemptId: "worker-001",
      expectedLane: "worker",
    });
    assert.equal(observation.agentStatus, "done");
    assert.equal(observation.result?.attemptId, "worker-001");
  } finally {
    rmSync(resultPath, { force: true });
  }

  const flattened = runner.calls.map((call) => call.args.join(" "));
  assert.ok(flattened.some((args) => args.includes("worktree create")));
  assert.ok(flattened.some((args) => args.includes("tab create")));
  assert.ok(flattened.some((args) => args.includes("agent start")));
  assert.ok(flattened.some((args) => args.includes("agent prompt")));
  assert.ok(flattened.some((args) => args.includes("agent wait")));
  assert.ok(!flattened.some((args) => args.includes("pane split")));
  assert.ok(!flattened.some((args) => args.includes("pane run")));
});
