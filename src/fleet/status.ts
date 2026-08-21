import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertJobInvariant, type HarnessState } from "../model.js";
import { projectOperatorState } from "../policy.js";
import { fleetHeartbeatPath } from "./heartbeat.js";
import { fleetLeasePath, observeProjectControllerLease, processIsAlive } from "./lease.js";
import { FleetStateStore } from "./store.js";
import type { FleetRuntimeState, LoadedFleetConfig } from "./types.js";

export async function readFleetStatus(config: LoadedFleetConfig, operator: boolean): Promise<Record<string, unknown>> {
  const store = new FleetStateStore(config.stateDir);
  let runtime: FleetRuntimeState | null = null;
  let runtimeError: string | null = null;
  try { runtime = store.load(); }
  catch (error) { runtimeError = error instanceof Error ? error.message : String(error); }
  const projects = config.projects.map((project) => {
    const controllerLease = observeProjectControllerLease(project.config.stateDir);
    const statePath = join(project.config.stateDir, "state.json");
    let state: HarnessState | null = null;
    let stateError: string | null = null;
    try {
      if (existsSync(statePath)) {
        state = JSON.parse(readFileSync(statePath, "utf8")) as HarnessState;
        if (state.version !== 1 || !Array.isArray(state.terminalJobs)) throw new Error("invalid Harness state");
        if (state.activeJob) assertJobInvariant(state.activeJob);
      }
    } catch (error) {
      stateError = error instanceof Error ? error.message : String(error);
      state = null;
    }
    let operatorProjection: unknown = null;
    if (operator && state) {
      try { operatorProjection = projectOperatorState(state); }
      catch (error) { stateError = error instanceof Error ? error.message : String(error); }
    }
    const projectHeartbeat = readHeartbeat(join(project.config.stateDir, "controller-heartbeat.json"));
    return {
      id: project.id,
      enabled: project.enabled,
      repo: project.config.repo,
      configPath: project.configPath,
      configDigest: project.configDigest,
      controllerLease,
      controllerHeartbeat: projectHeartbeat,
      stateError,
      workflow: state ? {
        activeJobId: state.activeJob?.id ?? null,
        issueNumber: state.activeJob?.task.issueNumber ?? null,
        state: state.activeJob?.state ?? "idle",
        revision: state.activeJob?.revision ?? null,
        incident: state.activeJob?.incident?.class ?? null,
        terminalJobs: state.terminalJobs.length,
      } : null,
      ...(operator ? { operator: operatorProjection } : {}),
    };
  });
  return {
    version: 1,
    fleet: config.name,
    configDigest: config.digest,
    configPath: config.sourcePath,
    fleetLease: readFleetLease(config.stateDir),
    fleetHeartbeat: readHeartbeat(fleetHeartbeatPath(config.stateDir)),
    runtime,
    runtimeError,
    configDrift: runtime ? runtime.configDigest !== config.digest : false,
    projects,
  };
}

function readFleetLease(stateDir: string): Record<string, unknown> {
  const path = fleetLeasePath(stateDir);
  if (!existsSync(path)) return { status: "absent", path };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; acquiredAt?: unknown; instanceId?: unknown };
    const pid = typeof value.pid === "number" ? value.pid : null;
    return {
      status: pid && processIsAlive(pid) ? "alive" : "stale",
      path,
      pid,
      acquiredAt: value.acquiredAt ?? null,
      instanceId: value.instanceId ?? null,
    };
  } catch (error) {
    return { status: "malformed", path, error: error instanceof Error ? error.message : String(error) };
  }
}

function readHeartbeat(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { status: "absent", path };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { updatedAt?: unknown; parentPid?: unknown };
    const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : null;
    const ageMs = updatedAt ? Math.max(0, Date.now() - Date.parse(updatedAt)) : null;
    return {
      status: updatedAt && Number.isFinite(Date.parse(updatedAt)) ? "present" : "malformed",
      path,
      updatedAt,
      ageMs,
      parentPid: value.parentPid ?? null,
      mtimeMs: statSync(path).mtimeMs,
    };
  } catch (error) {
    return { status: "malformed", path, error: error instanceof Error ? error.message : String(error) };
  }
}
