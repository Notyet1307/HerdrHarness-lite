import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { startFleetHeartbeat } from "./heartbeat.js";
import { acquireFleetLease, observeProjectControllerLease } from "./lease.js";
import { decideRestart, parseRestartTimestamps } from "./restart-policy.js";
import { FleetStateStore } from "./store.js";
import type {
  FleetProjectRuntime,
  FleetRuntimeState,
  LoadedFleetConfig,
  LoadedFleetProject,
} from "./types.js";

type Child = ReturnType<typeof spawn>;
type Slot = {
  project: LoadedFleetProject;
  child: Child | null;
  timer: unknown;
  exitHandled: boolean;
};

export async function runFleetSupervisor(input: {
  config: LoadedFleetConfig;
  projects: LoadedFleetProject[];
}): Promise<void> {
  const supervisor = new FleetSupervisor(input.config, input.projects);
  await supervisor.run();
}

class FleetSupervisor {
  private readonly store: FleetStateStore;
  private readonly selectedIds: Set<string>;
  private readonly slots = new Map<string, Slot>();
  private readonly state: FleetRuntimeState;
  private stopping = false;
  private stopPromise: Promise<void>;
  private resolveStop!: () => void;
  private lease: { stop(): void } | null = null;
  private heartbeat: { stop(): void } | null = null;

  constructor(private readonly config: LoadedFleetConfig, projects: LoadedFleetProject[]) {
    this.store = new FleetStateStore(config.stateDir);
    this.selectedIds = new Set(projects.map((project) => project.id));
    const previous = this.loadPrevious();
    const now = new Date().toISOString();
    this.state = {
      version: 1,
      fleetName: config.name,
      configDigest: config.digest,
      supervisorPid: process.pid,
      startedAt: now,
      updatedAt: now,
      stopping: false,
      projects: {},
    };
    for (const project of config.projects) {
      const selected = project.enabled && this.selectedIds.has(project.id);
      const old = previous?.projects[project.id];
      this.state.projects[project.id] = !project.enabled
        ? disabledRuntime(project.id, project.configDigest)
        : selected
          ? restoredRuntime(project.id, project.configDigest, old)
          : unselectedRuntime(project.id, project.configDigest, old);
      if (selected) {
        this.slots.set(project.id, { project, child: null, timer: null, exitHandled: false });
      }
    }
    this.stopPromise = new Promise((resolveStop) => { this.resolveStop = resolveStop; });
  }

  async run(): Promise<void> {
    this.lease = acquireFleetLease(this.config.stateDir);
    try {
      this.heartbeat = startFleetHeartbeat(this.config.stateDir);
      this.save({ type: "supervisor_started", projects: [...this.selectedIds] });
      process.on("SIGINT", () => { void this.stop("SIGINT"); });
      process.on("SIGTERM", () => { void this.stop("SIGTERM"); });

      for (const slot of this.slots.values()) this.resumeOrStart(slot);
      await this.stopPromise;
    } catch (error) {
      try { this.heartbeat?.stop(); } catch { /* Best effort during failed startup. */ }
      this.heartbeat = null;
      try { this.lease?.stop(); } catch { /* Preserve the startup error. */ }
      this.lease = null;
      throw error;
    }
  }

  private resumeOrStart(slot: Slot): void {
    const runtime = this.runtime(slot.project.id);
    if (runtime.phase === "tripped") return;
    if (runtime.phase === "backoff" && runtime.nextStartAt) {
      const delay = Math.max(0, Date.parse(runtime.nextStartAt) - Date.now());
      if (delay > 0) {
        slot.timer = setTimeout(() => this.startOrAdopt(slot), delay);
        return;
      }
    }
    this.startOrAdopt(slot);
  }

  private startOrAdopt(slot: Slot): void {
    if (this.stopping) return;
    slot.timer = null;
    const observed = observeProjectControllerLease(slot.project.config.stateDir);
    if (observed.status === "alive") {
      const runtime = this.runtime(slot.project.id);
      runtime.phase = "adopted";
      runtime.pid = observed.pid;
      runtime.owned = false;
      runtime.startedAt = observed.acquiredAt;
      runtime.nextStartAt = null;
      runtime.lastError = null;
      this.checkpoint({ type: "project_adopted", projectId: slot.project.id, pid: observed.pid });
      this.scheduleAdoptedPoll(slot);
      return;
    }
    if (observed.status === "malformed") {
      const runtime = this.runtime(slot.project.id);
      runtime.phase = "error";
      runtime.pid = null;
      runtime.owned = false;
      runtime.lastError = observed.error;
      runtime.nextStartAt = null;
      this.checkpoint({ type: "project_lease_malformed", projectId: slot.project.id, error: observed.error });
      return;
    }
    this.spawnProject(slot);
  }

  private spawnProject(slot: Slot): void {
    const runtime = this.runtime(slot.project.id);
    runtime.phase = "starting";
    runtime.pid = null;
    runtime.owned = true;
    runtime.startedAt = new Date().toISOString();
    runtime.nextStartAt = null;
    runtime.lastError = null;
    slot.exitHandled = false;
    const cliPath = resolve(import.meta.dirname, "../cli.js");
    let child: Child;
    try {
      child = spawn(process.execPath, [
        cliPath,
        "run",
        "--config",
        slot.project.configPath,
        "--expected-config-digest",
        slot.project.configDigest,
        "--poll-ms",
        String(slot.project.pollMs),
      ], {
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.handleOwnedExit(slot, null, null, error instanceof Error ? error.message : String(error));
      return;
    }
    slot.child = child;
    child.stdin.end();
    runtime.pid = child.pid ?? null;
    if (!runtime.pid) {
      this.handleOwnedExit(slot, null, null, "Controller child did not expose a pid");
      return;
    }
    runtime.phase = "running";
    this.checkpoint({ type: "project_started", projectId: slot.project.id, pid: runtime.pid });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: unknown) => this.captureOutput(slot, "stdout", String(chunk)));
    child.stderr.on("data", (chunk: unknown) => this.captureOutput(slot, "stderr", String(chunk)));
    child.on("error", (error: Error) => this.handleOwnedExit(slot, null, null, error.message));
    child.on("exit", (code: number | null, signal: string | null) => this.handleOwnedExit(slot, code, signal, null));
  }

  private handleOwnedExit(slot: Slot, code: number | null, signal: string | null, error: string | null): void {
    if (slot.exitHandled) return;
    slot.exitHandled = true;
    slot.child = null;
    const runtime = this.runtime(slot.project.id);
    const exitedAt = new Date().toISOString();
    const runtimeMs = runtime.startedAt ? Math.max(0, Date.now() - Date.parse(runtime.startedAt)) : 0;
    runtime.pid = null;
    runtime.owned = false;
    runtime.lastExit = { code, signal, exitedAt, runtimeMs };
    runtime.lastError = error ?? (code === 0 ? null : `Controller exited with code=${String(code)} signal=${signal ?? "none"}`);
    if (this.stopping) {
      runtime.phase = "stopped";
      runtime.nextStartAt = null;
      try {
        this.save({ type: "project_stopped", projectId: slot.project.id, code, signal });
      } catch (saveError) {
        writeFleetWarning(`project ${slot.project.id} checkpoint`, saveError);
      }
      return;
    }

    const decision = decideRestart({
      policy: this.config.restartPolicy,
      timestamps: parseRestartTimestamps(runtime.restartTimestamps),
      now: Date.now(),
      runtimeMs,
    });
    runtime.restartTimestamps = decision.timestamps.map((timestamp) => new Date(timestamp).toISOString());
    if (decision.kind === "trip") {
      runtime.phase = "tripped";
      runtime.nextStartAt = null;
      runtime.lastError = runtime.lastError ?? "Controller restart circuit opened";
      this.checkpoint({ type: "project_tripped", projectId: slot.project.id, code, signal, runtimeMs });
      return;
    }
    runtime.phase = "backoff";
    runtime.nextStartAt = new Date(decision.nextStartAt).toISOString();
    this.checkpoint({
      type: "project_backoff",
      projectId: slot.project.id,
      code,
      signal,
      runtimeMs,
      backoffMs: decision.backoffMs,
    });
    slot.timer = setTimeout(() => this.startOrAdopt(slot), decision.backoffMs);
  }

  private scheduleAdoptedPoll(slot: Slot): void {
    if (this.stopping) return;
    const delay = Math.min(5_000, slot.project.pollMs);
    slot.timer = setTimeout(() => {
      slot.timer = null;
      const observed = observeProjectControllerLease(slot.project.config.stateDir);
      if (observed.status === "alive") {
        const runtime = this.runtime(slot.project.id);
        runtime.pid = observed.pid;
        this.scheduleAdoptedPoll(slot);
        return;
      }
      if (observed.status === "malformed") {
        const runtime = this.runtime(slot.project.id);
        runtime.phase = "error";
        runtime.pid = null;
        runtime.lastError = observed.error;
        this.checkpoint({ type: "project_lease_malformed", projectId: slot.project.id, error: observed.error });
        return;
      }
      const runtime = this.runtime(slot.project.id);
      runtime.phase = "pending";
      runtime.pid = null;
      runtime.startedAt = null;
      this.checkpoint({ type: "adopted_project_ended", projectId: slot.project.id });
      this.startOrAdopt(slot);
    }, delay);
  }

  private captureOutput(slot: Slot, stream: "stdout" | "stderr", chunk: string): void {
    const record = `${JSON.stringify({ type: "project_output", projectId: slot.project.id, stream, chunk })}\n`;
    (stream === "stdout" ? process.stdout : process.stderr).write(record);
  }

  private async stop(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.state.stopping = true;
    let stopError: unknown = null;
    try {
      for (const slot of this.slots.values()) {
        if (slot.timer !== null) clearTimeout(slot.timer);
        slot.timer = null;
        const runtime = this.runtime(slot.project.id);
        if (slot.child && runtime.owned) {
          runtime.phase = "stopping";
          slot.child.kill("SIGTERM");
        }
      }
      try {
        this.save({ type: "supervisor_stopping", reason });
      } catch (error) {
        stopError = error;
        writeFleetWarning("stopping checkpoint", error);
      }

      const deadline = Date.now() + this.config.shutdownGraceMs;
      await this.waitForOwnedChildren(deadline);
      for (const slot of this.slots.values()) {
        if (slot.child && this.runtime(slot.project.id).owned) slot.child.kill("SIGKILL");
      }
      await this.waitForOwnedChildren(Date.now() + 1_000);
      for (const slot of this.slots.values()) {
        const runtime = this.runtime(slot.project.id);
        if (runtime.owned) {
          runtime.phase = "stopped";
          runtime.pid = null;
          runtime.owned = false;
        }
      }
      try {
        this.save({ type: "supervisor_stopped", reason });
      } catch (error) {
        stopError ??= error;
        writeFleetWarning("final checkpoint", error);
      }
    } catch (error) {
      stopError ??= error;
      writeFleetWarning("child shutdown", error);
    } finally {
      try { this.heartbeat?.stop(); } catch (error) { writeFleetWarning("heartbeat release", error); }
      this.heartbeat = null;
      try { this.lease?.stop(); } catch (error) { writeFleetWarning("lease release", error); }
      this.lease = null;
      this.resolveStop();
    }
    if (stopError) writeFleetWarning("shutdown completed with degradation", stopError);
  }

  private async waitForOwnedChildren(deadline: number): Promise<void> {
    while (Date.now() < deadline && [...this.slots.values()].some((slot) => slot.child && this.runtime(slot.project.id).owned)) {
      await delay(100);
    }
  }

  private runtime(projectId: string): FleetProjectRuntime {
    const runtime = this.state.projects[projectId];
    if (!runtime) throw new Error(`missing Fleet runtime for ${projectId}`);
    return runtime;
  }

  private save(event: Record<string, unknown>): void {
    this.state.updatedAt = new Date().toISOString();
    this.state.supervisorPid = process.pid;
    this.store.save(this.state, event);
  }

  private checkpoint(event: Record<string, unknown>): void {
    try {
      this.save(event);
    } catch (error) {
      writeFleetWarning("runtime state checkpoint", error);
    }
  }

  private loadPrevious(): FleetRuntimeState | null {
    return this.store.load();
  }
}

function restoredRuntime(id: string, configDigest: string, previous: FleetProjectRuntime | undefined): FleetProjectRuntime {
  if (!previous || previous.configDigest !== configDigest) return pendingRuntime(id, configDigest);
  const keepBackoff = previous.phase === "backoff" && previous.nextStartAt && Date.parse(previous.nextStartAt) > Date.now();
  const phase = previous.phase === "tripped" ? "tripped" : keepBackoff ? "backoff" : "pending";
  return {
    ...previous,
    id,
    configDigest,
    phase,
    pid: null,
    owned: false,
    startedAt: null,
    nextStartAt: phase === "backoff" ? previous.nextStartAt : null,
    lastError: phase === "tripped" ? previous.lastError : null,
    restartTimestamps: previous.restartTimestamps ?? [],
  };
}

function pendingRuntime(id: string, configDigest: string): FleetProjectRuntime {
  return {
    id,
    configDigest,
    phase: "pending",
    pid: null,
    owned: false,
    startedAt: null,
    nextStartAt: null,
    restartTimestamps: [],
    lastExit: null,
    lastError: null,
  };
}

function disabledRuntime(id: string, configDigest: string): FleetProjectRuntime {
  return { ...pendingRuntime(id, configDigest), phase: "disabled" };
}

function unselectedRuntime(id: string, configDigest: string, previous: FleetProjectRuntime | undefined): FleetProjectRuntime {
  return {
    ...(previous?.configDigest === configDigest ? previous : pendingRuntime(id, configDigest)),
    id,
    configDigest,
    phase: "unselected",
    pid: null,
    owned: false,
    startedAt: null,
    nextStartAt: null,
  };
}

function writeFleetWarning(stage: string, error: unknown): void {
  process.stderr.write(`Fleet ${stage} warning: ${error instanceof Error ? error.message : String(error)}\n`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, milliseconds); });
}
