import { Buffer } from "node:buffer";
import { digest } from "../model.js";

export const TELEGRAM_TRANSPORT_VERSION = 2 as const;
export const TELEGRAM_TRANSPORT_MAX_BYTES = 32 * 1024;
export const TRANSPORT_ROUTE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const TRANSPORT_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type TransportIdentity = {
  routeId: string;
  projectId: string | null;
  fleetId: string | null;
};

export type TransportKind = "project-view" | "fleet-view" | "diagnostic-view" | "event";

export type ControllerProjection = {
  health: "healthy" | "degraded" | "down" | "unknown";
  lease: "alive" | "stale" | "absent" | "malformed";
  heartbeat: "fresh" | "stale" | "absent" | "malformed";
  heartbeatAgeMs: number | null;
  pidAlive: boolean | null;
};

export type ProjectViewEnvelope = {
  version: typeof TELEGRAM_TRANSPORT_VERSION;
  kind: "project-view";
  generatedAt: string;
  routeId: string;
  projectId: string;
  fleetId: string | null;
  project: {
    repo: string;
    controller: ControllerProjection;
  };
  workflow: {
    mode: "idle" | "running" | "waiting" | "needs_decision" | "terminal";
    state: string | null;
    jobId: string | null;
    issueNumber: number | null;
    revision: number | null;
    reviewRound: number | null;
    maxReviewRounds: number | null;
    lane: "worker" | "reviewer" | null;
    phase: string | null;
    attemptId: string | null;
    headSha: string | null;
    pullRequest: { number: number; url: string } | null;
    incidentClass: string | null;
    incidentLane: "worker" | "reviewer" | "controller" | null;
  };
  runtime: {
    adapter: "herdr-pi-cli" | "pi-rpc" | null;
    provider: string | null;
    model: string | null;
    runtimeVersion: string | null;
    credentialMode: "runtime-default" | "canonical-oauth" | "canonical-model-config" | null;
    axisConcurrency: 1 | 2 | null;
    compactionMode: "runtime-default" | "disabled" | "controlled-threshold" | null;
    lastProgressType: string | null;
    lastProgressAt: string | null;
    elapsedMs: number | null;
    runtimeDeadlineAt: string | null;
    remainingBucket: "expired" | "lt5m" | "5m_15m" | "15m_60m" | "gte60m" | "unknown";
    resultPresent: boolean | null;
  };
  reviewer: {
    validationStatus: "passed" | "failed-checks" | "infrastructure-error" | null;
    validationDurationMs: number | null;
    validationOutputByteBuckets: { stdout: string | null; stderr: string | null };
    validationOutputDigests: { stdout: string | null; stderr: string | null };
    reusedCheckpointStages: string[];
    missingAxisStages: Array<"standards-axis" | "spec-axis">;
  };
  failure: {
    taxonomyDomain: string | null;
    failureDomain: string | null;
    failureCode: string | null;
    failureDetailCode: string | null;
    retryable: boolean | null;
    partial: boolean;
    corrupt: boolean;
    unknown: boolean;
  };
  recovery: {
    automaticRule: string | null;
    action: string | null;
    notBefore: string | null;
    quotaConsumed: boolean;
    humanActionRequired: boolean;
  };
  actions: Array<{
    id: string;
    kind: "approve_retry" | "reassess" | "resolve_decision" | "cancel";
    effect: "retry_fresh_worker" | "retry_fresh_reviewer" | "rerun_analysis" | "cancel_and_requeue";
  }>;
};

export const FLEET_PROJECT_PHASES = [
  "pending", "starting", "running", "adopted", "backoff", "tripped",
  "stopping", "stopped", "disabled", "unselected", "error",
] as const;

export type FleetViewEnvelope = {
  version: typeof TELEGRAM_TRANSPORT_VERSION;
  kind: "fleet-view";
  generatedAt: string;
  routeId: string;
  projectId: null;
  fleetId: string;
  fleet: {
    health: "healthy" | "degraded" | "down" | "config-drift";
    lease: "alive" | "stale" | "absent" | "malformed";
    heartbeat: "fresh" | "stale" | "absent" | "malformed";
    heartbeatAgeMs: number | null;
    runtimeError: boolean;
    configDrift: boolean;
    supervisorPidAlive: boolean | null;
    stopping: boolean;
  };
  projects: Array<{
    routeId: string;
    projectId: string;
    enabled: boolean;
    phase: typeof FLEET_PROJECT_PHASES[number];
    owned: boolean;
    pidPresent: boolean;
    pidAlive: boolean | null;
    nextStartAt: string | null;
    restartCount: number;
    restartWindowMs: number;
    lastExitCategory: "clean" | "error" | "signal" | "unknown" | null;
    controller: ControllerProjection;
    workflow: {
      state: string | null;
      issueNumber: number | null;
      revision: number | null;
      incidentClass: string | null;
    } | null;
  }>;
};

export type DiagnosticViewEnvelope = {
  version: typeof TELEGRAM_TRANSPORT_VERSION;
  kind: "diagnostic-view";
  generatedAt: string;
  routeId: string;
  projectId: string | null;
  fleetId: string | null;
  diagnostic: {
    days: 7 | 30;
    partial: boolean;
    corruptProjects: number;
    corruptAttempts: number;
    corruptArtifacts: number;
    totalAttempts: number;
    partialAttempts: number;
    unknownAttempts: number;
    resultPresentButTerminalMissing: number;
    runtimeStallsAndDeadlines: number;
    credentialFailures: number;
    validationInfrastructure: number;
    automaticRecoveryCount: number;
    topFailureCodes: Array<{ key: string; count: number }>;
    byLane: Array<{ key: string; count: number }>;
    byProviderModel: Array<{ key: string; count: number }>;
  };
};

export const TRANSPORT_EVENT_CATEGORIES = [
  "project.started",
  "project.done",
  "project.cancelled",
  "incident.new",
  "analyst.decision",
  "operator.approval",
  "recovery.automatic",
  "recovery.exhausted",
  "controller.down",
  "controller.up",
  "fleet.down",
  "fleet.up",
  "fleet.config-drift",
  "project.backoff",
  "project.tripped",
  "project.error",
  "project.adopted",
  "project.running",
  "ledger.unavailable",
  "ledger.restored",
  "state.unavailable",
  "state.restored",
  "preflight.failed",
  "runtime.stall",
  "runtime.deadline",
] as const;

export type EventEnvelope = {
  version: typeof TELEGRAM_TRANSPORT_VERSION;
  kind: "event";
  generatedAt: string;
  routeId: string;
  projectId: string | null;
  fleetId: string | null;
  eventId: string;
  dedupeKey: string;
  occurredAt: string;
  severity: "info" | "warning" | "critical";
  category: typeof TRANSPORT_EVENT_CATEGORIES[number];
  title: string;
  summary: string;
  facts: Array<{ label: string; value: string }>;
  actionRequired: boolean;
  operatorActionKinds: Array<"approve_retry" | "reassess" | "resolve_decision" | "cancel">;
  approval?: {
    token: string;
    approveLabel: string;
    expiresAt: string;
  };
};

const TRANSPORT_ACTION_KINDS = ["approve_retry", "reassess", "resolve_decision", "cancel"] as const;

export function validateTransportEventEnvelope(value: unknown): EventEnvelope {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > TELEGRAM_TRANSPORT_MAX_BYTES) {
    throw new Error("transport event exceeds its byte budget");
  }
  const event = transportRecord(value, [
    "version", "kind", "generatedAt", "routeId", "projectId", "fleetId", "eventId", "dedupeKey",
    "occurredAt", "severity", "category", "title", "summary", "facts", "actionRequired", "operatorActionKinds",
  ], ["approval"]);
  if (event.version !== TELEGRAM_TRANSPORT_VERSION || event.kind !== "event"
    || !transportTime(event.generatedAt) || !TRANSPORT_ROUTE_ID.test(String(event.routeId))
    || !nullableTransportId(event.projectId) || !nullableTransportId(event.fleetId)
    || !transportText(event.eventId, 256) || !transportText(event.dedupeKey, 512)
    || !transportTime(event.occurredAt) || !["info", "warning", "critical"].includes(String(event.severity))
    || !TRANSPORT_EVENT_CATEGORIES.includes(event.category as EventEnvelope["category"])
    || !transportText(event.title, 160) || !transportText(event.summary, 1_000)
    || typeof event.actionRequired !== "boolean") throw new Error("invalid transport event");
  if (!Array.isArray(event.facts) || event.facts.length > 16) throw new Error("invalid transport event facts");
  for (const value of event.facts) {
    const fact = transportRecord(value, ["label", "value"]);
    if (!transportText(fact.label, 80) || !transportText(fact.value, 512)) throw new Error("invalid transport event fact");
  }
  if (!Array.isArray(event.operatorActionKinds) || event.operatorActionKinds.length > 4
    || new Set(event.operatorActionKinds).size !== event.operatorActionKinds.length
    || event.operatorActionKinds.some((kind) => !TRANSPORT_ACTION_KINDS.includes(kind as typeof TRANSPORT_ACTION_KINDS[number]))) {
    throw new Error("invalid transport event actions");
  }
  if (event.approval !== undefined) {
    const approval = transportRecord(event.approval, ["token", "approveLabel", "expiresAt"]);
    if (!/^[0-9A-F]{16}$/.test(String(approval.token)) || !transportText(approval.approveLabel, 64)
      || !transportTime(approval.expiresAt) || event.category !== "operator.approval" || event.actionRequired !== true) {
      throw new Error("invalid transport event approval");
    }
  }
  return event as EventEnvelope;
}

function transportRecord(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid transport event object");
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("invalid transport event fields");
  }
  return record;
}

function transportText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= max && !/[\0\r\n]/.test(value);
}

function transportTime(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function nullableTransportId(value: unknown): boolean {
  return value === null || typeof value === "string" && TRANSPORT_PROJECT_ID.test(value);
}

export type TelegramTransportEnvelope = ProjectViewEnvelope | FleetViewEnvelope | DiagnosticViewEnvelope | EventEnvelope;

export function transportBase<K extends TransportKind, P extends string | null, F extends string | null>(
  kind: K,
  identity: Omit<TransportIdentity, "projectId" | "fleetId"> & { projectId: P; fleetId: F },
  now: string,
): {
  version: typeof TELEGRAM_TRANSPORT_VERSION;
  kind: K;
  generatedAt: string;
  routeId: string;
  projectId: P;
  fleetId: F;
} {
  if (!TRANSPORT_ROUTE_ID.test(identity.routeId)) throw new Error("transport routeId is invalid");
  if (identity.projectId !== null && !TRANSPORT_PROJECT_ID.test(identity.projectId)) {
    throw new Error("transport projectId is invalid");
  }
  if (identity.fleetId !== null && !TRANSPORT_PROJECT_ID.test(identity.fleetId)) {
    throw new Error("transport fleetId is invalid");
  }
  if (!Number.isFinite(Date.parse(now))) throw new Error("transport generatedAt is invalid");
  return {
    version: TELEGRAM_TRANSPORT_VERSION,
    kind,
    generatedAt: new Date(Date.parse(now)).toISOString(),
    routeId: identity.routeId,
    projectId: identity.projectId,
    fleetId: identity.fleetId,
  };
}

export function safeRuntimeId(kind: "provider" | "model", value: string | null | undefined): string | null {
  return value?.trim() ? `sha256:${digest({ kind, value })}` : null;
}

export function boundedTransportText(value: unknown, maxBytes: number): string {
  const normalized = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  let output = "";
  for (const character of normalized) {
    if (Buffer.byteLength(output + character, "utf8") > maxBytes) break;
    output += character;
  }
  return output;
}

export function assertBoundedTransportEnvelope<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > TELEGRAM_TRANSPORT_MAX_BYTES) {
    throw new Error("transport envelope exceeds its byte budget");
  }
  return value;
}

export function remainingBucket(deadline: string | null | undefined, now: string): ProjectViewEnvelope["runtime"]["remainingBucket"] {
  if (!deadline || !Number.isFinite(Date.parse(deadline))) return "unknown";
  const remaining = Date.parse(deadline) - Date.parse(now);
  if (remaining <= 0) return "expired";
  if (remaining < 5 * 60_000) return "lt5m";
  if (remaining < 15 * 60_000) return "5m_15m";
  if (remaining < 60 * 60_000) return "15m_60m";
  return "gte60m";
}
