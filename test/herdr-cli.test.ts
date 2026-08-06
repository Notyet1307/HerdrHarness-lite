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
    if (plain[0] === "tab" && plain[1] === "list") {
      return ok({ result: { type: "tab_list", tabs: [] } });
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
    cwd: "/tmp/worktree",
    agent_status: "unknown",
    revision: 0,
  };
}

function agent(name: string, status: "idle" | "working" | "done" | "blocked"): Record<string, unknown> {
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
  const handle = await herdr.createAttemptPane({
    worktree,
    attempt: { id: "worker-001", lane: "worker" },
  });
  assert.match(handle.agentName, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.ok(handle.agentName.length <= 32);
  await herdr.startAgent({ handle, argv: ["--model", "test-model"] });
  const dispatch = { handle, dispatchId: "worker-001", skill: "implement" as const, text: "do the work" };
  await herdr.prompt(dispatch);

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
    { command: "herdr", args: [...session, "tab", "list", "--workspace", "w1"] },
    { command: "herdr", args: [...session, "tab", "create", "--workspace", "w1", "--cwd", "/tmp/worktree", "--label", "worker worker-001", "--no-focus"] },
    { command: "herdr", args: [...session, "agent", "get", handle.agentName] },
    { command: "herdr", args: [...session, "agent", "start", handle.agentName, "--kind", "pi", "--pane", "w1:p2", "--", "--model", "test-model"] },
    { command: "herdr", args: [...session, "agent", "start", handle.agentName, "--kind", "pi", "--pane", "w1:p2", "--", "--model", "test-model"] },
    { command: "herdr", args: [...session, "agent", "prompt", handle.agentName, "/skill:implement [harness-dispatch:worker-001]\ndo the work", "--wait"] },
    { command: "herdr", args: [...session, "agent", "wait", handle.agentName] },
    { command: "herdr", args: [...session, "pane", "close", "w1:p2"] },
  ]);
});

test("Herdr adapter starts Pi without a native-argument separator when argv is empty", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run(_command, args) {
      calls.push(args);
      const plain = args.slice(2);
      if (plain[0] === "agent" && plain[1] === "get") {
        return fail(error("agent_not_found", "agent not found"));
      }
      if (plain[0] === "agent" && plain[1] === "start") {
        return ok({ result: { type: "agent_started", agent: agent("hhw-contract", "idle") } });
      }
      return fail(`unexpected command: ${plain.join(" ")}`);
    },
  };
  const herdr = new HerdrCli({ runner, session: "test-session" });

  await herdr.startAgent({
    handle: { agentName: "hhw-contract", paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" },
    argv: [],
  });

  assert.deepEqual(calls, [
    ["--session", "test-session", "agent", "get", "hhw-contract"],
    ["--session", "test-session", "agent", "start", "hhw-contract", "--kind", "pi", "--pane", "w1:p2"],
  ]);
});

test("Herdr adapter injects the Reviewer snapshot cwd and descriptor environment", async () => {
  const runner = new RecordingRunner();
  const herdr = new HerdrCli({ runner, session: "test-session" });
  await herdr.createAttemptPane({
    worktree: { workspaceId: "w1", path: "/tmp/worktree", branch: "agent/issue-1" },
    attempt: { id: "reviewer-001", lane: "reviewer" },
    cwd: "/tmp/reviewer/source",
    env: { HERDR_HARNESS_REVIEW_DESCRIPTOR: "/tmp/reviewer/descriptor.json" },
  });

  assert.deepEqual(runner.calls[1], {
    command: "herdr",
    args: [
      "--session", "test-session", "tab", "create", "--workspace", "w1",
      "--cwd", "/tmp/reviewer/source", "--label", "reviewer reviewer-001", "--no-focus",
      "--env", "HERDR_HARNESS_REVIEW_DESCRIPTOR=/tmp/reviewer/descriptor.json",
    ],
  });
});

test("Herdr adapter recovers the unique pane created before its handle was persisted", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run(_command, args) {
      calls.push(args);
      const plain = args.slice(2);
      if (plain[0] === "tab" && plain[1] === "list") {
        return ok({ result: { type: "tab_list", tabs: [tab("w1:t2", "worker worker-001")] } });
      }
      if (plain[0] === "pane" && plain[1] === "list") {
        return ok({ result: { type: "pane_list", panes: [pane("w1:p2", "w1:t2")] } });
      }
      return fail(`unexpected command: ${plain.join(" ")}`);
    },
  };
  const herdr = new HerdrCli({ runner, session: "test-session" });

  const handle = await herdr.createAttemptPane({
    worktree: { workspaceId: "w1", path: "/tmp/worktree", branch: "agent/issue-1" },
    attempt: { id: "worker-001", lane: "worker" },
  });

  assert.equal(handle.paneId, "w1:p2");
  assert.equal(handle.tabId, "w1:t2");
  assert.deepEqual(calls, [
    ["--session", "test-session", "tab", "list", "--workspace", "w1"],
    ["--session", "test-session", "pane", "list", "--workspace", "w1"],
  ]);
});

test("Herdr adapter treats an already-closed owned pane as closed", async () => {
  const runner: CommandRunner = {
    run() {
      return fail(error("pane_not_found", "pane not found"));
    },
  };
  const herdr = new HerdrCli({ runner, session: "test-session" });

  await herdr.close({ agentName: "hhw-contract", paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" });
});

test("Herdr adapter still returns a durable result after its pane was closed", async () => {
  const runner: CommandRunner = {
    run() {
      return fail(error("agent_not_running", "agent pane was closed"));
    },
  };
  const herdr = new HerdrCli({ runner, session: "test-session" });
  const resultPath = `${process.cwd()}/.herdr-cli-recovery-result.json`;
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
      handle: { agentName: "hhw-contract", paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" },
      resultPath,
      expectedJobId: "job-1",
      expectedAttemptId: "worker-001",
      expectedLane: "worker",
    });
    assert.equal(observation.agentStatus, "unknown");
    assert.equal(observation.result?.attemptId, "worker-001");
  } finally {
    rmSync(resultPath, { force: true });
  }
});

test("Herdr adapter inspects a blocked agent with the official get/read commands", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run(_command, args) {
      calls.push(args);
      const plain = args.slice(2);
      if (plain[0] === "agent" && plain[1] === "wait") {
        return ok({ result: { type: "agent_info", agent: agent("hhw-contract", "blocked") } });
      }
      if (plain[0] === "agent" && plain[1] === "get") {
        return ok({ result: { type: "agent_info", agent: agent("hhw-contract", "blocked") } });
      }
      if (plain[0] === "agent" && plain[1] === "read") {
        return ok({ result: { type: "agent_read", text: "Need approval" } });
      }
      return fail(`unexpected command: ${plain.join(" ")}`);
    },
  };
  const herdr = new HerdrCli({ runner, session: "test-session" });

  const observation = await herdr.wait({
    handle: { agentName: "hhw-contract", paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" },
    resultPath: "/missing-result.json",
    expectedJobId: "job-1",
    expectedAttemptId: "worker-001",
    expectedLane: "worker",
  });

  assert.match(observation.diagnostic ?? "", /Need approval/);
  assert.deepEqual(calls, [
    ["--session", "test-session", "agent", "wait", "hhw-contract"],
    ["--session", "test-session", "agent", "get", "hhw-contract"],
    ["--session", "test-session", "agent", "read", "hhw-contract", "--source", "recent-unwrapped", "--lines", "120"],
  ]);
});

test("Herdr adapter inspects a settled agent that produced no durable result", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run(_command, args) {
      calls.push(args);
      const plain = args.slice(2);
      if (plain[0] === "agent" && plain[1] === "wait") {
        return ok({ result: { type: "agent_info", agent: agent("hhr-contract", "idle") } });
      }
      if (plain[0] === "agent" && plain[1] === "get") {
        return ok({ result: { type: "agent_info", agent: agent("hhr-contract", "idle") } });
      }
      if (plain[0] === "agent" && plain[1] === "read") {
        return ok({ result: { type: "agent_read", text: "provider sessions are full" } });
      }
      return fail(`unexpected command: ${plain.join(" ")}`);
    },
  };
  const herdr = new HerdrCli({ runner, session: "test-session" });

  const observation = await herdr.wait({
    handle: { agentName: "hhr-contract", paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" },
    resultPath: "/missing-result.json",
    expectedJobId: "job-1",
    expectedAttemptId: "reviewer-001",
    expectedLane: "reviewer",
  });

  assert.equal(observation.agentStatus, "idle");
  assert.equal(observation.result, null);
  assert.match(observation.diagnostic ?? "", /provider sessions are full/);
  assert.deepEqual(calls, [
    ["--session", "test-session", "agent", "wait", "hhr-contract"],
    ["--session", "test-session", "agent", "get", "hhr-contract"],
    ["--session", "test-session", "agent", "read", "hhr-contract", "--source", "recent-unwrapped", "--lines", "120"],
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
    () => herdr.startAgent({
      handle: { agentName: "hhw-contract", paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" },
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
    () => herdr.startAgent({
      handle: { agentName: "hhw-contract", paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" },
      argv: [],
    }),
    /incomplete identity/,
  );
  assert.equal(calls.length, 1);
});

test("Herdr adapter does not reuse an existing agent that is already working", async () => {
  const runner: CommandRunner = {
    run() {
      return ok({ result: { type: "agent_info", agent: agent("hhw-contract", "working") } });
    },
  };
  const herdr = new HerdrCli({ runner, session: "test-session" });

  await assert.rejects(
    () => herdr.startAgent({
      handle: { agentName: "hhw-contract", paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" },
      argv: [],
    }),
    /not idle before dispatch/,
  );
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
      handle: { agentName: "hhw-contract", paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" },
      resultPath: "/tmp/missing-result.json",
      expectedJobId: "job-1",
      expectedAttemptId: "worker-001",
      expectedLane: "worker",
    }),
    /different agent identity/,
  );
});

test("Herdr adapter rejects a wait response for a different tab", async () => {
  const runner: CommandRunner = {
    run() {
      return ok({
        result: {
          type: "agent_info",
          agent: { ...agent("hhw-contract", "done"), tab_id: "w1:t9" },
        },
      });
    },
  };
  const herdr = new HerdrCli({ runner, session: "test-session" });

  await assert.rejects(
    () => herdr.wait({
      handle: { agentName: "hhw-contract", paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" },
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
