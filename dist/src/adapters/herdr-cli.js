import { existsSync, readFileSync } from "node:fs";
import { requireSuccess, SyncCommandRunner } from "./command.js";
/**
 * Thin Herdr adapter. It intentionally uses Herdr's native worktree/tab/agent
 * primitives instead of reproducing pane discovery and lifecycle polling.
 */
export class HerdrCli {
    runner;
    bin;
    session;
    constructor(options = {}) {
        this.bin = options.bin ?? "herdr";
        this.session = options.session ?? null;
        this.runner = options.runner ?? new SyncCommandRunner();
    }
    async createWorktree(input) {
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
        if (!workspaceId || !path || !branch)
            throw new Error("Herdr worktree create returned incomplete identity");
        return { workspaceId, path, branch };
    }
    async prepareAttempt(input) {
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
        if (!paneId)
            throw new Error("Herdr tab create returned no root pane");
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
        if (!started)
            throw new Error(`Herdr did not register agent ${agentName}`);
        if (started.workspaceId !== input.worktree.workspaceId || started.paneId !== paneId) {
            throw new Error("Herdr agent identity does not match the prepared tab");
        }
        return started;
    }
    async prompt(input) {
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
    async wait(input) {
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
        let result = null;
        if (existsSync(input.resultPath)) {
            const parsed = JSON.parse(readFileSync(input.resultPath, "utf8"));
            result = parsed;
        }
        return { agentStatus: status, result };
    }
    async close(handle) {
        this.invokeVoid(["pane", "close", handle.paneId, "--json"]);
    }
    tryGetAgent(agentName) {
        const result = this.runner.run(this.bin, this.args(["agent", "get", agentName, "--json"]));
        if (!result.ok)
            return null;
        const value = unwrap(JSON.parse(result.stdout));
        const agent = object(value.agent ?? value);
        const paneId = text(agent.pane_id);
        const workspaceId = text(agent.workspace_id);
        if (!paneId || !workspaceId)
            return null;
        return { agentName, paneId, workspaceId };
    }
    invoke(args) {
        const stdout = requireSuccess(this.runner.run(this.bin, this.args(args)), `herdr ${args.slice(0, 2).join(" ")}`);
        return unwrap(JSON.parse(stdout));
    }
    invokeVoid(args) {
        requireSuccess(this.runner.run(this.bin, this.args(args)), `herdr ${args.slice(0, 2).join(" ")}`);
    }
    args(args) {
        return this.session ? ["--session", this.session, ...args] : args;
    }
}
function unwrap(value) {
    if (!value || typeof value !== "object")
        throw new Error("Herdr response is not an object");
    const envelope = value;
    if (envelope.error)
        throw new Error(`Herdr error: ${JSON.stringify(envelope.error)}`);
    const result = envelope.result;
    return result && typeof result === "object" ? result : envelope;
}
function object(value) {
    return value && typeof value === "object" ? value : {};
}
function text(value) {
    return typeof value === "string" && value.trim() ? value : null;
}
function safe(value) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
}
//# sourceMappingURL=herdr-cli.js.map