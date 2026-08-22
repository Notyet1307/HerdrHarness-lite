import { digest, type AutomaticRecovery, type Job } from "../model.js";
import { operatorActionsFor } from "../policy.js";
import {
  assertBoundedTransportEnvelope,
  boundedTransportText,
  safeRuntimeId,
  transportBase,
  type EventEnvelope,
  type TransportIdentity,
} from "./telegram-protocol.js";

type EventInput = TransportIdentity & {
  occurredAt: string;
  severity: EventEnvelope["severity"];
  category: EventEnvelope["category"];
  dedupeKey: string;
  title: string;
  summary: string;
  facts?: EventEnvelope["facts"];
  actionRequired?: boolean;
  operatorActionKinds?: EventEnvelope["operatorActionKinds"];
  approval?: EventEnvelope["approval"];
};

export function transportEvent(input: EventInput, generatedAt = input.occurredAt): EventEnvelope {
  const occurredAt = validTime(input.occurredAt, "event occurredAt");
  const title = boundedTransportText(input.title, 160);
  const summary = boundedTransportText(input.summary, 1_000);
  const dedupeKey = boundedTransportText(input.dedupeKey, 512);
  if (!title || !summary || !dedupeKey) throw new Error("transport event text is empty");
  const facts = (input.facts ?? []).slice(0, 16).map((fact) => ({
    label: boundedTransportText(fact.label, 80),
    value: boundedTransportText(fact.value, 512),
  }));
  if (facts.some((fact) => !fact.label || !fact.value)) throw new Error("transport event fact is empty");
  const approval = input.approval;
  if (approval && (!/^[0-9A-F]{16}$/.test(approval.token)
    || !boundedTransportText(approval.approveLabel, 64)
    || !Number.isFinite(Date.parse(approval.expiresAt)))) throw new Error("transport event approval is invalid");
  const eventIdentity = {
    category: input.category,
    dedupeKey,
    occurredAt,
    routeId: input.routeId,
    projectId: input.projectId,
  };
  return assertBoundedTransportEnvelope({
    ...transportBase("event", input, generatedAt),
    eventId: `event-${digest(eventIdentity).slice(0, 32)}`,
    dedupeKey,
    occurredAt,
    severity: input.severity,
    category: input.category,
    title,
    summary,
    facts,
    actionRequired: input.actionRequired ?? false,
    operatorActionKinds: [...new Set(input.operatorActionKinds ?? [])],
    ...(approval ? {
      approval: {
        token: approval.token,
        approveLabel: boundedTransportText(approval.approveLabel, 64),
        expiresAt: new Date(Date.parse(approval.expiresAt)).toISOString(),
      },
    } : {}),
  });
}

export function automaticRecoveryEvent(
  job: Job,
  recovery: AutomaticRecovery,
  identity: TransportIdentity & { projectId: string },
  generatedAt = recovery.createdAt,
): EventEnvelope {
  const facts: EventEnvelope["facts"] = [];
  if (recovery.policyRule === "provider_pre_side_effect_transient") {
    facts.push(
      { label: "Lane", value: recovery.lane ?? (recovery.action === "retry_fresh_worker" ? "worker" : "reviewer") },
      { label: "Provider", value: safeRuntimeId("provider", recovery.provider) ?? "unknown" },
      { label: "Failure", value: recovery.failureCode ?? "unknown" },
      { label: "Not before", value: recovery.notBefore ?? "unknown" },
      { label: "Attempt", value: "fresh" },
      { label: "Boundary", value: "pre-side-effect verified" },
      { label: "Quota", value: "consumed for job/lane/HEAD" },
    );
  } else if (recovery.policyRule === "reviewer_same_head_infrastructure") {
    const checkpoints = [...new Set((job.activeAttempt?.reviewerCheckpointInputs ?? []).map((binding) => binding.stage))].sort();
    facts.push(
      { label: "Lane", value: "reviewer" },
      { label: "HEAD", value: "unchanged exact HEAD" },
      { label: "Attempt", value: "fresh Reviewer" },
      { label: "Checkpoint reuse", value: checkpoints.join(", ") || "none" },
      { label: "Quota", value: "consumed for this failure fingerprint" },
    );
  } else {
    facts.push(
      { label: "Lane", value: "worker" },
      { label: "Dispatch", value: "old Attempt not dispatched" },
      { label: "Side effects", value: "no tool or Git side effects" },
      { label: "Attempt", value: "fresh Worker" },
      { label: "Quota", value: "consumed for this failure fingerprint" },
    );
  }
  return transportEvent({
    ...identity,
    occurredAt: recovery.createdAt,
    severity: "warning",
    category: "recovery.automatic",
    dedupeKey: `recovery.automatic:${recovery.id}`,
    title: "Automatic fresh recovery authorized",
    summary: recovery.policyRule === "provider_pre_side_effect_transient"
      ? "Core authorized one fresh Attempt after a verified pre-side-effect transient Provider failure."
      : recovery.policyRule === "reviewer_same_head_infrastructure"
        ? "Core authorized a fresh Reviewer against the unchanged exact HEAD."
        : "Core authorized a fresh Worker after the old Attempt failed before prompt dispatch.",
    facts,
  }, generatedAt);
}

export function preflightFailureEvent(
  input: TransportIdentity & {
    position: string;
    failureCode: string | null;
    retryable: boolean | null;
  },
  occurredAt: string,
): EventEnvelope | null {
  if (input.failureCode === "validation_failed") return null;
  const classification = preflightClassification(input.failureCode, input.retryable);
  return transportEvent({
    routeId: input.routeId,
    projectId: input.projectId,
    fleetId: input.fleetId,
    occurredAt,
    severity: classification.severity,
    category: classification.category,
    dedupeKey: `${classification.category}:${input.projectId ?? "fleet"}:${boundedTransportText(input.position, 160)}:${input.failureCode ?? "legacy"}`,
    title: classification.title,
    summary: classification.summary,
    facts: [
      { label: "Failure", value: input.failureCode ?? "unclassified preflight" },
      { label: "Retryable", value: input.retryable === null ? "unknown" : input.retryable ? "yes" : "no" },
    ],
    actionRequired: classification.actionRequired,
  }, occurredAt);
}

export function recoveryQuotaExhaustedEvent(
  job: Job,
  identity: TransportIdentity & { projectId: string },
  generatedAt: string,
): EventEnvelope | null {
  const candidate = job.incident?.automaticRecovery;
  if (!candidate) return null;
  const repeated = (job.automaticRecoveries ?? []).some((entry) => (
    candidate.rule === "provider_pre_side_effect_transient"
      ? entry.scopeFingerprint === candidate.scopeFingerprint
      : entry.fingerprint === candidate.fingerprint
  ));
  if (!repeated) return null;
  return transportEvent({
    ...identity,
    occurredAt: job.incident!.createdAt,
    severity: "critical",
    category: "recovery.exhausted",
    dedupeKey: `recovery.exhausted:${job.incident!.id}:${candidate.fingerprint}`,
    title: "Automatic recovery quota exhausted",
    summary: "The same bounded automatic recovery scope already consumed its quota; workflow remains blocked for a current Core-owned decision.",
    facts: [
      { label: "Rule", value: candidate.rule },
      { label: "Lane", value: job.incident!.lane },
      { label: "Quota", value: "exhausted or repeated failure" },
    ],
    actionRequired: true,
    operatorActionKinds: operatorKinds(job),
  }, generatedAt);
}

function preflightClassification(code: string | null, retryable: boolean | null): {
  severity: EventEnvelope["severity"];
  category: EventEnvelope["category"];
  title: string;
  summary: string;
  actionRequired: boolean;
} {
  if (code === "credential_lock_timeout") return warning("Credential startup delayed", "Credential startup lock timed out; Controller policy will reevaluate the preflight on the next cycle.");
  if (code === "credential_lock_stale") return critical("Credential startup lease needs inspection", "The credential startup lease is stale or malformed; a credential operator must inspect its owner before recovery.");
  if (code === "oauth_refresh_timeout") return warning("OAuth refresh timed out", "OAuth refresh timed out; Controller policy will reevaluate the preflight on the next cycle.");
  if (code === "oauth_missing") return critical("Canonical OAuth is missing", "Canonical OAuth is missing; an operator must login or repair the credential before work can continue.");
  if (code === "oauth_probe_failed") return retryable
    ? warning("OAuth probe failed", "The OAuth probe failed transiently; Controller policy will reevaluate the preflight on the next cycle.")
    : critical("OAuth probe needs inspection", "The OAuth probe failed and is not retryable; a credential operator must inspect the configured account.");
  if (code === "runtime_stall") return {
    severity: "warning", category: "runtime.stall", title: "Runtime made no progress",
    summary: "The bounded no-progress deadline was reached; recovery requires a fresh Attempt through the current Core gate.", actionRequired: true,
  };
  if (code === "attempt_deadline") return {
    severity: "warning", category: "runtime.deadline", title: "Attempt deadline reached",
    summary: "The total runtime deadline was reached; recovery requires a fresh Attempt through the current Core gate.", actionRequired: true,
  };
  if (code === "validation_infrastructure") return critical("Reviewer validation infrastructure failed", "Reviewer validation infrastructure failed; this is not candidate-code failed checks.");
  if (code === "integrity_violation") return critical("Integrity gate failed", "An integrity gate failed; no automatic retry is authorized and an operator must inspect the bound facts.");
  if (code === "version_drift" || code === "resource_drift" || code === "config_drift") {
    return critical("Runtime configuration drift detected", "Version, resource, or configuration drift requires operator repair before a new Attempt can start.");
  }
  if (code !== null) return retryable
    ? warning("Controller preflight did not pass", "Controller preflight did not pass; Controller policy will reevaluate it on the next cycle.")
    : critical("Controller preflight needs inspection", "Controller preflight did not pass and is not retryable; an operator must inspect the configured runtime.");
  return warning("Controller preflight did not pass", "Controller preflight did not pass; it will be reevaluated on the next Controller cycle.");
}

function warning(title: string, summary: string) {
  return { severity: "warning" as const, category: "preflight.failed" as const, title, summary, actionRequired: false };
}

function critical(title: string, summary: string) {
  return { severity: "critical" as const, category: "preflight.failed" as const, title, summary, actionRequired: true };
}

function operatorKinds(job: Job): EventEnvelope["operatorActionKinds"] {
  return operatorActionsFor(job).map((action) => action.kind);
}

function validTime(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  return new Date(Date.parse(value)).toISOString();
}
