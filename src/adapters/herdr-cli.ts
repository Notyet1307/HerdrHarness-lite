import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { AgentHandle, AgentStatus, AttemptResult, WorktreeHandle } from "../model.js";
import type { HerdrPort } from "../ports.js";
import { type CommandRunner, requireSuccess, SyncCommandRunner } from "./command.js";

const SHELL_READY_RETRY_MS = 100;
const SHELL_READY_TIMEOUT_MS = 30_000;

/**
 * Thin Herdr adapter. It intentionally uses Herdr's native worktree/tab/agent
 * primitives instead of reproducing pane discovery and lifecycle polling.
 */
export class HerdrCli implements HerdrPort {
  private readonly runner: CommandRunner;
  private readonly bin: string;
  private readonly session: string;

  constructor(options: { bin?: string; session: string; runner?: CommandRunner }) {
    if (!options.session.trim()) throw new Error("Herdr session is required");
    this.bin = options.bin ?? "herdr";
    this.session = options.session;
    this.runner = options.runner ?? new SyncCommandRunner();
  }

  async createWorktree(input: {
    sourcePath: string;
    branch: string;
    baseRef: string;
    path: string;
    label: string;
  }): Promise<WorktreeHandle> {
    const value = this.invoke([
      "worktree",
      "create",
      "--cwd",
      input.sourcePath,
      "--branch",
      input.branch,
      "--base",
      input.baseRef,
      "--path",
      input.path,
      "--label",
      input.label,
      "--no-focus",
    ]);
    expectType(value, "worktree_created");
    const worktree = object(value.worktree);
    const workspace = object(value.workspace);
    const tab = object(value.tab);
    const rootPane = object(value.root_pane);
    const workspaceId = text(workspace.workspace_id);
    const tabId = text(tab.tab_id);
    const paneId = text(rootPane.pane_id);
    const path = text(worktree.path);
    const branch = text(worktree.branch);
    if (!workspaceId || !tabId || !paneId || !path || !branch) {
      throw new Error("Herdr worktree create returned incomplete identity");
    }
    if (text(tab.workspace_id) !== workspaceId || text(rootPane.workspace_id) !== workspaceId || text(rootPane.tab_id) !== tabId) {
      throw new Error("Herdr worktree create returned inconsistent topology");
    }
    return { workspaceId, path, branch };
  }

  async createAttemptPane(input: {
    worktree: WorktreeHandle;
    attempt: { id: string; lane: "worker" | "reviewer" };
  }): Promise<AgentHandle> {
    const agentName = attemptAgentName(input.attempt.id, input.attempt.lane);
    const label = `${input.attempt.lane} ${input.attempt.id}`;
    const existing = this.findAttemptPane(input.worktree, agentName, label);
    if (existing) return existing;
    const tab = this.invoke([
      "tab",
      "create",
      "--workspace",
      input.worktree.workspaceId,
      "--cwd",
      input.worktree.path,
      "--label",
      label,
      "--no-focus",
    ]);
    expectType(tab, "tab_created");
    const tabInfo = object(tab.tab);
    const pane = object(tab.root_pane ?? tab.pane);
    const tabId = text(tabInfo.tab_id);
    const paneId = text(pane.pane_id);
    if (!tabId || !paneId) throw new Error("Herdr tab create returned incomplete identity");
    if (
      text(tabInfo.workspace_id) !== input.worktree.workspaceId
      || text(pane.workspace_id) !== input.worktree.workspaceId
      || text(pane.tab_id) !== tabId
    ) {
      throw new Error("Herdr tab create returned inconsistent topology");
    }
    return { agentName, paneId, tabId, workspaceId: input.worktree.workspaceId };
  }

  private findAttemptPane(
    worktree: WorktreeHandle,
    agentName: string,
    label: string,
  ): AgentHandle | null {
    const tabList = this.invoke(["tab", "list", "--workspace", worktree.workspaceId]);
    expectType(tabList, "tab_list");
    const tabs = array(tabList.tabs).map(object).filter((tab) => (
      text(tab.workspace_id) === worktree.workspaceId && text(tab.label) === label
    ));
    if (tabs.length > 1) throw new Error(`multiple Herdr tabs claim attempt ${agentName}`);
    const tab = tabs[0];
    if (!tab) return null;
    const tabId = text(tab.tab_id);
    if (!tabId || tab.pane_count !== 1) throw new Error(`Herdr attempt tab ${agentName} has invalid topology`);

    const paneList = this.invoke(["pane", "list", "--workspace", worktree.workspaceId]);
    expectType(paneList, "pane_list");
    const panes = array(paneList.panes).map(object).filter((pane) => (
      text(pane.workspace_id) === worktree.workspaceId && text(pane.tab_id) === tabId
    ));
    if (panes.length !== 1) throw new Error(`Herdr attempt tab ${agentName} does not own exactly one pane`);
    const pane = panes[0]!;
    const paneId = text(pane.pane_id);
    const cwd = text(pane.foreground_cwd) ?? text(pane.cwd);
    if (!paneId || cwd !== worktree.path) throw new Error(`Herdr attempt pane ${agentName} has a different identity`);
    return { agentName, paneId, tabId, workspaceId: worktree.workspaceId };
  }

  async startAgent(input: { handle: AgentHandle; argv: string[] }): Promise<void> {
    const existing = this.tryGetAgent(input.handle.agentName);
    if (existing) {
      if (!sameHandle(existing, input.handle)) {
        throw new Error(`existing Herdr agent ${input.handle.agentName} has a different identity`);
      }
      if (!existing.status || !["idle", "done"].includes(existing.status)) {
        throw new Error(`existing Herdr agent ${input.handle.agentName} is not idle before dispatch`);
      }
      return;
    }
    const startArgs = [
      "agent",
      "start",
      input.handle.agentName,
      "--kind",
      "pi",
      "--pane",
      input.handle.paneId,
    ];
    if (input.argv.length > 0) startArgs.push("--", ...input.argv);
    let startedValue: Record<string, unknown> | null = null;
    const retryAttempts = SHELL_READY_TIMEOUT_MS / SHELL_READY_RETRY_MS;
    for (let retryIndex = 0; retryIndex < retryAttempts; retryIndex += 1) {
      const result = this.runner.run(this.bin, this.args(startArgs));
      if (result.ok) {
        startedValue = unwrap(JSON.parse(result.stdout) as unknown);
        break;
      }
      if (herdrErrorCode(result.stderr) !== "agent_pane_busy" || retryIndex === retryAttempts - 1) {
        requireSuccess(result, "herdr agent start");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SHELL_READY_RETRY_MS);
    }
    if (!startedValue) throw new Error("Herdr agent start returned no result");
    expectType(startedValue, "agent_started");
    const started = agentIdentity(startedValue.agent, input.handle.agentName);
    if (
      !started
      || started.workspaceId !== input.handle.workspaceId
      || started.paneId !== input.handle.paneId
      || started.tabId !== input.handle.tabId
    ) {
      throw new Error("Herdr agent identity does not match the prepared tab");
    }
    if (object(startedValue.agent).interactive_ready !== true) throw new Error("Herdr agent is not ready for interactive input");
  }

  async prompt(input: { handle: AgentHandle; dispatchId: string; text: string }): Promise<void> {
    const body = `[harness-dispatch:${input.dispatchId}]\n${input.text}`;
    const value = this.invoke(["agent", "prompt", input.handle.agentName, body, "--wait"]);
    expectType(value, "agent_prompted");
    const agent = agentIdentity(value.agent, input.handle.agentName);
    if (
      !agent
      || agent.workspaceId !== input.handle.workspaceId
      || agent.tabId !== input.handle.tabId
      || agent.paneId !== input.handle.paneId
    ) {
      throw new Error("Herdr prompt returned a different agent identity");
    }
    if (!agent.status || !["idle", "done", "blocked"].includes(agent.status)) {
      throw new Error(`Herdr prompt returned an unsettled agent status: ${agent.status ?? "missing"}`);
    }
  }

  async wait(input: {
    handle: AgentHandle;
    resultPath: string;
    expectedJobId: string;
    expectedAttemptId: string;
    expectedLane: "worker" | "reviewer";
  }): Promise<{ agentStatus: AgentStatus; result: AttemptResult | null; diagnostic: string | null }> {
    const result = this.runner.run(this.bin, this.args(["agent", "wait", input.handle.agentName]));
    let attemptResult: AttemptResult | null = null;
    if (existsSync(input.resultPath)) {
      attemptResult = JSON.parse(readFileSync(input.resultPath, "utf8")) as AttemptResult;
    }
    let diagnostic: string | null = null;
    if (!result.ok) {
      diagnostic = this.inspectAgent(input.handle.agentName);
      if (["agent_not_found", "agent_not_running"].includes(herdrErrorCode(result.stderr) ?? "")) {
        return { agentStatus: "unknown", result: attemptResult, diagnostic };
      }
      try {
        requireSuccess(result, "herdr agent wait");
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nHerdr diagnostics (untrusted):\n${diagnostic}`);
      }
    }
    const value = unwrap(JSON.parse(requireSuccess(result, "herdr agent wait")) as unknown);
    expectType(value, "agent_info");
    const agent = agentIdentity(value.agent, input.handle.agentName);
    if (
      !agent
      || agent.workspaceId !== input.handle.workspaceId
      || agent.tabId !== input.handle.tabId
      || agent.paneId !== input.handle.paneId
    ) {
      throw new Error("Herdr wait returned a different agent identity");
    }
    const status = agent.status;
    if (!status || !["idle", "done", "blocked"].includes(status)) {
      throw new Error(`Herdr returned invalid agent status: ${status ?? "missing"}`);
    }
    if (status === "blocked") diagnostic = this.inspectAgent(input.handle.agentName);
    return { agentStatus: status as AgentStatus, result: attemptResult, diagnostic };
  }

  async close(handle: AgentHandle): Promise<void> {
    const result = this.runner.run(this.bin, this.args(["pane", "close", handle.paneId]));
    if (!result.ok && herdrErrorCode(result.stderr) === "pane_not_found") return;
    requireSuccess(result, "herdr pane close");
  }

  private tryGetAgent(agentName: string): (AgentHandle & { status: string | null }) | null {
    const result = this.runner.run(this.bin, this.args(["agent", "get", agentName]));
    if (!result.ok && herdrErrorCode(result.stderr) === "agent_not_found") return null;
    const stdout = requireSuccess(result, "herdr agent get");
    const value = unwrap(JSON.parse(stdout) as unknown);
    expectType(value, "agent_info");
    const agent = agentIdentity(value.agent ?? value, agentName);
    if (!agent) throw new Error("Herdr agent get returned incomplete identity");
    return { agentName, paneId: agent.paneId, tabId: agent.tabId, workspaceId: agent.workspaceId, status: agent.status };
  }

  private inspectAgent(agentName: string): string {
    const checks = [
      ["agent get", this.runner.run(this.bin, this.args(["agent", "get", agentName]))],
      ["agent read", this.runner.run(this.bin, this.args(["agent", "read", agentName, "--source", "recent-unwrapped", "--lines", "120"]))],
    ] as const;
    return checks
      .map(([label, result]) => `${label}: ${(result.ok ? result.stdout : result.stderr).trim() || "(no output)"}`)
      .join("\n")
      .slice(-4_000);
  }

  private invoke(args: string[]): Record<string, unknown> {
    const stdout = requireSuccess(this.runner.run(this.bin, this.args(args)), `herdr ${args.slice(0, 2).join(" ")}`);
    return unwrap(JSON.parse(stdout) as unknown);
  }

  private args(args: string[]): string[] {
    return ["--session", this.session, ...args];
  }
}

function sameHandle(left: AgentHandle, right: AgentHandle): boolean {
  return left.agentName === right.agentName
    && left.paneId === right.paneId
    && left.tabId === right.tabId
    && left.workspaceId === right.workspaceId;
}

function unwrap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Herdr response is not an object");
  const envelope = value as Record<string, unknown>;
  if (envelope.error) throw new Error(`Herdr error: ${JSON.stringify(envelope.error)}`);
  const result = envelope.result;
  return result && typeof result === "object" ? (result as Record<string, unknown>) : envelope;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function herdrErrorCode(stderr: string): string | null {
  try {
    return text(object(object(JSON.parse(stderr) as unknown).error).code);
  } catch {
    return null;
  }
}

function expectType(value: Record<string, unknown>, expected: string): void {
  if (value.type !== expected) throw new Error(`Herdr returned ${String(value.type ?? "missing")} instead of ${expected}`);
}

function agentIdentity(value: unknown, expectedName: string): {
  paneId: string;
  tabId: string;
  workspaceId: string;
  status: string | null;
} | null {
  const agent = object(value);
  const name = text(agent.name);
  const paneId = text(agent.pane_id);
  const tabId = text(agent.tab_id);
  const workspaceId = text(agent.workspace_id);
  if (name !== expectedName || !paneId || !tabId || !workspaceId) return null;
  return { paneId, tabId, workspaceId, status: text(agent.agent_status) };
}

function attemptAgentName(attemptId: string, lane: "worker" | "reviewer"): string {
  const hasher = createHash("sha256");
  hasher.update(attemptId);
  const hash = hasher.digest("hex").slice(0, 28);
  return `hh${lane === "worker" ? "w" : "r"}-${hash}`;
}
