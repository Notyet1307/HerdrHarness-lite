import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { loadFleetConfig } from "../fleet/config.js";
import { processIsAlive } from "../fleet/lease.js";
import { readFleetStatus } from "../fleet/status.js";
import type { FleetProjectPhase, LoadedFleetConfig } from "../fleet/types.js";
import {
  assertBoundedTransportEnvelope,
  FLEET_PROJECT_PHASES,
  transportBase,
  TRANSPORT_PROJECT_ID,
  TRANSPORT_ROUTE_ID,
  type ControllerProjection,
  type FleetViewEnvelope,
} from "./telegram-protocol.js";

type FleetTransportConfig = {
  transportVersion: 2;
  routeId: string;
  fleetConfig: string;
  routes: Record<string, string>;
};

export async function fleetViewFromConfig(
  configPath: string,
  options: { now?: string; heartbeatTimeoutMs?: number } = {},
): Promise<FleetViewEnvelope> {
  const transport = loadFleetTransportConfig(configPath);
  const fleet = loadFleetConfig(transport.fleetConfig);
  validateRoutes(fleet, transport.routes);
  return fleetView(await readFleetStatus(fleet, false), fleet, transport, options);
}

export function fleetView(
  rawStatus: Record<string, unknown>,
  config: LoadedFleetConfig,
  transport: Pick<FleetTransportConfig, "routeId" | "routes">,
  options: { now?: string; heartbeatTimeoutMs?: number } = {},
): FleetViewEnvelope {
  const now = options.now ?? new Date().toISOString();
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 30_000;
  const runtime = recordOrNull(rawStatus.runtime);
  const runtimeProjects = recordOrNull(runtime?.projects) ?? {};
  const rawProjects = Array.isArray(rawStatus.projects) ? rawStatus.projects.map(recordOrNull).filter(isRecord) : [];
  const fleetLease = leaseStatus(recordOrNull(rawStatus.fleetLease));
  const fleetHeartbeat = heartbeatStatus(recordOrNull(rawStatus.fleetHeartbeat), heartbeatTimeoutMs);
  const runtimePid = safePid(runtime?.supervisorPid);
  const supervisorPidAlive = runtimePid === null ? null : processIsAlive(runtimePid);
  const runtimeError = rawStatus.runtimeError !== null || runtime === null;
  const configDrift = rawStatus.configDrift === true;
  const stopping = runtime?.stopping === true;
  const projects = config.projects.map((project) => {
    const rawProject = rawProjects.find((entry) => entry.id === project.id) ?? null;
    const projectRuntime = recordOrNull(runtimeProjects[project.id]);
    const phase = fleetPhase(projectRuntime?.phase, project.enabled, runtimeError);
    const pid = safePid(projectRuntime?.pid);
    const controller = controllerStatus(
      recordOrNull(rawProject?.controllerLease),
      recordOrNull(rawProject?.controllerHeartbeat),
      heartbeatTimeoutMs,
    );
    return {
      routeId: transport.routes[project.id]!,
      projectId: project.id,
      enabled: project.enabled,
      phase,
      owned: projectRuntime?.owned === true,
      pidPresent: pid !== null,
      pidAlive: pid === null ? null : processIsAlive(pid),
      nextStartAt: validTime(projectRuntime?.nextStartAt),
      restartCount: Array.isArray(projectRuntime?.restartTimestamps)
        ? Math.min(projectRuntime.restartTimestamps.length, config.restartPolicy.maxRestarts + 1)
        : 0,
      restartWindowMs: config.restartPolicy.windowMs,
      lastExitCategory: exitCategory(recordOrNull(projectRuntime?.lastExit)),
      controller,
      workflow: workflowProjection(recordOrNull(rawProject?.workflow)),
    } satisfies FleetViewEnvelope["projects"][number];
  });
  const unhealthyPhase = projects.some((project) => ["backoff", "tripped", "error"].includes(project.phase));
  const unhealthyController = projects.some((project) => (
    (project.phase === "running" || project.phase === "adopted") && project.controller.health !== "healthy"
  ));
  const down = fleetLease !== "alive" || fleetHeartbeat.status !== "fresh" || supervisorPidAlive === false;
  const health: FleetViewEnvelope["fleet"]["health"] = configDrift
    ? "config-drift"
    : down
      ? "down"
      : runtimeError || stopping || unhealthyPhase || unhealthyController
        ? "degraded"
        : "healthy";
  return assertBoundedTransportEnvelope({
    ...transportBase("fleet-view", { routeId: transport.routeId, projectId: null, fleetId: config.name }, now),
    fleet: {
      health,
      lease: fleetLease,
      heartbeat: fleetHeartbeat.status,
      heartbeatAgeMs: fleetHeartbeat.ageMs,
      runtimeError,
      configDrift,
      supervisorPidAlive,
      stopping,
    },
    projects,
  });
}

export function loadFleetTransportConfig(path: string): FleetTransportConfig {
  if (!isAbsolute(path)) throw new Error("Fleet transport config path must be absolute");
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<FleetTransportConfig>;
  if (value.transportVersion !== 2 || !TRANSPORT_ROUTE_ID.test(value.routeId ?? "")
    || !value.fleetConfig || !isAbsolute(value.fleetConfig)
    || !value.routes || typeof value.routes !== "object" || Array.isArray(value.routes)) {
    throw new Error("Fleet transport config is invalid");
  }
  return value as FleetTransportConfig;
}

function validateRoutes(config: LoadedFleetConfig, routes: Record<string, string>): void {
  const expected = config.projects.map((project) => project.id).sort();
  const actual = Object.keys(routes).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)
    || actual.some((projectId) => !TRANSPORT_PROJECT_ID.test(projectId) || !TRANSPORT_ROUTE_ID.test(routes[projectId] ?? ""))
    || new Set(Object.values(routes)).size !== actual.length) {
    throw new Error("Fleet transport routes must map every project to one unique routeId");
  }
}

function controllerStatus(
  lease: Record<string, unknown> | null,
  heartbeat: Record<string, unknown> | null,
  timeoutMs: number,
): ControllerProjection {
  const observedLease = leaseStatus(lease);
  const observedHeartbeat = heartbeatStatus(heartbeat, timeoutMs);
  const health = observedLease === "alive" && observedHeartbeat.status === "fresh"
    ? "healthy"
    : observedLease === "malformed" || observedHeartbeat.status === "malformed"
      ? "unknown"
      : observedLease === "stale" || observedHeartbeat.status === "stale"
        ? "down"
        : "degraded";
  return {
    health,
    lease: observedLease,
    heartbeat: observedHeartbeat.status,
    heartbeatAgeMs: observedHeartbeat.ageMs,
    pidAlive: observedLease === "alive" ? true : observedLease === "stale" ? false : null,
  };
}

function leaseStatus(value: Record<string, unknown> | null): ControllerProjection["lease"] {
  return value?.status === "alive" || value?.status === "stale" || value?.status === "absent" || value?.status === "malformed"
    ? value.status
    : "malformed";
}

function heartbeatStatus(value: Record<string, unknown> | null, timeoutMs: number): {
  status: ControllerProjection["heartbeat"];
  ageMs: number | null;
} {
  if (value?.status === "absent") return { status: "absent", ageMs: null };
  if (value?.status !== "present" || !Number.isFinite(value.ageMs)) return { status: "malformed", ageMs: null };
  const ageMs = Math.max(0, Number(value.ageMs));
  return { status: ageMs > timeoutMs ? "stale" : "fresh", ageMs };
}

function fleetPhase(value: unknown, enabled: boolean, runtimeError: boolean): FleetProjectPhase {
  if (typeof value === "string" && (FLEET_PROJECT_PHASES as readonly string[]).includes(value)) return value as FleetProjectPhase;
  if (!enabled) return "disabled";
  return runtimeError ? "error" : "pending";
}

function exitCategory(value: Record<string, unknown> | null): FleetViewEnvelope["projects"][number]["lastExitCategory"] {
  if (!value) return null;
  if (typeof value.signal === "string" && value.signal) return "signal";
  if (value.code === 0) return "clean";
  if (Number.isInteger(value.code)) return "error";
  return "unknown";
}

function workflowProjection(value: Record<string, unknown> | null): FleetViewEnvelope["projects"][number]["workflow"] {
  if (!value) return null;
  return {
    state: typeof value.state === "string" ? value.state.slice(0, 64) : null,
    issueNumber: safeNonnegativeInteger(value.issueNumber),
    revision: safeNonnegativeInteger(value.revision),
    incidentClass: typeof value.incident === "string" ? value.incident.slice(0, 128) : null,
  };
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isRecord(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return value !== null;
}

function safePid(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function safeNonnegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function validTime(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null;
}
