import type {
  Attempt,
  AttemptResult,
  BlockClass,
  EvidencePack,
  Incident,
  RecoveryAction,
} from "./model.js";
import { digest } from "./model.js";
import type { Clock, IdGenerator } from "./ports.js";

export function allowedActionsFor(blockClass: BlockClass, lane: Incident["lane"]): RecoveryAction[] {
  switch (blockClass) {
    case "agent_decision":
    case "agent_blocked":
    case "review_uncertain":
    case "ci_failure":
      return ["retry_fresh_worker", "hold"];
    case "reviewer_preflight_dirty":
      return lane === "reviewer" ? ["retry_fresh_reviewer", "hold"] : ["hold"];
    case "infrastructure_exhausted":
      return lane === "reviewer" ? ["retry_fresh_reviewer", "hold"] : ["retry_fresh_worker", "hold"];
    case "integrity_violation":
    case "stale_task":
    case "ci_rework_exhausted":
    case "analyst_unavailable":
      return ["hold"];
  }
}

export function makeIncident(input: {
  jobId: string;
  jobRevision: number;
  lane: Incident["lane"];
  attemptId: string | null;
  blockClass: BlockClass;
  summary: string;
  clock: Clock;
  ids: IdGenerator;
}): Incident {
  const createdAt = input.clock.now();
  const core = {
    jobId: input.jobId,
    jobRevision: input.jobRevision,
    lane: input.lane,
    attemptId: input.attemptId,
    blockClass: input.blockClass,
    summary: input.summary,
    createdAt,
  };
  return {
    id: input.ids.next("incident"),
    class: input.blockClass,
    lane: input.lane,
    attemptId: input.attemptId,
    summary: input.summary,
    evidenceDigest: digest(core),
    allowedActions: allowedActionsFor(input.blockClass, input.lane),
    createdAt,
  };
}

export function validateAttemptResult(
  jobId: string,
  attempt: Attempt,
  result: AttemptResult | null,
): { ok: true; result: AttemptResult } | { ok: false; reason: string } {
  if (!result) return { ok: false, reason: "agent settled without a durable result" };
  if (result.version !== 1) return { ok: false, reason: "unsupported attempt result version" };
  if (result.jobId.trim() === "" || result.attemptId.trim() === "") {
    return { ok: false, reason: "attempt result identity is empty" };
  }
  if (result.jobId !== jobId) {
    return { ok: false, reason: `job id mismatch: expected ${jobId}, got ${result.jobId}` };
  }
  if (result.attemptId !== attempt.id) {
    return { ok: false, reason: `attempt id mismatch: expected ${attempt.id}, got ${result.attemptId}` };
  }
  if (result.lane !== attempt.lane) {
    return { ok: false, reason: `attempt lane mismatch: expected ${attempt.lane}, got ${result.lane}` };
  }
  if (result.lane === "worker" && result.status === "completed" && !result.headSha) {
    return { ok: false, reason: "completed worker result is missing headSha" };
  }
  if (result.lane === "reviewer" && (result.status === "pass" || result.status === "changes") && !result.reviewedHeadSha) {
    return { ok: false, reason: "reviewer result is missing reviewedHeadSha" };
  }
  return { ok: true, result };
}

export function buildEvidencePack(input: {
  incident: Incident;
  jobId: string;
  jobRevision: number;
  taskDigest: string;
  items: EvidencePack["items"];
  missing: string[];
}): EvidencePack {
  const root = {
    incidentId: input.incident.id,
    jobId: input.jobId,
    jobRevision: input.jobRevision,
    taskDigest: input.taskDigest,
    items: input.items.map((item) => ({ ref: item.ref, digest: item.digest })),
    missing: input.missing,
  };
  return {
    incidentId: input.incident.id,
    jobId: input.jobId,
    jobRevision: input.jobRevision,
    taskDigest: input.taskDigest,
    digest: digest(root),
    items: input.items,
    missing: input.missing,
  };
}
