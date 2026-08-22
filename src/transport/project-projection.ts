import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { JsonStateStore } from "../adapters/json-store.js";
import { controllerHeartbeatPath } from "../controller-heartbeat.js";
import { observeProjectControllerLease } from "../fleet/lease.js";
import type { HarnessState, Job } from "../model.js";
import { projectOperatorState } from "../policy.js";
import type { HarnessConfig } from "../ports.js";
import {
  assertBoundedTransportEnvelope,
  boundedTransportText,
  remainingBucket,
  safeRuntimeId,
  transportBase,
  TRANSPORT_PROJECT_ID,
  TRANSPORT_ROUTE_ID,
  type ControllerProjection,
  type ProjectViewEnvelope,
} from "./telegram-protocol.js";

export type ProjectTransportConfig = {
  transportVersion: 2;
  routeId: string;
  projectId: string;
  fleetId?: string;
  harnessConfig: string;
};

export type ProjectHarnessConfig = Pick<HarnessConfig, "repo" | "stateDir" | "diagnostics">;

export async function projectViewFromConfig(
  configPath: string,
  options: { now?: string; heartbeatTimeoutMs?: number } = {},
): Promise<ProjectViewEnvelope> {
  const transport = loadProjectTransportConfig(configPath);
  const harness = loadProjectHarnessConfig(transport.harnessConfig, transport.projectId);
  const state = await new JsonStateStore(harness.stateDir).load();
  return projectView(state, harness, transport, options);
}

export function projectView(
  state: HarnessState,
  harness: ProjectHarnessConfig,
  identity: { routeId: string; projectId: string; fleetId?: string | null },
  options: { now?: string; heartbeatTimeoutMs?: number } = {},
): ProjectViewEnvelope {
  const now = options.now ?? new Date().toISOString();
  const job = state.activeJob;
  const attempt = job?.activeAttempt ?? null;
  const snapshot = attempt?.executionSnapshot;
  const operator = projectOperatorState(state);
  const diagnostic = job?.incident?.runtimeDiagnostic ?? null;
  const progress = job && attempt ? readRuntimeProgress(harness.stateDir, job, attempt) : emptyProgress();
  const reviewerFacts = job && attempt?.lane === "reviewer" ? readReviewerFacts(harness.stateDir, job) : emptyReviewerFacts();
  const validationStatus = attempt?.lane === "reviewer" ? attempt.reviewerValidationReceipt?.status ?? null : null;
  const classifiedFailure = diagnostic
    ? {
        taxonomyDomain: diagnostic.domain ?? null,
        failureDomain: diagnostic.failureDomain,
        failureCode: diagnostic.code ?? diagnostic.failureCode,
        failureDetailCode: diagnostic.failureCode,
        retryable: diagnostic.retryable,
        partial: false,
        corrupt: false,
        unknown: false,
      }
    : validationStatus === "failed-checks"
      ? knownFailure("deterministic", "validation", "validation_failed", false)
      : validationStatus === "infrastructure-error" || job?.incident?.class === "validation_infrastructure"
        ? knownFailure("acceptance", "validation", "validation_infrastructure", false)
        : emptyFailure(job);
  const failure = {
    ...classifiedFailure,
    partial: classifiedFailure.partial || progress.partial || reviewerFacts.partial,
    corrupt: classifiedFailure.corrupt || progress.corrupt || reviewerFacts.corrupt,
    unknown: classifiedFailure.unknown || progress.corrupt || reviewerFacts.corrupt,
  };
  const reused = attempt?.lane === "reviewer"
    ? [...new Set((attempt.reviewerCheckpointInputs ?? []).map((binding) => binding.stage))].sort()
    : [];
  const axes = ["standards-axis", "spec-axis"] as const;
  const latestRecovery = job?.automaticRecoveries?.at(-1) ?? null;
  const automaticCandidate = job?.incident?.automaticRecovery;
  const elapsed = attempt && Number.isFinite(Date.parse(attempt.startedAt))
    ? Math.max(0, Date.parse(now) - Date.parse(attempt.startedAt))
    : null;
  return assertBoundedTransportEnvelope({
    ...transportBase("project-view", {
      routeId: identity.routeId,
      projectId: identity.projectId,
      fleetId: identity.fleetId ?? null,
    }, now),
    project: {
      repo: boundedTransportText(harness.repo, 256),
      controller: controllerProjection(harness.stateDir, now, options.heartbeatTimeoutMs ?? 60_000),
    },
    workflow: {
      mode: operator.mode,
      state: job?.state ?? null,
      jobId: job ? boundedTransportText(job.id, 256) : null,
      issueNumber: job?.task.issueNumber ?? null,
      revision: job?.revision ?? null,
      reviewRound: job?.reviewRound ?? null,
      maxReviewRounds: job?.maxReviewRounds ?? null,
      lane: attempt?.lane ?? null,
      phase: attempt?.phase ?? null,
      attemptId: attempt ? boundedTransportText(attempt.id, 256) : null,
      headSha: safeSha(job?.headSha),
      pullRequest: job?.pullRequest ? {
        number: job.pullRequest.number,
        url: boundedTransportText(job.pullRequest.url, 512),
      } : null,
      incidentClass: job?.incident?.class ?? null,
      incidentLane: job?.incident?.lane ?? null,
    },
    runtime: {
      adapter: snapshot?.adapter ?? null,
      provider: safeRuntimeId("provider", snapshot?.provider),
      model: safeRuntimeId("model", snapshot?.model),
      runtimeVersion: snapshot ? boundedTransportText(snapshot.runtimeVersion, 64) : null,
      credentialMode: snapshot?.credentialMode ?? null,
      axisConcurrency: snapshot?.axisConcurrency ?? null,
      compactionMode: snapshot?.compactionMode ?? null,
      lastProgressType: progress.lastProgressType,
      lastProgressAt: progress.lastProgressAt,
      elapsedMs: progress.elapsedMs ?? elapsed,
      runtimeDeadlineAt: validTime(snapshot?.runtimeDeadlineAt),
      remainingBucket: remainingBucket(snapshot?.runtimeDeadlineAt, now),
      resultPresent: attempt ? progress.resultPresent ?? (attempt.result !== null) : null,
    },
    reviewer: {
      validationStatus,
      validationDurationMs: reviewerFacts.durationMs,
      validationOutputByteBuckets: reviewerFacts.byteBuckets,
      validationOutputDigests: reviewerFacts.digests,
      reusedCheckpointStages: reused,
      missingAxisStages: axes.filter((stage) => !reused.includes(stage)),
    },
    failure,
    recovery: {
      automaticRule: latestRecovery?.policyRule ?? automaticCandidate?.rule ?? null,
      action: latestRecovery?.action ?? null,
      notBefore: latestRecovery?.notBefore ?? (automaticCandidate?.rule === "provider_pre_side_effect_transient" ? automaticCandidate.notBefore : null),
      quotaConsumed: (job?.automaticRecoveries?.length ?? 0) > 0,
      humanActionRequired: job?.state === "blocked" && operator.actions.length > 0,
    },
    actions: operator.actions.map(({ id, kind, effect }) => ({ id, kind, effect })),
  });
}

export function loadProjectTransportConfig(path: string): ProjectTransportConfig {
  if (!isAbsolute(path)) throw new Error("transport config path must be absolute");
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectTransportConfig>;
  if (value.transportVersion !== 2 || !value.harnessConfig || !isAbsolute(value.harnessConfig)
    || !TRANSPORT_ROUTE_ID.test(value.routeId ?? "") || !TRANSPORT_PROJECT_ID.test(value.projectId ?? "")
    || (value.fleetId !== undefined && !TRANSPORT_PROJECT_ID.test(value.fleetId))) {
    throw new Error("project transport config is invalid");
  }
  return value as ProjectTransportConfig;
}

export function loadProjectHarnessConfig(path: string, projectId: string): ProjectHarnessConfig {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectHarnessConfig>;
  if (!value.repo?.trim() || !value.stateDir || !isAbsolute(value.stateDir)) throw new Error("Harness projection config is invalid");
  if (value.diagnostics?.projectId !== undefined && value.diagnostics.projectId !== projectId) {
    throw new Error("transport projectId differs from Harness diagnostics.projectId");
  }
  return value as ProjectHarnessConfig;
}

function controllerProjection(stateDir: string, now: string, timeoutMs: number): ControllerProjection {
  const lease = observeProjectControllerLease(stateDir);
  const heartbeat = readHeartbeat(controllerHeartbeatPath(stateDir), now, timeoutMs);
  const health = lease.status === "alive" && heartbeat.status === "fresh"
    ? "healthy"
    : lease.status === "malformed" || heartbeat.status === "malformed"
      ? "unknown"
      : lease.status === "stale" || heartbeat.status === "stale"
        ? "down"
        : "degraded";
  return {
    health,
    lease: lease.status,
    heartbeat: heartbeat.status,
    heartbeatAgeMs: heartbeat.ageMs,
    pidAlive: lease.status === "alive" ? true : lease.status === "stale" ? false : null,
  };
}

function readHeartbeat(path: string, now: string, timeoutMs: number): {
  status: ControllerProjection["heartbeat"];
  ageMs: number | null;
} {
  if (!existsSync(path)) return { status: "absent", ageMs: null };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; updatedAt?: unknown };
    if (value.version !== 1 || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
      return { status: "malformed", ageMs: null };
    }
    const ageMs = Math.max(0, Date.parse(now) - Date.parse(value.updatedAt));
    return { status: ageMs > timeoutMs ? "stale" : "fresh", ageMs };
  } catch {
    return { status: "malformed", ageMs: null };
  }
}

function knownFailure(
  taxonomyDomain: string,
  failureDomain: string,
  failureCode: string,
  retryable: boolean,
): ProjectViewEnvelope["failure"] {
  return { taxonomyDomain, failureDomain, failureCode, failureDetailCode: failureCode, retryable, partial: false, corrupt: false, unknown: false };
}

function emptyFailure(job: Job | null | undefined): ProjectViewEnvelope["failure"] {
  if (job?.incident) {
    return {
      taxonomyDomain: null,
      failureDomain: "harness_policy",
      failureCode: job.incident.class,
      failureDetailCode: job.incident.class,
      retryable: false,
      partial: false,
      corrupt: false,
      unknown: true,
    };
  }
  return { taxonomyDomain: null, failureDomain: null, failureCode: null, failureDetailCode: null, retryable: null, partial: false, corrupt: false, unknown: false };
}

function validTime(value: string | null | undefined): string | null {
  return value && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null;
}

function safeSha(value: string | null | undefined): string | null {
  return value && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

const PROGRESS_TYPES = new Set([
  "runner_started", "dispatch_accepted", "assistant_message_start", "assistant_message_update",
  "assistant_message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "compaction_start", "compaction_end", "provider_retry_progress", "durable_result", "agent_settled",
  "terminal_receipt", "herdr_output_update",
]);

function readRuntimeProgress(stateDir: string, job: Job, attempt: NonNullable<Job["activeAttempt"]>) {
  const expectedRoot = resolve(stateDir, `${attempt.lane}-attempts`, safeToken(job.id), safeToken(attempt.id));
  if (resolve(dirname(attempt.resultPath)) !== expectedRoot) return { ...emptyProgress(), partial: true, corrupt: true };
  const path = join(dirname(attempt.resultPath), "runtime", "runtime-progress.json");
  if (!existsSync(path)) return emptyProgress();
  try {
    if (!lstatSync(path).isFile() || statSync(path).size > 1024 * 1024) throw new Error("invalid progress file");
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (value.attemptId !== attempt.id || typeof value.lastProgressType !== "string" || !PROGRESS_TYPES.has(value.lastProgressType)
      || typeof value.lastProgressAt !== "string" || !Number.isFinite(Date.parse(value.lastProgressAt))
      || !Number.isSafeInteger(value.elapsedMs) || Number(value.elapsedMs) < 0
      || typeof value.resultPresent !== "boolean") throw new Error("invalid progress receipt");
    return {
      lastProgressType: value.lastProgressType,
      lastProgressAt: new Date(Date.parse(value.lastProgressAt)).toISOString(),
      elapsedMs: Number(value.elapsedMs),
      resultPresent: value.resultPresent,
      partial: false,
      corrupt: false,
    };
  } catch {
    return { ...emptyProgress(), partial: true, corrupt: true };
  }
}

function emptyProgress(): {
  lastProgressType: string | null;
  lastProgressAt: string | null;
  elapsedMs: number | null;
  resultPresent: boolean | null;
  partial: boolean;
  corrupt: boolean;
} {
  return { lastProgressType: null, lastProgressAt: null, elapsedMs: null, resultPresent: null, partial: false, corrupt: false };
}

function readReviewerFacts(stateDir: string, job: Job): ReturnType<typeof emptyReviewerFacts> {
  const attempt = job.activeAttempt!;
  const binding = attempt.reviewerValidationReceipt;
  if (!binding) return emptyReviewerFacts();
  try {
    if (!isAbsolute(binding.path) || !existsSync(binding.path) || !lstatSync(binding.path).isFile()
      || lstatSync(binding.path).isSymbolicLink() || statSync(binding.path).size > 1024 * 1024) throw new Error("invalid validation receipt file");
    const raw = readFileSync(binding.path, "utf8");
    if (sha256(raw) !== binding.digest) throw new Error("validation receipt digest drifted");
    const checkpoint = JSON.parse(raw) as Record<string, unknown>;
    const result = record(checkpoint.result);
    const stdout = record(result.stdout);
    const stderr = record(result.stderr);
    const sourceAttempt = checkpoint.sourceAttemptId === attempt.id
      ? attempt
      : job.attempts.find((candidate) => candidate.id === checkpoint.sourceAttemptId);
    if (!sourceAttempt || sourceAttempt.lane !== "reviewer" || checkpoint.version !== 2 || checkpoint.stage !== "validation"
      || resolve(binding.path) !== resolve(stateDir, "reviewer-attempts", safeToken(job.id), safeToken(sourceAttempt.id), "validation-receipt.json")
      || checkpoint.jobId !== job.id || checkpoint.taskDigest !== job.task.digest
      || checkpoint.baseSha !== sourceAttempt.baseSha || checkpoint.reviewedHeadSha !== sourceAttempt.expectedHeadSha
      || result.status !== binding.status || !Number.isSafeInteger(result.durationMs) || Number(result.durationMs) < 0
      || !validOutput(stdout) || !validOutput(stderr)) throw new Error("invalid validation receipt");
    return {
      durationMs: Number(result.durationMs),
      byteBuckets: { stdout: sizeBucket(Number(stdout.byteCount)), stderr: sizeBucket(Number(stderr.byteCount)) },
      digests: { stdout: String(stdout.sha256), stderr: String(stderr.sha256) },
      partial: false,
      corrupt: false,
    };
  } catch {
    return { ...emptyReviewerFacts(), partial: true, corrupt: true };
  }
}

function emptyReviewerFacts(): {
  durationMs: number | null;
  byteBuckets: { stdout: string | null; stderr: string | null };
  digests: { stdout: string | null; stderr: string | null };
  partial: boolean;
  corrupt: boolean;
} {
  return {
    durationMs: null,
    byteBuckets: { stdout: null, stderr: null },
    digests: { stdout: null, stderr: null },
    partial: false,
    corrupt: false,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validOutput(value: Record<string, unknown>): boolean {
  return Number.isSafeInteger(value.byteCount) && Number(value.byteCount) >= 0
    && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/i.test(value.sha256);
}

function sizeBucket(bytes: number): string {
  if (bytes < 64 * 1024) return "lt64k";
  if (bytes < 256 * 1024) return "64k_256k";
  if (bytes < 1024 * 1024) return "256k_1m";
  return "gte1m";
}

function sha256(value: string): string {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}

function safeToken(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "job";
}
