import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { digest } from "../model.js";
import type { EventEnvelope, FleetViewEnvelope } from "../transport/telegram-protocol.js";

export type FleetObserverOutboxEntry = {
  key: string;
  payload: EventEnvelope;
  attempts: number;
  nextAttemptAt: number;
};

export type FleetObserverState = {
  version: 1;
  initialized: boolean;
  supervisorUp: boolean | null;
  configDrift: boolean;
  projectPhases: Record<string, string>;
  projectControllerHealth: Record<string, string>;
  lastProjectionDigest: string | null;
  lastEventByCategory: Record<string, { dedupeKey: string; at: string }>;
  outbox: FleetObserverOutboxEntry[];
};

const MAX_OUTBOX = 512;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PHASES = new Set(["pending", "starting", "running", "adopted", "backoff", "tripped", "stopping", "stopped", "disabled", "unselected", "error"]);
const HEALTH = new Set(["healthy", "degraded", "down", "unknown"]);

export function loadFleetObserverState(path: string): FleetObserverState {
  if (!existsSync(path)) return emptyState();
  assertSecureFile(path, "Fleet observer state");
  const value = JSON.parse(readFileSync(path, "utf8")) as FleetObserverState;
  assertState(value);
  return value;
}

export function saveFleetObserverState(path: string, state: FleetObserverState): void {
  assertState(state);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = join(directory, `.fleet-observer.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function enqueueFleetEvent(state: FleetObserverState, event: EventEnvelope): void {
  if (state.lastEventByCategory[event.category]?.dedupeKey === event.dedupeKey
    || state.outbox.some((entry) => entry.key === event.dedupeKey)) return;
  if (state.outbox.length >= MAX_OUTBOX) throw new Error(`Fleet observer outbox reached ${MAX_OUTBOX} entries`);
  state.outbox.push({ key: event.dedupeKey, payload: event, attempts: 0, nextAttemptAt: 0 });
  state.lastEventByCategory[event.category] = { dedupeKey: event.dedupeKey, at: event.occurredAt };
}

export function fleetProjectionDigest(projection: FleetViewEnvelope): string {
  const { generatedAt: _generatedAt, ...stable } = projection;
  return digest(stable);
}

function emptyState(): FleetObserverState {
  return {
    version: 1,
    initialized: false,
    supervisorUp: null,
    configDrift: false,
    projectPhases: {},
    projectControllerHealth: {},
    lastProjectionDigest: null,
    lastEventByCategory: {},
    outbox: [],
  };
}

function assertState(value: FleetObserverState): void {
  if (!value || value.version !== 1 || typeof value.initialized !== "boolean"
    || (value.supervisorUp !== null && typeof value.supervisorUp !== "boolean")
    || typeof value.configDrift !== "boolean"
    || !record(value.projectPhases) || !record(value.projectControllerHealth) || !record(value.lastEventByCategory)
    || (value.lastProjectionDigest !== null && !/^[0-9a-f]{64}$/.test(value.lastProjectionDigest))
    || !Array.isArray(value.outbox) || value.outbox.length > MAX_OUTBOX
    || value.outbox.some((entry) => !entry?.key || !entry.payload || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0 || !Number.isFinite(entry.nextAttemptAt))) {
    throw new Error("invalid Fleet observer state");
  }
  if (Object.entries(value.projectPhases).some(([projectId, phase]) => !PROJECT_ID.test(projectId) || !PHASES.has(phase))
    || Object.entries(value.projectControllerHealth).some(([projectId, health]) => !PROJECT_ID.test(projectId) || !HEALTH.has(health))) {
    throw new Error("invalid Fleet observer project snapshot");
  }
  for (const event of Object.values(value.lastEventByCategory)) {
    if (!event || typeof event.dedupeKey !== "string" || !event.dedupeKey || typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at))) {
      throw new Error("invalid Fleet observer dedupe state");
    }
  }
}

function record(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertSecureFile(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error(`${label} must be a private regular file`);
}
