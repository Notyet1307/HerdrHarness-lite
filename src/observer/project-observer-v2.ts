import { Buffer } from "node:buffer";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { JsonStateStore } from "../adapters/json-store.js";
import type { AutomaticRecovery, HarnessState, Job } from "../model.js";
import { operatorActionsFor } from "../policy.js";
import { automaticRecoveryEvent, preflightFailureEvent, recoveryQuotaExhaustedEvent, transportEvent } from "../transport/event-projection.js";
import { loadProjectHarnessConfig, loadProjectTransportConfig, projectView, type ProjectHarnessConfig } from "../transport/project-projection.js";
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
  let ledger: HarnessState;
  try {
    ledger = await new JsonStateStore(config.harnessStateDir).load();
  } catch {
    if (observer.ledgerHealthy) enqueueProjectEvent(observer, stateEvent(config.identity, "ledger.unavailable", "critical", "Harness ledger unavailable", "The project ledger cannot be read; no recovery action was attempted.", true, now));
    observer.ledgerHealthy = false;
    return;
  }
  if (!observer.ledgerHealthy && observer.ledgerInitialized) {
    enqueueProjectEvent(observer, stateEvent(config.identity, "ledger.restored", "info", "Harness ledger restored", "The project ledger is readable again.", false, now));
  }
  observer.ledgerHealthy = true;
  const projection = projectView(ledger, config.harness, config.identity, {
    now,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
  });
  if (!observer.ledgerInitialized) {
    observer.ledgerInitialized = true;
    baseline(observer, ledger);
    observer.controllerHealth = projection.project.controller.health;
    observer.lastProjectionDigest = projectProjectionDigest(projection);
    return;
  }

  if (ledger.terminalJobs.length < observer.terminalCount) {
    enqueueProjectEvent(observer, stateEvent(config.identity, "state.unavailable", "critical", "Terminal history regressed", "Harness terminal history regressed; an operator must inspect the ledger.", true, now));
  } else {
    for (const terminal of ledger.terminalJobs.slice(observer.terminalCount)) {
      enqueueProjectEvent(observer, transportEvent({
        ...config.identity,
        occurredAt: terminal.finishedAt,
        severity: "info",
        category: terminal.state === "done" ? "project.done" : "project.cancelled",
        dedupeKey: `project.${terminal.state}:${terminal.id}`,
        title: terminal.state === "done" ? "Project task completed" : "Project task cancelled",
        summary: "Harness recorded a new terminal workflow state.",
        facts: [{ label: "Issue", value: String(terminal.issueNumber) }, { label: "State", value: terminal.state }],
      }, now));
    }
  }

  const job = ledger.activeJob;
  const changed = job?.id !== observer.lastJobId;
  if (job && changed) {
    enqueueProjectEvent(observer, transportEvent({
      ...config.identity,
      occurredAt: job.createdAt,
      severity: "info",
      category: "project.started",
      dedupeKey: `project.started:${job.id}`,
      title: "Project task started",
      summary: "Harness selected and durably recorded a new project task.",
      facts: [{ label: "Issue", value: String(job.task.issueNumber) }, { label: "State", value: job.state }],
    }, now));
    observeCurrentJob(config, observer, job, 0, null, null, now);
  } else if (job) {
    observeCurrentJob(config, observer, job, observer.lastAutomaticRecoveryCount, observer.lastIncidentId, observer.lastAnalysisId, now);
  } else if (observer.lastJobId && ledger.terminalJobs.length === observer.terminalCount) {
    enqueueProjectEvent(observer, stateEvent(config.identity, "state.unavailable", "critical", "Active workflow disappeared", "The active Job disappeared without a new terminal record; an operator must inspect the ledger.", true, now));
  }

  observeControllerHealth(config.identity, observer, projection.project.controller.health, now);
  baseline(observer, ledger);
  observer.lastProjectionDigest = projectProjectionDigest(projection);
}

function observeCurrentJob(
  config: ProjectObserverV2Config,
  observer: ProjectObserverStateV3,
  job: Job,
  recoveryOffset: number,
  previousIncident: string | null,
  previousAnalysis: string | null,
  now: string,
): void {
  const recoveries = job.automaticRecoveries ?? [];
  const newRecoveries = recoveries.slice(Math.min(recoveryOffset, recoveries.length));
  for (const recovery of newRecoveries) enqueueProjectEvent(observer, automaticRecoveryEvent(job, recovery, config.identity, now));
  if (newRecoveries.length > 0) return;
  const incidentChanged = job.incident?.id !== (previousIncident ?? undefined);
  const analysisChanged = job.analysis?.id !== (previousAnalysis ?? undefined);
  if (job.analysis && analysisChanged) {
    const option = operatorActionsFor(job).find((candidate) => candidate.kind === "approve_retry");
    if (job.state === "blocked" && job.incident && job.analysis.incidentId === job.incident.id && option?.effect === job.analysis.action) {
      enqueueProjectApproval(observer, job.analysis.id);
      return;
    }
    const actions = operatorActionsFor(job).map((action) => action.kind);
    enqueueProjectEvent(observer, transportEvent({
      ...config.identity,
      occurredAt: job.analysis.createdAt,
      severity: actions.length > 0 ? "warning" : "info",
      category: "analyst.decision",
      dedupeKey: `analyst.decision:${job.analysis.id}`,
      title: "Analyst decision recorded",
      summary: "Harness recorded a bounded Analyst recommendation; it does not authorize workflow mutation.",
      facts: [{ label: "Recommendation", value: job.analysis.action }, { label: "Operator options", value: String(actions.length) }],
      actionRequired: actions.length > 0,
      operatorActionKinds: actions,
    }, now));
  } else if (job.incident && incidentChanged) {
    enqueueIncident(config.identity, observer, job, now);
  }
}

function enqueueIncident(identity: TransportIdentity & { projectId: string }, observer: ProjectObserverStateV3, job: Job, now: string): void {
  const incident = job.incident!;
  const exhausted = recoveryQuotaExhaustedEvent(job, identity, now);
  if (exhausted) {
    enqueueProjectEvent(observer, exhausted);
    return;
  }
  const code = incident.runtimeDiagnostic?.code ?? incident.runtimeDiagnostic?.failureCode
    ?? (incident.class === "integrity_violation" || incident.class === "validation_infrastructure" ? incident.class : null);
  const classified = code ? preflightFailureEvent({
    ...identity,
    position: incident.id,
    failureCode: code,
    retryable: incident.runtimeDiagnostic?.retryable ?? false,
  }, incident.createdAt) : null;
  if (classified) {
    enqueueProjectEvent(observer, classified);
    return;
  }
  const actions = operatorActionsFor(job).map((action) => action.kind);
  enqueueProjectEvent(observer, transportEvent({
    ...identity,
    occurredAt: incident.createdAt,
    severity: "warning",
    category: "incident.new",
    dedupeKey: `incident.new:${incident.id}`,
    title: "New workflow incident",
    summary: "Harness recorded a new workflow incident; the workflow remains fail-closed.",
    facts: [{ label: "Class", value: incident.class }, { label: "Lane", value: incident.lane }],
    actionRequired: actions.length > 0,
    operatorActionKinds: actions,
  }, now));
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
  let value: unknown;
  try { value = JSON.parse(line) as unknown; } catch { return; }
  const event = record(value);
  if (event.ok === true) {
    observer.lastControllerAlertKey = null;
    return;
  }
  if (event.ok !== false || typeof event.action !== "string" || event.action === "blocked") return;
  const diagnostic = record(event.runtimeDiagnostic ?? event.failure);
  const failureCode = typeof event.failureCode === "string"
    ? event.failureCode
    : typeof diagnostic.code === "string"
      ? diagnostic.code
      : typeof diagnostic.failureCode === "string" ? diagnostic.failureCode : null;
  const retryable = typeof event.retryable === "boolean"
    ? event.retryable
    : typeof diagnostic.retryable === "boolean" ? diagnostic.retryable : null;
  const alertKey = `${event.action}\0${typeof event.jobId === "string" ? event.jobId : ""}\0${failureCode ?? "legacy"}`;
  if (alertKey === observer.lastControllerAlertKey) return;
  observer.lastControllerAlertKey = alertKey;
  const projected = preflightFailureEvent({
    ...identity,
    position,
    failureCode: event.action === "preflight_failed" ? failureCode : event.action,
    retryable,
  }, now);
  if (projected) enqueueProjectEvent(observer, projected, PREFLIGHT_COOLDOWN_MS);
}

function baseline(observer: ProjectObserverStateV3, ledger: HarnessState): void {
  const job = ledger.activeJob;
  observer.lastJobId = job?.id ?? null;
  observer.lastJobRevision = job?.revision ?? null;
  observer.lastJobState = job?.state ?? null;
  observer.lastIncidentId = job?.incident?.id ?? null;
  observer.lastAnalysisId = job?.analysis?.id ?? null;
  observer.lastAutomaticRecoveryCount = job?.automaticRecoveries?.length ?? 0;
  observer.terminalCount = ledger.terminalJobs.length;
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, milliseconds); });
}
