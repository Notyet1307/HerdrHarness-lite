import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { AgentHandle, AgentStatus, Attempt, AttemptResult, WorktreeHandle } from "../model.js";
import type { HerdrPort } from "../ports.js";
import { makeSafeRuntimeDiagnostic, PiRpcRuntimeFailure } from "../pi-rpc-diagnostics.js";
import { snapshotRuntimeTimeouts } from "../runtime-timeouts.js";
import { ensurePrivateDirectory, readJsonIfExists, rpcRuntimeRoot, spoolPath, writeAtomicJson, writeExclusiveJson } from "../pi-rpc-spool.js";
import { type CommandResult, type CommandRunner, requireSuccess, SyncCommandRunner } from "./command.js";
import { join } from "node:path";
import { acquireCredentialStartupLease, invalidateProbeSuccess, resolveCredentialDomain, type CredentialDomain, type CredentialStartupLease } from "../credential-startup.js";

const SHELL_READY_RETRY_MS = 100;
const SHELL_READY_TIMEOUT_MS = 30_000;
const HERDR_COMMAND_TIMEOUT_MS = 30_000;
const HERDR_PROGRESS_POLL_MS = 1_000;

type HerdrProgressReceipt = {
  version: 1;
  attemptId: string;
  adapter: "herdr-pi-cli";
  lastProgressAt: string;
  lastProgressType: string;
  eventCount: number;
  elapsedMs: number;
  resultPresent: boolean;
  runnerPid: null;
  childPid: null;
  outputDigest: string | null;
  digest: string;
};

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
    attempt: { id: string; lane: "worker" | "reviewer"; startedAt?: string; executionSnapshot?: Attempt["executionSnapshot"] };
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<AgentHandle> {
    const agentName = attemptAgentName(input.attempt.id, input.attempt.lane);
    const label = `${input.attempt.lane} ${input.attempt.id}`;
    const cwd = input.cwd ?? input.worktree.path;
    const timeoutMs = boundedAttemptTimeout(input.attempt);
    const env = input.env ?? {};
    for (const [name, value] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\0\r\n]/.test(value)) throw new Error("invalid Herdr attempt environment");
    }
    const existing = this.findAttemptPane(input.worktree, agentName, label, cwd, timeoutMs);
    if (existing) return existing;
    const createArgs = [
      "tab",
      "create",
      "--workspace",
      input.worktree.workspaceId,
      "--cwd",
      cwd,
      "--label",
      label,
      "--no-focus",
    ];
    for (const [name, value] of Object.entries(env).sort(([left], [right]) => left.localeCompare(right))) {
      createArgs.push("--env", `${name}=${value}`);
    }
    const tab = this.invoke(createArgs, timeoutMs);
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
    expectedCwd: string,
    timeoutMs: number,
  ): AgentHandle | null {
    const tabList = this.invoke(["tab", "list", "--workspace", worktree.workspaceId], timeoutMs);
    expectType(tabList, "tab_list");
    const tabs = array(tabList.tabs).map(object).filter((tab) => (
      text(tab.workspace_id) === worktree.workspaceId && text(tab.label) === label
    ));
    if (tabs.length > 1) throw new Error(`multiple Herdr tabs claim attempt ${agentName}`);
    const tab = tabs[0];
    if (!tab) return null;
    const tabId = text(tab.tab_id);
    if (!tabId || tab.pane_count !== 1) throw new Error(`Herdr attempt tab ${agentName} has invalid topology`);

    const paneList = this.invoke(["pane", "list", "--workspace", worktree.workspaceId], timeoutMs);
    expectType(paneList, "pane_list");
    const panes = array(paneList.panes).map(object).filter((pane) => (
      text(pane.workspace_id) === worktree.workspaceId && text(pane.tab_id) === tabId
    ));
    if (panes.length !== 1) throw new Error(`Herdr attempt tab ${agentName} does not own exactly one pane`);
    const pane = panes[0]!;
    const paneId = text(pane.pane_id);
    const cwd = text(pane.foreground_cwd) ?? text(pane.cwd);
    if (!paneId || cwd !== expectedCwd) throw new Error(`Herdr attempt pane ${agentName} has a different identity`);
    return { agentName, paneId, tabId, workspaceId: worktree.workspaceId };
  }

  async startAgent(input: { handle: AgentHandle; attempt?: Attempt; argv: string[] }): Promise<void> {
    let timeoutMs = SHELL_READY_TIMEOUT_MS;
    if (input.attempt) {
      try {
        timeoutMs = Math.min(SHELL_READY_TIMEOUT_MS, remainingTotalMs(input.attempt));
      } catch (error) {
        await this.terminateBounded(input.handle, input.attempt, "attempt_deadline");
        throw error;
      }
    }
    const existing = this.tryGetAgent(input.handle.agentName, timeoutMs);
    if (existing) {
      if (!sameHandle(existing, input.handle)) {
        throw new Error(`existing Herdr agent ${input.handle.agentName} has a different identity`);
      }
      if (!existing.status || !["idle", "done"].includes(existing.status)) {
        throw new Error(`existing Herdr agent ${input.handle.agentName} is not idle before dispatch`);
      }
      return;
    }
    let credentialLease: CredentialStartupLease | null = null;
    let credentialDomain: CredentialDomain | null = null;
    let startupReady = false;
    const snapshot = input.attempt?.executionSnapshot;
    if (snapshot?.credentialDomainId) {
      if (!snapshot.context) throw new Error("Attempt credential domain has no bound Provider context");
      credentialDomain = resolveCredentialDomain(
        join(snapshot.context.agentDir, "auth.json"),
        snapshot.credentialDomainId,
      );
      credentialLease = await acquireCredentialStartupLease(credentialDomain, snapshot.provider ?? "openai-codex");
    }
    try {
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
      credentialLease?.heartbeat();
      const remaining = input.attempt ? remainingTotalMs(input.attempt) : SHELL_READY_TIMEOUT_MS;
      const result = this.runner.run(this.bin, this.args(startArgs), { timeoutMs: Math.min(SHELL_READY_TIMEOUT_MS, remaining) });
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
    if (input.attempt) {
      try {
        remainingTotalMs(input.attempt);
      } catch (error) {
        await this.terminateBounded(input.handle, input.attempt, "attempt_deadline");
        throw error;
      }
    }
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
    startupReady = true;
    } finally {
      try {
        if (!startupReady && credentialLease && credentialDomain && snapshot?.model) {
          invalidateProbeSuccess({
            domain: credentialDomain,
            provider: snapshot.provider ?? "openai-codex",
            model: snapshot.model,
            leaseInstanceId: credentialLease.instanceId,
          });
        }
      } finally {
        credentialLease?.stop();
      }
    }
  }

  async runInPane(input: { handle: AgentHandle; command: string; argv: string[]; timeoutMs?: number }): Promise<void> {
    if (!input.command.trim() || /[\0\r\n]/.test(input.command) || input.argv.some((value) => /[\0\r\n]/.test(value))) {
      throw new Error("invalid Herdr pane command");
    }
    requireSuccess(
      this.runner.run(this.bin, this.args(["pane", "run", input.handle.paneId, "exec", input.command, ...input.argv]), { timeoutMs: input.timeoutMs ?? HERDR_COMMAND_TIMEOUT_MS }),
      "herdr pane run",
    );
  }

  async prompt(input: {
    handle: AgentHandle;
    attempt?: Attempt;
    dispatchId: string;
    skill: "implement" | "code-review";
    text: string;
  }): Promise<void> {
    const body = `/skill:${input.skill} [harness-dispatch:${input.dispatchId}]\n${input.text}`;
    const timeoutMs = input.attempt ? Math.min(HERDR_COMMAND_TIMEOUT_MS, remainingTotalMs(input.attempt)) : HERDR_COMMAND_TIMEOUT_MS;
    let value: Record<string, unknown>;
    try {
      value = this.invoke([
        "agent", "prompt", input.handle.agentName, body,
        "--wait", "--until", "working", "--timeout", String(timeoutMs),
      ], timeoutMs, input.attempt, "runtime_stall");
    } catch (error) {
      if (input.attempt && error instanceof PiRpcRuntimeFailure) {
        await this.terminateBounded(input.handle, input.attempt, error.diagnostic.code === "attempt_deadline" ? "attempt_deadline" : "runtime_stall");
      }
      throw error;
    }
    if (input.attempt) {
      try {
        remainingTotalMs(input.attempt);
      } catch (error) {
        await this.terminateBounded(input.handle, input.attempt, "attempt_deadline");
        throw error;
      }
    }
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
    if (agent.status !== "working") {
      throw new Error(`Herdr prompt returned an unsettled agent status: ${agent.status ?? "missing"}`);
    }
    if (input.attempt) persistHerdrProgress(input.attempt, "dispatch_accepted", null, true);
  }

  async wait(input: {
    handle: AgentHandle;
    attempt?: Attempt;
    resultPath: string;
    expectedJobId: string;
    expectedAttemptId: string;
    expectedLane: "worker" | "reviewer";
  }): Promise<{ agentStatus: AgentStatus; result: AttemptResult | null; diagnostic: string | null }> {
    if (input.attempt) return this.waitBounded({ ...input, attempt: input.attempt });
    const result = this.runner.run(this.bin, this.args(["agent", "wait", input.handle.agentName]), { timeoutMs: HERDR_COMMAND_TIMEOUT_MS });
    return this.observeWaitResult(input, result);
  }

  async terminate(input: {
    handle: AgentHandle;
    attempt: Attempt;
    reason: "completed" | "recovery" | "cancelled";
  }): Promise<void> {
    await this.terminateBounded(input.handle, input.attempt, input.reason);
  }

  private async waitBounded(input: {
    handle: AgentHandle;
    attempt: Attempt;
    resultPath: string;
    expectedJobId: string;
    expectedAttemptId: string;
    expectedLane: "worker" | "reviewer";
  }): Promise<{ agentStatus: AgentStatus; result: AttemptResult | null; diagnostic: string | null }> {
    const timeouts = snapshotRuntimeTimeouts(input.attempt.executionSnapshot!, input.attempt.lane);
    let progress = readHerdrProgress(input.attempt) ?? persistHerdrProgress(input.attempt, "runner_started", null, false);
    for (;;) {
      if (existsSync(input.resultPath) && !progress.resultPresent) {
        progress = persistHerdrProgress(input.attempt, "durable_result", progress.outputDigest, true);
      }
      const now = Date.now();
      const lastProgress = Date.parse(progress.lastProgressAt);
      const totalRemaining = attemptDeadlineMs(input.attempt) - now;
      const noProgressRemaining = timeouts.noProgressTimeoutMs - (now - lastProgress);
      const deadline = totalRemaining <= 0 ? "attempt_deadline" : noProgressRemaining <= 0 ? "runtime_stall" : null;
      if (deadline) {
        await this.terminateBounded(input.handle, input.attempt, deadline);
        throw attemptTimeout(input.attempt, deadline);
      }
      const pollMs = Math.max(1, Math.min(HERDR_PROGRESS_POLL_MS, totalRemaining, noProgressRemaining));
      const result = this.runner.run(this.bin, this.args([
        "agent", "wait", input.handle.agentName, "--timeout", String(pollMs),
      ]), { timeoutMs: Math.min(totalRemaining, pollMs + 1_000) });
      if (!result.ok && isTimeout(result)) {
        if (Date.now() >= attemptDeadlineMs(input.attempt)) continue;
        const outputDigest = this.outputProgressDigest(input.handle.agentName, Math.max(1, totalRemaining));
        if (outputDigest && outputDigest !== progress.outputDigest) {
          progress = persistHerdrProgress(input.attempt, "herdr_output_update", outputDigest, true);
        }
        continue;
      }
      if (Date.now() >= attemptDeadlineMs(input.attempt)) {
        await this.terminateBounded(input.handle, input.attempt, "attempt_deadline");
        throw attemptTimeout(input.attempt, "attempt_deadline");
      }
      const observation = this.observeWaitResult(input, result);
      persistHerdrProgress(input.attempt, "terminal_receipt", progress.outputDigest, true);
      return observation;
    }
  }

  private observeWaitResult(input: {
    handle: AgentHandle;
    resultPath: string;
  }, result: CommandResult): { agentStatus: AgentStatus; result: AttemptResult | null; diagnostic: string | null } {
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
    if (status === "blocked" || attemptResult === null) diagnostic = this.inspectAgent(input.handle.agentName);
    return { agentStatus: status as AgentStatus, result: attemptResult, diagnostic };
  }

  async close(handle: AgentHandle): Promise<void> {
    this.closeWithTimeout(handle, HERDR_COMMAND_TIMEOUT_MS);
  }

  private async terminateBounded(
    handle: AgentHandle,
    attempt: Attempt,
    reason: "completed" | "recovery" | "cancelled" | "runtime_stall" | "attempt_deadline",
  ): Promise<void> {
    const root = herdrRuntimeRoot(attempt);
    ensurePrivateDirectory(root);
    const identity = { version: 1, attemptId: attempt.id, adapter: "herdr-pi-cli" as const };
    const terminated = readJsonIfExists<typeof identity & { ok: boolean }>(spoolPath(root, "terminated.json"));
    if (terminated?.ok === true) return;
    const intent = { ...identity, reason };
    const intentPath = spoolPath(root, "terminate.json");
    const existing = readJsonIfExists<typeof intent>(intentPath);
    if (existing && JSON.stringify(existing) !== JSON.stringify(intent)) throw new Error("Herdr terminate intent changed after persistence");
    if (!existing) writeExclusiveJson(intentPath, intent);
    writeAtomicJson(spoolPath(root, "terminating.json"), { ...identity, ok: true, reason });
    const timeouts = snapshotRuntimeTimeouts(attempt.executionSnapshot!, attempt.lane);
    const closeTimeoutMs = Math.min(HERDR_COMMAND_TIMEOUT_MS, timeouts.sigtermGraceMs + (2 * timeouts.sigkillGraceMs));
    try {
      this.closeWithTimeout(handle, closeTimeoutMs);
    } catch (error) {
      writeAtomicJson(spoolPath(root, "terminated.json"), { ...identity, ok: false, reason: "owned pane close unconfirmed" });
      throw error;
    }
    if (!await this.waitAgentGone(handle, Math.max(1, timeouts.sigkillGraceMs))) {
      writeAtomicJson(spoolPath(root, "terminated.json"), { ...identity, ok: false, reason: "owned agent exit unconfirmed" });
      throw new Error("Herdr owned agent exit is not confirmed after pane close");
    }
    if (reason === "runtime_stall" || reason === "attempt_deadline") {
      const diagnostic = timeoutDiagnostic(reason);
      writeAtomicJson(spoolPath(root, "terminal.json"), { ...identity, ok: false, error: reason, ...diagnostic });
    }
    writeAtomicJson(spoolPath(root, "terminated.json"), { ...identity, ok: true, reason: "owned pane close confirmed" });
  }

  private closeWithTimeout(handle: AgentHandle, timeoutMs: number): void {
    const result = this.runner.run(this.bin, this.args(["pane", "close", handle.paneId]), { timeoutMs });
    if (!result.ok && herdrErrorCode(result.stderr) === "pane_not_found") return;
    requireSuccess(result, "herdr pane close");
  }

  private async waitAgentGone(handle: AgentHandle, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = Math.max(1, deadline - Date.now());
      const result = this.runner.run(this.bin, this.args(["agent", "get", handle.agentName]), {
        timeoutMs: Math.min(HERDR_COMMAND_TIMEOUT_MS, remaining),
      });
      if (!result.ok && ["agent_not_found", "agent_not_running"].includes(herdrErrorCode(result.stderr) ?? "")) return true;
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
  }

  private outputProgressDigest(agentName: string, remainingTotalMs: number): string | null {
    const result = this.runner.run(this.bin, this.args([
      "agent", "read", agentName, "--source", "recent-unwrapped", "--lines", "120", "--format", "text",
    ]), { timeoutMs: Math.min(HERDR_COMMAND_TIMEOUT_MS, remainingTotalMs) });
    if (!result.ok) return null;
    let output: string;
    try {
      const value = unwrap(JSON.parse(result.stdout) as unknown);
      if (typeof value.text !== "string") return null;
      output = value.text;
    } catch {
      return null;
    }
    const normalized = output
      .split("\n")
      .map((line) => line.replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "").trim())
      .filter((line) => line && !/\b(?:queue|heartbeat|poll(?:ing)?|waiting for agent)\b/i.test(line))
      .join("\n")
      .slice(-64 * 1024);
    return normalized ? textDigest(normalized) : null;
  }

  private tryGetAgent(agentName: string, timeoutMs = HERDR_COMMAND_TIMEOUT_MS): (AgentHandle & { status: string | null }) | null {
    const result = this.runner.run(this.bin, this.args(["agent", "get", agentName]), { timeoutMs });
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
      ["agent get", this.runner.run(this.bin, this.args(["agent", "get", agentName]), { timeoutMs: HERDR_COMMAND_TIMEOUT_MS })],
      ["agent read", this.runner.run(this.bin, this.args(["agent", "read", agentName, "--source", "recent-unwrapped", "--lines", "120"]), { timeoutMs: HERDR_COMMAND_TIMEOUT_MS })],
    ] as const;
    return checks
      .map(([label, result]) => `${label}: ${(result.ok ? result.stdout : result.stderr).trim() || "(no output)"}`)
      .join("\n")
      .slice(-4_000);
  }

  private invoke(
    args: string[],
    timeoutMs = HERDR_COMMAND_TIMEOUT_MS,
    attempt?: Attempt,
    timeoutCode: "runtime_stall" | "attempt_deadline" = "attempt_deadline",
  ): Record<string, unknown> {
    const result = this.runner.run(this.bin, this.args(args), { timeoutMs });
    if (attempt && isTimeout(result)) throw attemptTimeout(attempt, timeoutCode);
    const stdout = requireSuccess(result, `herdr ${args.slice(0, 2).join(" ")}`);
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

function remainingTotalMs(attempt: Attempt): number {
  const snapshot = attempt.executionSnapshot;
  if (!snapshot) throw new Error("Attempt has no bounded runtime snapshot");
  const remaining = attemptDeadlineMs(attempt) - Date.now();
  if (remaining <= 0) throw attemptTimeout(attempt, "attempt_deadline");
  return remaining;
}

function boundedAttemptTimeout(attempt: {
  id: string;
  lane: Attempt["lane"];
  startedAt?: string;
  executionSnapshot?: Attempt["executionSnapshot"];
}): number {
  if (!attempt.startedAt || !attempt.executionSnapshot) return HERDR_COMMAND_TIMEOUT_MS;
  return Math.min(HERDR_COMMAND_TIMEOUT_MS, remainingTotalMs(attempt as Attempt));
}

function isTimeout(result: { stderr: string; error: string | null }): boolean {
  return herdrErrorCode(result.stderr) === "timeout" || /timed? out|timeout/i.test(`${result.error ?? ""}\n${result.stderr}`);
}

function attemptStartedMs(attempt: Attempt): number {
  const started = Date.parse(attempt.startedAt);
  if (!Number.isFinite(started)) throw new Error("Attempt has an invalid runtime start time");
  return started;
}

function attemptDeadlineMs(attempt: Attempt): number {
  const snapshot = attempt.executionSnapshot;
  if (!snapshot) throw new Error("Attempt has no bounded runtime snapshot");
  const deadline = snapshot.runtimeDeadlineAt
    ? Date.parse(snapshot.runtimeDeadlineAt)
    : attemptStartedMs(attempt) + snapshotRuntimeTimeouts(snapshot, attempt.lane).totalTimeoutMs;
  if (!Number.isFinite(deadline)) throw new Error("Attempt has an invalid runtime deadline");
  return deadline;
}

function herdrRuntimeRoot(attempt: Attempt): string {
  if (attempt.executionSnapshot?.adapter !== "herdr-pi-cli") throw new Error("Herdr runtime received a different adapter");
  return rpcRuntimeRoot(attempt.executionSnapshot);
}

function readHerdrProgress(attempt: Attempt): HerdrProgressReceipt | null {
  const path = spoolPath(herdrRuntimeRoot(attempt), "runtime-progress.json");
  const value = readJsonIfExists<HerdrProgressReceipt>(path);
  if (!value) return null;
  const { digest: claimedDigest, ...body } = value;
  if (
    Object.keys(value).sort().join(",") !== "adapter,attemptId,childPid,digest,elapsedMs,eventCount,lastProgressAt,lastProgressType,outputDigest,resultPresent,runnerPid,version"
    || value.version !== 1
    || value.attemptId !== attempt.id
    || value.adapter !== "herdr-pi-cli"
    || !Number.isFinite(Date.parse(value.lastProgressAt))
    || !/^[a-z][a-z0-9_]{0,63}$/.test(value.lastProgressType)
    || !Number.isSafeInteger(value.eventCount) || value.eventCount < 0
    || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0
    || typeof value.resultPresent !== "boolean"
    || value.runnerPid !== null
    || value.childPid !== null
    || (value.outputDigest !== null && !/^[0-9a-f]{64}$/.test(value.outputDigest))
    || !/^[0-9a-f]{64}$/.test(claimedDigest)
    || textDigest(JSON.stringify(body)) !== claimedDigest
  ) throw new Error("Herdr runtime progress receipt is invalid");
  return value;
}

function persistHerdrProgress(
  attempt: Attempt,
  type: string,
  outputDigest: string | null,
  refresh: boolean,
): HerdrProgressReceipt {
  const root = herdrRuntimeRoot(attempt);
  ensurePrivateDirectory(root);
  const existing = readHerdrProgress(attempt);
  const now = Date.now();
  const body = {
    version: 1 as const,
    attemptId: attempt.id,
    adapter: "herdr-pi-cli" as const,
    lastProgressAt: refresh ? new Date(now).toISOString() : existing?.lastProgressAt ?? attempt.startedAt,
    lastProgressType: refresh ? type : existing?.lastProgressType ?? type,
    eventCount: (existing?.eventCount ?? 0) + (refresh ? 1 : 0),
    elapsedMs: Math.max(0, now - attemptStartedMs(attempt)),
    resultPresent: existsSync(attempt.resultPath),
    runnerPid: null,
    childPid: null,
    outputDigest,
  };
  const receipt = { ...body, digest: textDigest(JSON.stringify(body)) };
  writeAtomicJson(spoolPath(root, "runtime-progress.json"), receipt);
  return receipt;
}

function timeoutDiagnostic(code: "runtime_stall" | "attempt_deadline") {
  return makeSafeRuntimeDiagnostic({
    domain: code === "runtime_stall" ? "observation" : "execution",
    code,
    stage: "agent-run",
    failureDomain: "runtime",
    failureCode: code,
    retryable: false,
  });
}

function attemptTimeout(attempt: Attempt, code: "runtime_stall" | "attempt_deadline"): PiRpcRuntimeFailure {
  return new PiRpcRuntimeFailure(`${attempt.lane} Attempt ended with ${code}`, timeoutDiagnostic(code));
}

function textDigest(value: string): string {
  const hasher = createHash("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}
