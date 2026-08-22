import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { digest, type JobState } from "../model.js";
import type { EventEnvelope, ProjectViewEnvelope } from "../transport/telegram-protocol.js";

export type ProjectOutboxEntry = {
  kind: "payload";
  key: string;
  payload: unknown;
  attempts: number;
  nextAttemptAt: number;
} | {
  kind: "approval";
  key: string;
  analysisId: string;
  attempts: number;
  nextAttemptAt: number;
};

export type ProjectObserverStateV3 = {
  version: 3;
  initialized: boolean;
  ledgerInitialized: boolean;
  ledgerHealthy: boolean;
  logInitialized: boolean;
  logHealthy: boolean;
  controllerHealth: ProjectViewEnvelope["project"]["controller"]["health"];
  controllerLogOffset: number;
  lastControllerAlertKey: string | null;
  lastJobId: string | null;
  lastJobRevision: number | null;
  lastJobState: JobState | null;
  lastIncidentId: string | null;
  lastAnalysisId: string | null;
  lastAutomaticRecoveryCount: number;
  terminalCount: number;
  lastProjectionDigest: string | null;
  lastEventByCategory: Record<string, { dedupeKey: string; at: string }>;
  outbox: ProjectOutboxEntry[];
};

const MAX_OUTBOX = 512;
const JOB_STATES: Array<JobState | null> = [
  "claimed", "worker_ready", "worker_running", "reviewer_ready", "reviewer_running", "publish_ready",
  "awaiting_merge", "blocked", "recovery_approved", "done", "cancelled", null,
];

export function loadProjectObserverState(path: string): ProjectObserverStateV3 {
  if (!existsSync(path)) return emptyProjectObserverState();
  assertSecureFile(path, "observer state");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const value = raw.version === 3 ? raw : migrateLegacyState(raw);
  assertProjectObserverState(value);
  return value;
}

export function saveProjectObserverState(path: string, state: ProjectObserverStateV3): void {
  assertProjectObserverState(state);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = join(directory, `.observer-state.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function enqueueProjectEvent(
  state: ProjectObserverStateV3,
  event: EventEnvelope,
  cooldownMs = 0,
): boolean {
  const previous = state.lastEventByCategory[event.category];
  if (previous?.dedupeKey === event.dedupeKey || state.outbox.some((entry) => entry.key === event.dedupeKey)) return false;
  if (previous && cooldownMs > 0
    && previous.dedupeKey.split(":").at(-1) === event.dedupeKey.split(":").at(-1)
    && Date.parse(event.occurredAt) - Date.parse(previous.at) < cooldownMs) return false;
  enqueue(state, { kind: "payload", key: event.dedupeKey, payload: event, attempts: 0, nextAttemptAt: 0 });
  state.lastEventByCategory[event.category] = { dedupeKey: event.dedupeKey, at: event.occurredAt };
  return true;
}

export function enqueueProjectApproval(state: ProjectObserverStateV3, analysisId: string): void {
  const key = `operator.approval:${analysisId}`;
  if (state.outbox.some((entry) => entry.key === key)) return;
  enqueue(state, { kind: "approval", key, analysisId, attempts: 0, nextAttemptAt: 0 });
}

export function removeProjectOutboxEntry(state: ProjectObserverStateV3, entry: ProjectOutboxEntry): void {
  state.outbox = state.outbox.filter((candidate) => candidate !== entry);
}

export function projectProjectionDigest(projection: ProjectViewEnvelope): string {
  const { generatedAt: _generatedAt, ...stable } = projection;
  return digest(stable);
}

function enqueue(state: ProjectObserverStateV3, entry: ProjectOutboxEntry): void {
  if (state.outbox.length >= MAX_OUTBOX) throw new Error(`observer outbox reached ${MAX_OUTBOX} entries`);
  state.outbox.push(entry);
}

function emptyProjectObserverState(): ProjectObserverStateV3 {
  return {
    version: 3,
    initialized: false,
    ledgerInitialized: false,
    ledgerHealthy: true,
    logInitialized: false,
    logHealthy: true,
    controllerHealth: "unknown",
    controllerLogOffset: 0,
    lastControllerAlertKey: null,
    lastJobId: null,
    lastJobRevision: null,
    lastJobState: null,
    lastIncidentId: null,
    lastAnalysisId: null,
    lastAutomaticRecoveryCount: 0,
    terminalCount: 0,
    lastProjectionDigest: null,
    lastEventByCategory: {},
    outbox: [],
  };
}

function migrateLegacyState(raw: Record<string, unknown>): ProjectObserverStateV3 {
  if (raw.version !== 1 && raw.version !== 2) throw new Error("unsupported observer state version");
  const legacyOutbox = Array.isArray(raw.outbox) ? raw.outbox : [];
  const outbox: ProjectOutboxEntry[] = legacyOutbox.map((item) => {
    const entry = record(item);
    const common = {
      key: String(entry.key ?? ""),
      attempts: Number(entry.attempts ?? 0),
      nextAttemptAt: Number(entry.nextAttemptAt ?? 0),
    };
    if (entry.kind === "approval") return { kind: "approval" as const, ...common, analysisId: String(entry.analysisId ?? "") };
    const text = String(entry.message ?? "");
    return {
      kind: "payload" as const,
      ...common,
      payload: entry.kind === "card" ? { text } : { text, parseMode: "plain" },
    };
  });
  return {
    version: 3,
    initialized: raw.initialized === true,
    ledgerInitialized: raw.ledgerInitialized === true,
    ledgerHealthy: raw.ledgerHealthy !== false,
    logInitialized: raw.logInitialized === true,
    logHealthy: raw.logHealthy !== false,
    controllerHealth: raw.controllerDown === true ? "down" : "healthy",
    controllerLogOffset: Number(raw.controllerLogOffset ?? 0),
    lastControllerAlertKey: typeof raw.lastControllerAlertKey === "string" ? raw.lastControllerAlertKey : null,
    lastJobId: typeof raw.lastJobId === "string" ? raw.lastJobId : null,
    lastJobRevision: Number.isInteger(raw.lastJobRevision) ? Number(raw.lastJobRevision) : null,
    lastJobState: typeof raw.lastJobState === "string" ? raw.lastJobState as JobState : null,
    lastIncidentId: typeof raw.lastIncidentId === "string" ? raw.lastIncidentId : null,
    lastAnalysisId: typeof raw.lastAnalysisId === "string" ? raw.lastAnalysisId : null,
    lastAutomaticRecoveryCount: Number.isInteger(raw.lastAutomaticRecoveryCount) ? Number(raw.lastAutomaticRecoveryCount) : 0,
    terminalCount: Number.isInteger(raw.terminalCount) ? Number(raw.terminalCount) : 0,
    lastProjectionDigest: null,
    lastEventByCategory: {},
    outbox,
  };
}

function assertProjectObserverState(value: unknown): asserts value is ProjectObserverStateV3 {
  const state = record(value);
  if (state.version !== 3 || typeof state.initialized !== "boolean" || typeof state.ledgerInitialized !== "boolean"
    || typeof state.ledgerHealthy !== "boolean" || typeof state.logInitialized !== "boolean" || typeof state.logHealthy !== "boolean"
    || !["healthy", "degraded", "down", "unknown"].includes(String(state.controllerHealth))
    || !Number.isSafeInteger(state.controllerLogOffset) || Number(state.controllerLogOffset) < 0
    || (state.lastControllerAlertKey !== null && typeof state.lastControllerAlertKey !== "string")
    || (state.lastJobId !== null && typeof state.lastJobId !== "string")
    || (state.lastJobRevision !== null && (!Number.isSafeInteger(state.lastJobRevision) || Number(state.lastJobRevision) < 0))
    || !JOB_STATES.includes(state.lastJobState as JobState | null)
    || (state.lastIncidentId !== null && typeof state.lastIncidentId !== "string")
    || (state.lastAnalysisId !== null && typeof state.lastAnalysisId !== "string")
    || !Number.isSafeInteger(state.lastAutomaticRecoveryCount) || Number(state.lastAutomaticRecoveryCount) < 0
    || !Number.isSafeInteger(state.terminalCount) || Number(state.terminalCount) < 0
    || (state.lastProjectionDigest !== null && (typeof state.lastProjectionDigest !== "string" || !/^[0-9a-f]{64}$/.test(state.lastProjectionDigest)))
    || !state.lastEventByCategory || typeof state.lastEventByCategory !== "object" || Array.isArray(state.lastEventByCategory)
    || !Array.isArray(state.outbox) || state.outbox.length > MAX_OUTBOX) throw new Error("invalid observer state");
  for (const entry of state.outbox as ProjectOutboxEntry[]) {
    if (!entry || !entry.key || entry.key.length > 512 || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0 || !Number.isFinite(entry.nextAttemptAt)
      || (entry.kind !== "payload" && (entry.kind !== "approval" || !entry.analysisId))) throw new Error("invalid observer outbox");
  }
  for (const item of Object.values(state.lastEventByCategory as Record<string, unknown>)) {
    const entry = record(item);
    if (typeof entry.dedupeKey !== "string" || !entry.dedupeKey || typeof entry.at !== "string" || !Number.isFinite(Date.parse(entry.at))) {
      throw new Error("invalid observer event dedupe state");
    }
  }
}

function assertSecureFile(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error(`${label} must be a private regular file`);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
