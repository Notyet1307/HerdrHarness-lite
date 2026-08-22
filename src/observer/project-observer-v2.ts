import { Buffer } from "node:buffer";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { JsonStateStore } from "../adapters/json-store.js";
import { transportEvent } from "../transport/event-projection.js";
import { projectLogProjection, projectObservationProjection, type ProjectObservationProjection } from "../transport/project-observation.js";
import { loadProjectHarnessConfig, loadProjectTransportConfig, type ProjectHarnessConfig } from "../transport/project-projection.js";
import type { EventEnvelope, TransportIdentity } from "../transport/telegram-protocol.js";
import { flushProjectOutbox, type ProjectDeliveryConfig } from "./project-delivery.js";
import {
  enqueueProjectApproval,
  enqueueProjectEvent,
  loadProjectObserverState,
  projectProjectionDigest,
  saveProjectObserverState,
  type ProjectObserverStateV3,
} from "./project-state.js";

const LOG_CHUNK_BYTES = 1024 * 1024;
const PREFLIGHT_COOLDOWN_MS = 5 * 60_000;

type ConfigFile = {
  transportVersion: 2;
  routeId: string;
  projectId: string;
  fleetId?: string;
  harnessConfig: string;
  nodeBin: string;
  harnessCliScript: string;
  approvalScript: string;
  approvalState: string;
  telegramAllowedUser: string;
  deliveryCommand: string[];
  observerState: string;
  controllerLog: string;
  pollMs: number;
  heartbeatTimeoutMs: number;
};

type ProjectObserverV2Config = ConfigFile & ProjectDeliveryConfig & {
  identity: TransportIdentity & { projectId: string };
  harness: ProjectHarnessConfig;
};

export function projectObserverTransportVersion(path: string): number | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { transportVersion?: unknown };
    return Number.isInteger(value.transportVersion) ? Number(value.transportVersion) : null;
  } catch {
    return null;
  }
}

export async function runProjectObserverV2(configPath: string, once: boolean): Promise<number> {
  const config = loadConfig(configPath);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    do {
      await cycle(config);
      if (once || stopped) return 0;
      await delay(config.pollMs);
    } while (!stopped);
    return 0;
  } finally {
    stopped = true;
  }
}

async function cycle(config: ProjectObserverV2Config): Promise<void> {
  const observer = loadProjectObserverState(config.observerState);
  await flushProjectOutbox(config, observer);
  const now = new Date().toISOString();
  await observeLedger(config, observer, now);
  observeControllerLog(config, observer, now);
  observer.initialized = true;
  saveProjectObserverState(config.observerState, observer);
  await flushProjectOutbox(config, observer);
}

async function observeLedger(config: ProjectObserverV2Config, observer: ProjectObserverStateV3, now: string): Promise<void> {
  let projection: ProjectObservationProjection;
  try {
    projection = projectObservationProjection(
      await new JsonStateStore(config.harnessStateDir).load(),
      config.harness,
      config.identity,
      { now, heartbeatTimeoutMs: config.heartbeatTimeoutMs },
    );
  } catch {
    if (observer.ledgerHealthy) enqueueProjectEvent(observer, stateEvent(config.identity, "ledger.unavailable", "critical", "Harness ledger unavailable", "The project ledger cannot be read; no recovery action was attempted.", true, now));
    observer.ledgerHealthy = false;
    return;
  }
  if (!observer.ledgerHealthy && observer.ledgerInitialized) {
    enqueueProjectEvent(observer, stateEvent(config.identity, "ledger.restored", "info", "Harness ledger restored", "The project ledger is readable again.", false, now));
  }
  observer.ledgerHealthy = true;
  if (!observer.ledgerInitialized) {
    observer.ledgerInitialized = true;
    baseline(observer, projection);
    observer.controllerHealth = projection.view.project.controller.health;
    observer.lastProjectionDigest = projectProjectionDigest(projection.view);
    return;
  }

  if (projection.terminalCount < observer.terminalCount) {
    enqueueProjectEvent(observer, stateEvent(config.identity, "state.unavailable", "critical", "Terminal history regressed", "Harness terminal history regressed; an operator must inspect the ledger.", true, now));
  } else if (observer.terminalCount < projection.terminalWindowStart) {
    enqueueProjectEvent(observer, stateEvent(config.identity, "state.unavailable", "critical", "Terminal transition window exceeded", "More terminal transitions occurred than the bounded projection can carry; query the ledger through the read-only CLI.", true, now));
  } else {
    for (const event of projection.terminalEvents.slice(observer.terminalCount - projection.terminalWindowStart)) enqueueProjectEvent(observer, event);
  }

  const active = projection.active;
  const changed = active?.id !== observer.lastJobId;
  if (active && changed) {
    enqueueProjectEvent(observer, active.startedEvent);
    observeCurrentProjection(observer, active, 0, null, null);
  } else if (active) {
    observeCurrentProjection(observer, active, observer.lastAutomaticRecoveryCount, observer.lastIncidentId, observer.lastAnalysisId);
  } else if (observer.lastJobId && projection.terminalCount === observer.terminalCount) {
    enqueueProjectEvent(observer, stateEvent(config.identity, "state.unavailable", "critical", "Active workflow disappeared", "The active Job disappeared without a new terminal record; an operator must inspect the ledger.", true, now));
  }

  observeControllerHealth(config.identity, observer, projection.view.project.controller.health, now);
  baseline(observer, projection);
  observer.lastProjectionDigest = projectProjectionDigest(projection.view);
}

function observeCurrentProjection(
  observer: ProjectObserverStateV3,
  active: NonNullable<ProjectObservationProjection["active"]>,
  recoveryOffset: number,
  previousIncident: string | null,
  previousAnalysis: string | null,
): void {
  const newRecoveries = active.automaticRecoveryEvents.slice(Math.min(recoveryOffset, active.automaticRecoveryEvents.length));
  for (const event of newRecoveries) enqueueProjectEvent(observer, event);
  if (newRecoveries.length > 0) return;
  const incidentChanged = active.incidentId !== previousIncident;
  const analysisChanged = active.analysisId !== previousAnalysis;
  if (active.approvalAnalysisId && analysisChanged) enqueueProjectApproval(observer, active.approvalAnalysisId);
  else if (active.analysisEvent && analysisChanged) enqueueProjectEvent(observer, active.analysisEvent);
  else if (active.incidentEvent && incidentChanged) enqueueProjectEvent(observer, active.incidentEvent);
}

function observeControllerHealth(
  identity: TransportIdentity & { projectId: string },
  observer: ProjectObserverStateV3,
  health: ProjectObserverStateV3["controllerHealth"],
  now: string,
): void {
  const previous = observer.controllerHealth;
  if (previous === "healthy" && health !== "healthy") {
    enqueueProjectEvent(observer, transportEvent({
      ...identity,
      occurredAt: now,
      severity: "critical",
      category: "controller.down",
      dedupeKey: `controller.down:${identity.projectId}:${health}:${now}`,
      title: "Controller health degraded",
      summary: "The Controller lease or heartbeat is not healthy; Observer did not attempt a restart.",
      facts: [{ label: "Health", value: health }],
      actionRequired: true,
    }));
  } else if (previous !== "healthy" && previous !== "unknown" && health === "healthy") {
    enqueueProjectEvent(observer, transportEvent({
      ...identity,
      occurredAt: now,
      severity: "info",
      category: "controller.up",
      dedupeKey: `controller.up:${identity.projectId}:healthy:${now}`,
      title: "Controller health restored",
      summary: "The Controller lease and heartbeat are healthy again.",
      facts: [{ label: "Health", value: "healthy" }],
    }));
  }
  observer.controllerHealth = health;
}

function observeControllerLog(config: ProjectObserverV2Config, observer: ProjectObserverStateV3, now: string): void {
  if (!existsSync(config.controllerLog)) {
    observer.logInitialized = true;
    observer.controllerLogOffset = 0;
    return;
  }
  try {
    const stat = statSync(config.controllerLog);
    if (!observer.logInitialized) {
      observer.logInitialized = true;
      observer.controllerLogOffset = stat.size;
      return;
    }
    observer.logHealthy = true;
    if (stat.size < observer.controllerLogOffset) {
      observer.controllerLogOffset = stat.size;
      observer.lastControllerAlertKey = null;
      return;
    }
    if (stat.size === observer.controllerLogOffset) return;
    const text = readLogChunk(config.controllerLog, observer.controllerLogOffset, stat.size);
    const newline = text.lastIndexOf("\n");
    if (newline < 0) return;
    const complete = text.slice(0, newline + 1);
    const startingOffset = observer.controllerLogOffset;
    observer.controllerLogOffset += Buffer.byteLength(complete, "utf8");
    complete.split("\n").forEach((line, index) => {
      if (line.trim()) observeControllerEvent(config.identity, observer, line, `${startingOffset}:${index}`, now);
    });
  } catch {
    observer.logHealthy = false;
  }
}

function observeControllerEvent(
  identity: TransportIdentity & { projectId: string },
  observer: ProjectObserverStateV3,
  line: string,
  position: string,
  now: string,
): void {
  const projected = projectLogProjection(line, identity, position, now);
  if (projected.kind === "healthy") {
    observer.lastControllerAlertKey = null;
    return;
  }
  if (projected.kind !== "failure" || projected.alertKey === observer.lastControllerAlertKey) return;
  observer.lastControllerAlertKey = projected.alertKey;
  enqueueProjectEvent(observer, projected.event, PREFLIGHT_COOLDOWN_MS);
}

function baseline(observer: ProjectObserverStateV3, projection: ProjectObservationProjection): void {
  const active = projection.active;
  observer.lastJobId = active?.id ?? null;
  observer.lastJobRevision = active?.revision ?? null;
  observer.lastJobState = active?.state as ProjectObserverStateV3["lastJobState"] ?? null;
  observer.lastIncidentId = active?.incidentId ?? null;
  observer.lastAnalysisId = active?.analysisId ?? null;
  observer.lastAutomaticRecoveryCount = active?.automaticRecoveryCount ?? 0;
  observer.terminalCount = projection.terminalCount;
}

function stateEvent(
  identity: TransportIdentity & { projectId: string },
  category: "ledger.unavailable" | "ledger.restored" | "state.unavailable" | "state.restored",
  severity: EventEnvelope["severity"],
  title: string,
  summary: string,
  actionRequired: boolean,
  now: string,
): EventEnvelope {
  return transportEvent({
    ...identity,
    occurredAt: now,
    severity,
    category,
    dedupeKey: `${category}:${identity.projectId}:${now}`,
    title,
    summary,
    actionRequired,
  });
}

function loadConfig(path: string): ProjectObserverV2Config {
  assertSecureFile(path, "observer config");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ConfigFile>;
  const transport = loadProjectTransportConfig(path);
  const harness = loadProjectHarnessConfig(transport.harnessConfig, transport.projectId);
  for (const key of ["nodeBin", "harnessCliScript", "approvalScript", "approvalState", "observerState", "controllerLog"] as const) {
    if (!parsed[key] || !isAbsolute(parsed[key])) throw new Error(`${key} must be absolute`);
  }
  if (!parsed.telegramAllowedUser || !/^[1-9][0-9]{2,19}$/.test(parsed.telegramAllowedUser)) {
    throw new Error("telegramAllowedUser must be one numeric Telegram user id");
  }
  if (!Number.isInteger(parsed.pollMs) || parsed.pollMs! < 1_000
    || !Number.isInteger(parsed.heartbeatTimeoutMs) || parsed.heartbeatTimeoutMs! < parsed.pollMs! * 3) {
    throw new Error("Observer poll/heartbeat configuration is invalid");
  }
  const deliveryCommand = command(parsed.deliveryCommand, "deliveryCommand");
  return {
    ...(parsed as ConfigFile),
    observerConfigPath: path,
    harnessStateDir: harness.stateDir,
    deliveryCommand,
    identity: { routeId: transport.routeId, projectId: transport.projectId, fleetId: transport.fleetId ?? null },
    harness,
  };
}

function command(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16
    || value.some((part) => typeof part !== "string" || !part || part.includes("\0")) || !isAbsolute(value[0]!)) {
    throw new Error(`${label} must be one fixed absolute argv`);
  }
  return value;
}

function assertSecureFile(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error(`${label} must be a private regular file`);
}

function readLogChunk(path: string, offset: number, size: number): string {
  const length = Math.min(size - offset, LOG_CHUNK_BYTES);
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(path, "r");
  try {
    const bytes = readSync(descriptor, buffer, 0, length, offset);
    return buffer.toString("utf8", 0, bytes);
  } finally {
    closeSync(descriptor);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, milliseconds); });
}
