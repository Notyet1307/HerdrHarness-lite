import { existsSync, readFileSync } from "node:fs";
import type { AgentHandle, AgentStatus, AttemptResult, WorktreeHandle } from "../model.js";
import type { HerdrPort } from "../ports.js";
import { type CommandRunner, requireSuccess, SyncCommandRunner } from "./command.js";

/**
 * Thin Herdr adapter. It intentionally uses Herdr's native worktree/tab/agent
 * primitives instead of reproducing pane discovery and lifecycle polling.
 */
export class HerdrCli implements HerdrPort {
  private readonly runner: CommandRunner;
  private readonly bin: string;
  private readonly session: string | null;

  constructor(options: { bin?: string; session?: string; runner?: CommandRunner } = {}) {
    this.bin = options.bin ?? "herdr";
    this.session = options.session ?? null;
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
      "--json",
    ]);
    const worktree = object(value.worktree);
    const workspace = object(value.workspace);
    const workspaceId = text(workspace.workspace_id);
    const path = text(worktree.path);
    const branch = text(worktree.branch);
    if (!workspaceId || !path || !branch) throw new Error("Herdr worktree create returned incomplete identity");
    return { workspaceId, path, branch };
  }

  async prepareAttempt(input: {
    worktree: WorktreeHandle;
    attempt: { id: string; lane: "worker" | "reviewer" };
    argv: string[];
  }): Promise<AgentHandle> {
    const agentName = `hh-${safe(input.attempt.id)}`;
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
      "--json",
    ]);
    const pane = object(tab.root_pane ?? tab.pane);
    const paneId = text(pane.pane_id);
    if (!paneId) throw new Error("Herdr tab create returned no root pane");

    this.invokeVoid([
      "agent",
      "start",
      agentName,
      "--kind",
      "pi",
      "--pane",
      paneId,
      "--",
      ...input.argv,
    ]);
    const started = this.tryGetAgent(agentName);
    if (!started) throw new Error(`Herdr did not register agent ${agentName}`);
    if (started.workspaceId !== input.worktree.workspaceId || started.paneId !== paneId) {
      throw new Error("Herdr agent identity does not match the prepared tab");
    }
    return started;
  }

  async prompt(input: { handle: AgentHandle; dispatchId: string; text: string }): Promise<void> {
    const body = `[harness-dispatch:${input.dispatchId}]\n${input.text}`;
    this.invokeVoid(["agent", "prompt", input.handle.agentName, body, "--json"]);
    // Prove that the prompt left the startup-idle state before a later tick is
    // allowed to wait for completion. Fast completion/blocking is also valid.
    this.invokeVoid([
      "agent",
      "wait",
      input.handle.agentName,
      "--until",
      "working",
      "--until",
      "done",
      "--until",
      "blocked",
      "--json",
    ]);
  }

  async wait(input: {
    handle: AgentHandle;
    resultPath: string;
    expectedJobId: string;
    expectedAttemptId: string;
    expectedLane: "worker" | "reviewer";
  }): Promise<{ agentStatus: AgentStatus; result: AttemptResult | null }> {
    const value = this.invoke([
      "agent",
      "wait",
      input.handle.agentName,
      "--until",
      "idle",
      "--until",
      "done",
      "--until",
      "blocked",
      "--json",
    ]);
    const agent = object(value.agent ?? value);
    const status = text(agent.agent_status ?? agent.status);
    if (!status || !["idle", "done", "blocked", "unknown"].includes(status)) {
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
    this.invokeVoid(["pane", "close", handle.paneId, "--json"]);
  }

  private tryGetAgent(agentName: string): AgentHandle | null {
    const result = this.runner.run(this.bin, this.args(["agent", "get", agentName, "--json"]));
    if (!result.ok) return null;
    const value = unwrap(JSON.parse(result.stdout) as unknown);
    const agent = object(value.agent ?? value);
    const paneId = text(agent.pane_id);
    const workspaceId = text(agent.workspace_id);
    if (!paneId || !workspaceId) return null;
    return { agentName, paneId, workspaceId };
  }

  private invoke(args: string[]): Record<string, unknown> {
    const stdout = requireSuccess(this.runner.run(this.bin, this.args(args)), `herdr ${args.slice(0, 2).join(" ")}`);
    return unwrap(JSON.parse(stdout) as unknown);
  }

  private invokeVoid(args: string[]): void {
    requireSuccess(this.runner.run(this.bin, this.args(args)), `herdr ${args.slice(0, 2).join(" ")}`);
  }

  private args(args: string[]): string[] {
    return this.session ? ["--session", this.session, ...args] : args;
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

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
}
