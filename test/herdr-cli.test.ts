import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { HerdrCli } from "../src/adapters/herdr-cli.js";
import type { CommandResult, CommandRunner } from "../src/adapters/command.js";

class RecordingRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  private started = false;
  private agentName = "";
  private startAttempts = 0;

  run(command: string, args: string[]): CommandResult {
    this.calls.push({ command, args: [...args] });
    const plain = args.filter((arg) => arg !== "--session" && arg !== "test-session");
    if (plain.includes("--json")) return fail("unknown option: --json", 2);
    if (plain[0] === "worktree" && plain[1] === "create") {
      return ok({
        result: {
          type: "worktree_created",
          workspace: workspace("w1:t1"),
          tab: tab("w1:t1", "1"),
          root_pane: pane("w1:p1", "w1:t1"),
          worktree: {
            path: "/tmp/worktree",
            branch: "agent/issue-1",
            is_bare: false,
            is_detached: false,
            is_prunable: false,
            is_linked_worktree: true,
            label: "HerdrHarness Lite contract",
          },
        },
      });
    }
    if (plain[0] === "agent" && plain[1] === "get") {
      return this.started
        ? ok({ result: { type: "agent_info", agent: agent(this.agentName, "idle") } })
        : fail(error("agent_not_found", "agent not found"));
    }
    if (plain[0] === "tab" && plain[1] === "create") {
      return ok({
        result: {
          type: "tab_created",
          tab: tab("w1:t2", "worker worker-001"),
          root_pane: pane("w1:p2", "w1:t2"),
        },
      });
    }
    if (plain[0] === "agent" && plain[1] === "start") {
      this.startAttempts += 1;
      if (this.startAttempts === 1) {
        return fail(error("agent_pane_busy", "pane is not an available shell"));
      }
      this.started = true;
      this.agentName = plain[2] ?? "";
      return ok({ result: { type: "agent_started", agent: agent(this.agentName, "idle"), argv: plain.slice(plain.indexOf("--") + 1) } });
    }
    if (plain[0] === "agent" && plain[1] === "prompt") {
      return ok({ result: { type: "agent_prompted", agent: agent(this.agentName, "done") } });
    }
    if (plain[0] === "agent" && plain[1] === "wait") {
      return ok({ result: { type: "agent_info", agent: agent(this.agentName, "done") } });
    }
    if (plain[0] === "pane" && plain[1] === "close") return ok({ result: { type: "ok" } });
    return fail(`unexpected command: ${plain.join(" ")}`);
  }
}

function workspace(activeTabId: string): Record<string, unknown> {
  return {
    workspace_id: "w1",
    number: 1,
    label: "HerdrHarness Lite contract",
    focused: false,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: activeTabId,
    agent_status: "unknown",
  };
}

function tab(tabId: string, label: string): Record<string, unknown> {
  return {
    tab_id: tabId,
    workspace_id: "w1",
    number: Number(tabId.at(-1)),
    label,
    focused: false,
    pane_count: 1,
    agent_status: "unknown",
  };
}

function pane(paneId: string, tabId: string): Record<string, unknown> {
  return {
    pane_id: paneId,
    terminal_id: `term-${paneId}`,
    workspace_id: "w1",
    tab_id: tabId,
    focused: false,
    agent_status: "unknown",
    revision: 0,
  };
}

function agent(name: string, status: "idle" | "done"): Record<string, unknown> {
  return {
    name,
    pane_id: "w1:p2",
    terminal_id: "term-w1:p2",
    tab_id: "w1:t2",
    workspace_id: "w1",
    focused: false,
    revision: 1,
    agent_status: status,
    interactive_ready: true,
  };
}

function ok(value: Record<string, unknown>): CommandResult {
  return { ok: true, code: 0, stdout: JSON.stringify({ id: "cli:test", ...value }), stderr: "", error: null };
}

function fail(error: string, code = 1): CommandResult {
  return { ok: false, code, stdout: "", stderr: error, error: null };
}

function error(code: string, message: string): string {
  return JSON.stringify({ id: "cli:test", error: { code, message } });
}

test("Herdr adapter follows the native 0.8 command and JSON response contract", async () => {
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
    argv: ["--model", "test-model"],
  });
  assert.match(handle.agentName, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.ok(handle.agentName.length <= 32);
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
    await herdr.close(handle);
    rmSync(resultPath, { force: true });
  }

  const session = ["--session", "test-session"];
  assert.deepEqual(runner.calls, [
    { command: "herdr", args: [...session, "worktree", "create", "--cwd", "/repo", "--branch", "agent/issue-1", "--base", "a".repeat(40), "--path", "/tmp/worktree", "--label", "issue #1", "--no-focus"] },
    { command: "herdr", args: [...session, "agent", "get", handle.agentName] },
    { command: "herdr", args: [...session, "tab", "create", "--workspace", "w1", "--cwd", "/tmp/worktree", "--label", "worker worker-001", "--no-focus"] },
    { command: "herdr", args: [...session, "agent", "start", handle.agentName, "--kind", "pi", "--pane", "w1:p2", "--", "--model", "test-model"] },
    { command: "herdr", args: [...session, "agent", "start", handle.agentName, "--kind", "pi", "--pane", "w1:p2", "--", "--model", "test-model"] },
    { command: "herdr", args: [...session, "agent", "prompt", handle.agentName, "[harness-dispatch:worker-001]\ndo the work", "--wait"] },
    { command: "herdr", args: [...session, "agent", "wait", handle.agentName] },
    { command: "herdr", args: [...session, "pane", "close", "w1:p2"] },
  ]);
});

test("Herdr adapter does not treat server errors as an absent agent", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run(_command, args) {
      calls.push(args);
      return fail(error("protocol_mismatch", "restart required"));
    },
  };
  const herdr = new HerdrCli({ runner, session: "test-session" });

  await assert.rejects(
    () => herdr.prepareAttempt({
      worktree: { workspaceId: "w1", path: "/tmp/worktree", branch: "agent/issue-1" },
      attempt: { id: "worker-001", lane: "worker" },
      argv: [],
    }),
    /protocol_mismatch/,
  );
  assert.equal(calls.length, 1);
});

test("Herdr adapter rejects a malformed successful agent lookup", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run(_command, args) {
      calls.push(args);
      return ok({ result: { type: "agent_info", agent: {} } });
    },
  };
  const herdr = new HerdrCli({ runner, session: "test-session" });

  await assert.rejects(
    () => herdr.prepareAttempt({
      worktree: { workspaceId: "w1", path: "/tmp/worktree", branch: "agent/issue-1" },
      attempt: { id: "worker-001", lane: "worker" },
      argv: [],
    }),
    /incomplete identity/,
  );
  assert.equal(calls.length, 1);
});

test("Herdr adapter rejects a wait response for a different pane", async () => {
  const runner: CommandRunner = {
    run() {
      return ok({
        result: {
          type: "agent_info",
          agent: { ...agent("hhw-contract", "done"), pane_id: "w1:p9" },
        },
      });
    },
  };
  const herdr = new HerdrCli({ runner, session: "test-session" });

  await assert.rejects(
    () => herdr.wait({
      handle: { agentName: "hhw-contract", paneId: "w1:p2", workspaceId: "w1" },
      resultPath: "/tmp/missing-result.json",
      expectedJobId: "job-1",
      expectedAttemptId: "worker-001",
      expectedLane: "worker",
    }),
    /different agent identity/,
  );
});

test("Herdr adapter requires an explicit named session", () => {
  const runner: CommandRunner = { run: () => fail("unexpected call") };
  assert.throws(() => new HerdrCli({ runner, session: "" }), /session is required/);
});
