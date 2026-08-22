#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { transportEvent } from "./transport/event-projection.js";
import { fleetViewFromConfig, loadFleetTransportConfig } from "./transport/fleet-projection.js";
import type { EventEnvelope, FleetViewEnvelope } from "./transport/telegram-protocol.js";
import {
  enqueueFleetEvent,
  fleetProjectionDigest,
  loadFleetObserverState,
  saveFleetObserverState,
  type FleetObserverOutboxEntry,
  type FleetObserverState,
} from "./observer/fleet-state.js";

const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];

type FleetObserverConfig = {
  configPath: string;
  routeId: string;
  fleetConfig: string;
  routes: Record<string, string>;
  deliveryCommand: string[];
  observerState: string;
  pollMs: number;
  heartbeatTimeoutMs: number;
};

async function main(argv: string[]): Promise<number> {
  if (argv[2] !== "run") throw new Error("usage: fleet-observer run --config /absolute/fleet-observer.json [--once]");
  const config = loadConfig(requiredFlag(argv, "--config"));
  const once = argv.includes("--once");
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  do {
    await cycle(config);
    if (once || stopped) return 0;
    await delay(config.pollMs);
  } while (!stopped);
  return 0;
}

async function cycle(config: FleetObserverConfig): Promise<void> {
  const state = loadFleetObserverState(config.observerState);
  flush(config, state);
  const now = new Date().toISOString();
  let projection: FleetViewEnvelope;
  try {
    projection = await fleetViewFromConfig(config.configPath, { now, heartbeatTimeoutMs: config.heartbeatTimeoutMs });
  } catch {
    if (state.supervisorUp !== false) enqueueFleetEvent(state, fleetEvent(config, "fleet.down", "critical", "Fleet status unavailable", "The Fleet status projection cannot be read; no process or workflow mutation was attempted.", true, now));
    state.supervisorUp = false;
    state.initialized = true;
    saveFleetObserverState(config.observerState, state);
    flush(config, state);
    return;
  }
  const currentSupervisorUp = supervisorUp(projection);
  if (!state.initialized) {
    baseline(state, projection, currentSupervisorUp);
    saveFleetObserverState(config.observerState, state);
    return;
  }

  if (state.supervisorUp === true && !currentSupervisorUp) {
    enqueueFleetEvent(state, fleetEvent(config, "fleet.down", "critical", "Fleet Supervisor is down", "The Fleet lease, heartbeat, runtime state, or Supervisor PID is not healthy.", true, now));
  } else if (state.supervisorUp === false && currentSupervisorUp) {
    enqueueFleetEvent(state, fleetEvent(config, "fleet.up", "info", "Fleet Supervisor restored", "The Fleet Supervisor lease, heartbeat, runtime state, and PID are observable again.", false, now));
  }
  if (!state.configDrift && projection.fleet.configDrift) {
    enqueueFleetEvent(state, fleetEvent(config, "fleet.config-drift", "critical", "Fleet configuration drift", "The running Fleet state is bound to a different configuration digest; an operator must restart from reviewed configuration.", true, now));
  }

  for (const project of projection.projects) {
    const previousPhase = state.projectPhases[project.projectId];
    if (previousPhase && previousPhase !== project.phase) enqueueProjectPhase(state, projection, project, previousPhase, now);
    const previousHealth = state.projectControllerHealth[project.projectId];
    if (previousHealth === "healthy" && project.controller.health !== "healthy") {
      enqueueFleetEvent(state, transportEvent({
        routeId: project.routeId,
        projectId: project.projectId,
        fleetId: projection.fleetId,
        occurredAt: now,
        severity: "critical",
        category: "controller.down",
        dedupeKey: `controller.down:${project.projectId}:${project.controller.health}:${now}`,
        title: "Project Controller health degraded",
        summary: "The project Controller lease or heartbeat is not healthy; Fleet Observer did not restart it.",
        facts: [{ label: "Process phase", value: project.phase }, { label: "Controller health", value: project.controller.health }],
        actionRequired: true,
      }));
    } else if (previousHealth && previousHealth !== "healthy" && project.controller.health === "healthy") {
      enqueueFleetEvent(state, transportEvent({
        routeId: project.routeId,
        projectId: project.projectId,
        fleetId: projection.fleetId,
        occurredAt: now,
        severity: "info",
        category: "controller.up",
        dedupeKey: `controller.up:${project.projectId}:healthy:${now}`,
        title: "Project Controller health restored",
        summary: "The project Controller lease and heartbeat are healthy again.",
        facts: [{ label: "Process phase", value: project.phase }],
      }));
    }
  }
  baseline(state, projection, currentSupervisorUp);
  saveFleetObserverState(config.observerState, state);
  flush(config, state);
}

function enqueueProjectPhase(
  state: FleetObserverState,
  projection: FleetViewEnvelope,
  project: FleetViewEnvelope["projects"][number],
  previousPhase: string,
  now: string,
): void {
  const category = project.phase === "backoff"
    ? "project.backoff"
    : project.phase === "tripped"
      ? "project.tripped"
      : project.phase === "error"
        ? "project.error"
        : project.phase === "adopted"
          ? "project.adopted"
          : project.phase === "running" && ["backoff", "tripped", "error", "adopted"].includes(previousPhase)
            ? "project.running"
            : null;
  if (!category) return;
  const adopted = category === "project.adopted";
  const recovered = category === "project.running";
  enqueueFleetEvent(state, transportEvent({
    routeId: project.routeId,
    projectId: project.projectId,
    fleetId: projection.fleetId,
    occurredAt: now,
    severity: adopted || recovered ? "info" : category === "project.backoff" ? "warning" : "critical",
    category,
    dedupeKey: `${category}:${project.projectId}:${previousPhase}:${project.restartCount}:${project.nextStartAt ?? "none"}:${now}`,
    title: adopted ? "Fleet adopted an existing Controller" : recovered ? "Fleet project is running" : `Fleet project entered ${project.phase}`,
    summary: adopted
      ? "Fleet is observing an existing live Controller without ownership and did not start a second writer."
      : recovered
        ? "The project process returned to running; workflow state remains independently authoritative."
        : project.phase === "backoff"
          ? "The owned project process exited and entered bounded restart backoff; sibling projects continue."
          : "The project process requires operator attention; sibling projects and workflow authority remain isolated.",
    facts: [
      { label: "Previous phase", value: previousPhase },
      { label: "Process phase", value: project.phase },
      { label: "Restarts", value: String(project.restartCount) },
    ],
    actionRequired: !adopted && !recovered,
  }));
}

function baseline(state: FleetObserverState, projection: FleetViewEnvelope, currentSupervisorUp: boolean): void {
  state.initialized = true;
  state.supervisorUp = currentSupervisorUp;
  state.configDrift = projection.fleet.configDrift;
  state.projectPhases = Object.fromEntries(projection.projects.map((project) => [project.projectId, project.phase]));
  state.projectControllerHealth = Object.fromEntries(projection.projects.map((project) => [project.projectId, project.controller.health]));
  state.lastProjectionDigest = fleetProjectionDigest(projection);
}

function supervisorUp(projection: FleetViewEnvelope): boolean {
  return projection.fleet.lease === "alive" && projection.fleet.heartbeat === "fresh"
    && projection.fleet.supervisorPidAlive === true && !projection.fleet.runtimeError;
}

function fleetEvent(
  config: FleetObserverConfig,
  category: "fleet.down" | "fleet.up" | "fleet.config-drift",
  severity: EventEnvelope["severity"],
  title: string,
  summary: string,
  actionRequired: boolean,
  now: string,
): EventEnvelope {
  const fleetId = loadFleetName(config.fleetConfig);
  return transportEvent({
    routeId: config.routeId,
    projectId: null,
    fleetId,
    occurredAt: now,
    severity,
    category,
    dedupeKey: `${category}:${fleetId}:${now}`,
    title,
    summary,
    actionRequired,
  });
}

function flush(config: FleetObserverConfig, state: FleetObserverState): void {
  for (;;) {
    const entry = state.outbox.find((candidate) => candidate.nextAttemptAt <= Date.now());
    if (!entry) return;
    const sent = spawnSync(config.deliveryCommand[0]!, config.deliveryCommand.slice(1), {
      encoding: "utf8",
      input: JSON.stringify(entry.payload),
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    if (sent.status === 0) {
      state.outbox = state.outbox.filter((candidate) => candidate !== entry);
      saveFleetObserverState(config.observerState, state);
      continue;
    }
    retry(config, state, entry);
    return;
  }
}

function retry(config: FleetObserverConfig, state: FleetObserverState, entry: FleetObserverOutboxEntry): void {
  entry.attempts += 1;
  entry.nextAttemptAt = Date.now() + RETRY_DELAYS_MS[Math.min(entry.attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
  saveFleetObserverState(config.observerState, state);
  process.stderr.write(`${JSON.stringify({ ok: false, action: "notification_retry", key: entry.key, attempts: entry.attempts, code: "delivery_failed" })}\n`);
}

function loadConfig(path: string): FleetObserverConfig {
  assertSecureFile(path, "Fleet observer config");
  const transport = loadFleetTransportConfig(path);
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (typeof value.observerState !== "string" || !isAbsolute(value.observerState)
    || !Number.isInteger(value.pollMs) || Number(value.pollMs) < 1_000
    || !Number.isInteger(value.heartbeatTimeoutMs) || Number(value.heartbeatTimeoutMs) < Number(value.pollMs) * 3) {
    throw new Error("Fleet observer state/poll configuration is invalid");
  }
  return {
    configPath: path,
    routeId: transport.routeId,
    fleetConfig: transport.fleetConfig,
    routes: transport.routes,
    deliveryCommand: command(value.deliveryCommand),
    observerState: value.observerState,
    pollMs: Number(value.pollMs),
    heartbeatTimeoutMs: Number(value.heartbeatTimeoutMs),
  };
}

function command(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16
    || value.some((part) => typeof part !== "string" || !part || part.includes("\0")) || !isAbsolute(value[0]!)) {
    throw new Error("deliveryCommand must be one fixed absolute argv");
  }
  return value;
}

function assertSecureFile(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error(`${label} must be a private regular file`);
}

function loadFleetName(path: string): string {
  const value = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
  return typeof value.name === "string" && value.name ? value.name : "herdr-fleet";
}

function requiredFlag(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : null;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, milliseconds); });
}

main(process.argv)
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
