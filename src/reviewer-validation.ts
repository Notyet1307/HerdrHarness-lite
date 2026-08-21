import {
  digest,
  type LegacyReviewerValidationReceipt,
  type ReviewerValidationOutput,
  type ReviewerValidationReceipt,
  type ReviewerValidationStageResult,
} from "./model.js";
import { assertReviewerCheckpoint } from "./reviewer-checkpoints.js";

export const REVIEWER_VALIDATION_OUTPUT_REDACTED = "[redacted validation output]";
export const REVIEWER_VALIDATION_TIMEOUT_MS = 30 * 60 * 1000;

export class ReviewerValidationIntegrityError extends Error {}
export class ReviewerValidationInfrastructureError extends Error {}

export type ReviewerValidationIdentity = {
  jobId: string;
  attemptId: string;
  taskDigest: string;
  baseSha: string;
  reviewedHeadSha: string;
  validationArgv: string[];
  dockerHost: string | null;
  resourceDigest: string;
  checkpointIdentity: import("./model.js").ReviewerCheckpointIdentity;
};

export function assertReviewerValidationReceipt(
  value: unknown,
  expected: ReviewerValidationIdentity,
): asserts value is ReviewerValidationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewerValidationIntegrityError("Reviewer validation receipt is not an object");
  }
  const receipt = value as ReviewerValidationReceipt;
  if (isReviewerValidationCheckpoint(receipt)) {
    assertReviewerCheckpoint(receipt, expected.checkpointIdentity, "validation");
    if (
      receipt.jobId !== expected.jobId
      || receipt.sourceAttemptId !== expected.attemptId
      || receipt.taskDigest !== expected.taskDigest
      || receipt.baseSha !== expected.baseSha
      || receipt.reviewedHeadSha !== expected.reviewedHeadSha
      || receipt.resourceDigest !== expected.resourceDigest
      || JSON.stringify(receipt.result.validationArgv) !== JSON.stringify(expected.validationArgv)
      || receipt.result.validationArgvDigest !== digest(expected.validationArgv)
      || receipt.result.dockerHost !== expected.dockerHost
    ) throw new ReviewerValidationIntegrityError("Reviewer validation receipt binding is invalid or drifted");
    return;
  }
  if (
    receipt.version !== 1
    || !["passed", "failed-checks", "infrastructure-error"].includes(receipt.status)
    || receipt.jobId !== expected.jobId
    || receipt.attemptId !== expected.attemptId
    || receipt.taskDigest !== expected.taskDigest
    || receipt.baseSha !== expected.baseSha
    || receipt.reviewedHeadSha !== expected.reviewedHeadSha
    || JSON.stringify(receipt.validationArgv) !== JSON.stringify(expected.validationArgv)
    || receipt.validationArgvDigest !== digest(expected.validationArgv)
    || receipt.dockerHost !== expected.dockerHost
    || receipt.resourceDigest !== expected.resourceDigest
    || !validTimestamp(receipt.startedAt)
    || !validTimestamp(receipt.completedAt)
    || !Number.isSafeInteger(receipt.durationMs) || receipt.durationMs < 0
    || (receipt.exitCode !== null && (!Number.isInteger(receipt.exitCode) || receipt.exitCode < 0))
    || (receipt.signal !== null && (typeof receipt.signal !== "string" || !receipt.signal.trim() || receipt.signal.length > 64))
    || typeof receipt.timeout !== "boolean"
    || (receipt.error !== null && (typeof receipt.error !== "string" || !receipt.error.trim() || receipt.error.length > 4_000))
    || !validDigest(receipt.relevantEnvironmentDigest)
    || !validDigest(receipt.resourceDigest)
    || !validDigest(receipt.sourceSnapshotDigest)
    || !validOutput(receipt.stdout)
    || !validOutput(receipt.stderr)
  ) throw new ReviewerValidationIntegrityError("Reviewer validation receipt binding is invalid or drifted");

  const deterministic = receipt.signal === null && receipt.timeout === false && receipt.error === null;
  if (
    (receipt.status === "passed" && (!deterministic || receipt.exitCode !== 0))
    || (receipt.status === "failed-checks" && (!deterministic || receipt.exitCode === null || receipt.exitCode === 0))
    || (receipt.status === "infrastructure-error" && deterministic)
  ) throw new ReviewerValidationIntegrityError("Reviewer validation receipt status contradicts its process outcome");
}

export function reviewerValidationResult(receipt: ReviewerValidationReceipt): ReviewerValidationStageResult {
  if (isReviewerValidationCheckpoint(receipt)) return receipt.result;
  return {
    status: receipt.status,
    validationArgv: [...receipt.validationArgv],
    validationArgvDigest: receipt.validationArgvDigest,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    durationMs: receipt.durationMs,
    exitCode: receipt.exitCode,
    signal: receipt.signal,
    timeout: receipt.timeout,
    error: receipt.error,
    stdout: receipt.stdout,
    stderr: receipt.stderr,
    dockerHost: receipt.dockerHost,
    relevantEnvironmentDigest: receipt.relevantEnvironmentDigest,
    sourceSnapshotDigest: receipt.sourceSnapshotDigest,
  };
}

export function isReviewerValidationCheckpoint(
  receipt: ReviewerValidationReceipt,
): receipt is Exclude<ReviewerValidationReceipt, LegacyReviewerValidationReceipt> {
  return "stage" in receipt && receipt.stage === "validation";
}

function validOutput(value: ReviewerValidationOutput): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return typeof value.text === "string"
    && typeof value.truncated === "boolean"
    && typeof value.redacted === "boolean"
    && Number.isSafeInteger(value.byteCount)
    && value.byteCount >= 0
    && validDigest(value.sha256)
    && (value.byteCount === 0
      ? value.text === "" && !value.truncated && !value.redacted
      : value.text === REVIEWER_VALIDATION_OUTPUT_REDACTED && value.truncated && value.redacted);
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
