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

  async prepareAttempt(input: {
    worktree: WorktreeHandle;
    attempt: { id: string; lane: "worker" | "reviewer" };
    argv: string[];
  }): Promise<AgentHandle> {
    const agentName = attemptAgentName(input.attempt.id, input.attempt.lane);
    const existing = this.tryGetAgent(agentName);
    if (existing) {
      if (existing.workspaceId !== input.worktree.workspaceId) {
        throw new Error(`existing Herdr agent ${agentName} belongs to another workspace`);
      }
      return existing;
    }

    const tab = this.invoke([
      "tab",
      "create",
      "--workspace",
      input.worktree.workspaceId,
      "--cwd",
      input.worktree.path,
      "--label",
      `${input.attempt.lane} ${input.attempt.id}`,
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

    const startArgs = [
      "agent",
      "start",
      agentName,
      "--kind",
      "pi",
      "--pane",
      paneId,
      "--",
      ...input.argv,
    ];
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
    const started = agentIdentity(startedValue.agent, agentName);
    if (!started || started.workspaceId !== input.worktree.workspaceId || started.paneId !== paneId || started.tabId !== tabId) {
      throw new Error("Herdr agent identity does not match the prepared tab");
    }
    if (object(startedValue.agent).interactive_ready !== true) throw new Error("Herdr agent is not ready for interactive input");
    return { agentName, paneId, workspaceId: input.worktree.workspaceId };
  }

  async prompt(input: { handle: AgentHandle; dispatchId: string; text: string }): Promise<void> {
    const body = `[harness-dispatch:${input.dispatchId}]\n${input.text}`;
    const value = this.invoke(["agent", "prompt", input.handle.agentName, body, "--wait"]);
    expectType(value, "agent_prompted");
    const agent = agentIdentity(value.agent, input.handle.agentName);
    if (!agent || agent.workspaceId !== input.handle.workspaceId || agent.paneId !== input.handle.paneId) {
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
  }): Promise<{ agentStatus: AgentStatus; result: AttemptResult | null }> {
    const value = this.invoke(["agent", "wait", input.handle.agentName]);
    expectType(value, "agent_info");
    const agent = agentIdentity(value.agent, input.handle.agentName);
    if (!agent || agent.workspaceId !== input.handle.workspaceId || agent.paneId !== input.handle.paneId) {
      throw new Error("Herdr wait returned a different agent identity");
    }
    const status = agent.status;
    if (!status || !["idle", "done", "blocked"].includes(status)) {
      throw new Error(`Herdr returned invalid agent status: ${status ?? "missing"}`);
    }
    let result: AttemptResult | null = null;
    if (existsSync(input.resultPath)) {
      const parsed = JSON.parse(readFileSync(input.resultPath, "utf8")) as AttemptResult;
      result = parsed;
    }
    return { agentStatus: status as AgentStatus, result };
  }

  async close(handle: AgentHandle): Promise<void> {
    this.invokeVoid(["pane", "close", handle.paneId]);
  }

  private tryGetAgent(agentName: string): AgentHandle | null {
    const result = this.runner.run(this.bin, this.args(["agent", "get", agentName]));
    if (!result.ok && herdrErrorCode(result.stderr) === "agent_not_found") return null;
    const stdout = requireSuccess(result, "herdr agent get");
    const value = unwrap(JSON.parse(stdout) as unknown);
    expectType(value, "agent_info");
    const agent = agentIdentity(value.agent ?? value, agentName);
    if (!agent) throw new Error("Herdr agent get returned incomplete identity");
    return { agentName, paneId: agent.paneId, workspaceId: agent.workspaceId };
  }

  private invoke(args: string[]): Record<string, unknown> {
    const stdout = requireSuccess(this.runner.run(this.bin, this.args(args)), `herdr ${args.slice(0, 2).join(" ")}`);
    return unwrap(JSON.parse(stdout) as unknown);
  }

  private invokeVoid(args: string[]): void {
    requireSuccess(this.runner.run(this.bin, this.args(args)), `herdr ${args.slice(0, 2).join(" ")}`);
  }

  private args(args: string[]): string[] {
    return ["--session", this.session, ...args];
  }
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
