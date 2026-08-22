import type { HarnessState, Job } from "../model.js";
import { operatorActionsFor } from "../policy.js";
import { FAILURE_CODES, PI_RPC_FAILURE_CODES } from "../pi-rpc-diagnostics.js";
import { automaticRecoveryEvent, preflightFailureEvent, recoveryQuotaExhaustedEvent, transportEvent } from "./event-projection.js";
import { projectView, type ProjectHarnessConfig } from "./project-projection.js";
import type { EventEnvelope, ProjectViewEnvelope, TransportIdentity } from "./telegram-protocol.js";

const MAX_TERMINAL_EVENTS = 64;
const LOG_FAILURE_CODES = new Set<string>([
  ...FAILURE_CODES,
  ...PI_RPC_FAILURE_CODES,
  "integrity_violation",
  "version_drift",
  "resource_drift",
  "config_drift",
]);

export type ProjectObservationProjection = {
  version: 2;
  view: ProjectViewEnvelope;
  terminalCount: number;
  terminalWindowStart: number;
  terminalEvents: EventEnvelope[];
  active: {
    id: string;
    revision: number;
    state: string;
    incidentId: string | null;
    analysisId: string | null;
    automaticRecoveryCount: number;
    startedEvent: EventEnvelope;
    automaticRecoveryEvents: EventEnvelope[];
    incidentEvent: EventEnvelope | null;
    analysisEvent: EventEnvelope | null;
    approvalAnalysisId: string | null;
  } | null;
};

export type ProjectLogProjection =
  | { kind: "ignore" }
  | { kind: "healthy" }
  | { kind: "failure"; alertKey: string; event: EventEnvelope };

export function projectObservationProjection(
  ledger: HarnessState,
  harness: ProjectHarnessConfig,
  identity: TransportIdentity & { projectId: string },
  options: { now: string; heartbeatTimeoutMs: number },
): ProjectObservationProjection {
  const view = projectView(ledger, harness, identity, options);
  const terminalWindowStart = Math.max(0, ledger.terminalJobs.length - MAX_TERMINAL_EVENTS);
  const terminalEvents = ledger.terminalJobs.slice(terminalWindowStart).map((terminal) => transportEvent({
    ...identity,
    occurredAt: terminal.finishedAt,
    severity: "info",
    category: terminal.state === "done" ? "project.done" : "project.cancelled",
    dedupeKey: `project.${terminal.state}:${terminal.id}`,
    title: terminal.state === "done" ? "Project task completed" : "Project task cancelled",
    summary: "Harness recorded a new terminal workflow state.",
    facts: [{ label: "Issue", value: String(terminal.issueNumber) }, { label: "State", value: terminal.state }],
  }, options.now));
  return {
    version: 2,
    view,
    terminalCount: ledger.terminalJobs.length,
    terminalWindowStart,
    terminalEvents,
    active: ledger.activeJob ? activeProjection(ledger.activeJob, identity, options.now) : null,
  };
}

export function projectLogProjection(
  line: string,
  identity: TransportIdentity & { projectId: string },
  position: string,
  occurredAt: string,
): ProjectLogProjection {
  let value: unknown;
  try { value = JSON.parse(line) as unknown; } catch { return { kind: "ignore" }; }
  const event = record(value);
  if (event.ok === true) return { kind: "healthy" };
  if (event.ok !== false || typeof event.action !== "string" || event.action === "blocked") return { kind: "ignore" };
  const diagnostic = record(event.runtimeDiagnostic ?? event.failure);
  const candidate = typeof event.failureCode === "string"
    ? event.failureCode
    : typeof diagnostic.code === "string"
      ? diagnostic.code
      : typeof diagnostic.failureCode === "string" ? diagnostic.failureCode : null;
  const failureCode = candidate !== null && LOG_FAILURE_CODES.has(candidate) ? candidate : null;
  const retryable = typeof event.retryable === "boolean"
    ? event.retryable
    : typeof diagnostic.retryable === "boolean" ? diagnostic.retryable : null;
  const projected = preflightFailureEvent({ ...identity, position, failureCode, retryable }, occurredAt);
  if (!projected) return { kind: "ignore" };
  return {
    kind: "failure",
    alertKey: `${event.action}\0${typeof event.jobId === "string" ? event.jobId : ""}\0${failureCode ?? "legacy"}`,
    event: projected,
  };
}

function activeProjection(
  job: Job,
  identity: TransportIdentity & { projectId: string },
  now: string,
): NonNullable<ProjectObservationProjection["active"]> {
  const actions = operatorActionsFor(job);
  const approval = actions.find((action) => action.kind === "approve_retry");
  const analysisEvent = job.analysis ? transportEvent({
    ...identity,
    occurredAt: job.analysis.createdAt,
    severity: actions.length > 0 ? "warning" : "info",
    category: "analyst.decision",
    dedupeKey: `analyst.decision:${job.analysis.id}`,
    title: "Analyst decision recorded",
    summary: "Harness recorded a bounded Analyst recommendation; it does not authorize workflow mutation.",
    facts: [{ label: "Recommendation", value: job.analysis.action }, { label: "Operator options", value: String(actions.length) }],
    actionRequired: actions.length > 0,
    operatorActionKinds: actions.map((action) => action.kind),
  }, now) : null;
  return {
    id: job.id,
    revision: job.revision,
    state: job.state,
    incidentId: job.incident?.id ?? null,
    analysisId: job.analysis?.id ?? null,
    automaticRecoveryCount: job.automaticRecoveries?.length ?? 0,
    startedEvent: transportEvent({
      ...identity,
      occurredAt: job.createdAt,
      severity: "info",
      category: "project.started",
      dedupeKey: `project.started:${job.id}`,
      title: "Project task started",
      summary: "Harness selected and durably recorded a new project task.",
      facts: [{ label: "Issue", value: String(job.task.issueNumber) }, { label: "State", value: job.state }],
    }, now),
    automaticRecoveryEvents: (job.automaticRecoveries ?? []).map((recovery) => automaticRecoveryEvent(job, recovery, identity, now)),
    incidentEvent: incidentEvent(job, identity, now),
    analysisEvent,
    approvalAnalysisId: job.state === "blocked" && job.analysis && job.incident
      && job.analysis.incidentId === job.incident.id && approval?.effect === job.analysis.action
      ? job.analysis.id
      : null,
  };
}

function incidentEvent(job: Job, identity: TransportIdentity & { projectId: string }, now: string): EventEnvelope | null {
  const incident = job.incident;
  if (!incident) return null;
  const exhausted = recoveryQuotaExhaustedEvent(job, identity, now);
  if (exhausted) return exhausted;
  const code = incident.runtimeDiagnostic?.code ?? incident.runtimeDiagnostic?.failureCode
    ?? (incident.class === "integrity_violation" || incident.class === "validation_infrastructure" ? incident.class : null);
  const classified = code ? preflightFailureEvent({
    ...identity,
    position: incident.id,
    failureCode: code,
    retryable: incident.runtimeDiagnostic?.retryable ?? false,
  }, incident.createdAt) : null;
  if (classified) return classified;
  const actions = operatorActionsFor(job);
  return transportEvent({
    ...identity,
    occurredAt: incident.createdAt,
    severity: "warning",
    category: "incident.new",
    dedupeKey: `incident.new:${incident.id}`,
    title: "New workflow incident",
    summary: "Harness recorded a new workflow incident; the workflow remains fail-closed.",
    facts: [{ label: "Class", value: incident.class }, { label: "Lane", value: incident.lane }],
    actionRequired: actions.length > 0,
    operatorActionKinds: actions.map((action) => action.kind),
  }, now);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
