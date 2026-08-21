import { Buffer } from "node:buffer";
import {
  digest,
  isBoundedText,
  type ReviewerAxisCheckpointResult,
  type Attempt,
  type Job,
  type ReviewerCheckpoint,
  type ReviewerCheckpointIdentity,
  type ReviewerCheckpointStage,
  type ReviewerValidationOutput,
  type ReviewerValidationStageResult,
} from "./model.js";

const IDENTITY_KEYS = [
  "baseSha",
  "jobId",
  "jobRevision",
  "modelDigest",
  "providerDigest",
  "repositoryContextBundleDigest",
  "resourceDigest",
  "reviewedHeadSha",
  "runtimeDigest",
  "sourceAttemptId",
  "taskDigest",
] as const;

export const REVIEWER_CHECKPOINT_FILES: Record<ReviewerCheckpointStage, string> = {
  "reviewer-preflight": "reviewer-preflight.json",
  "standards-axis": "standards-axis.json",
  "spec-axis": "spec-axis.json",
  validation: "validation-receipt.json",
  "reviewer-final": "reviewer-final.json",
};

export function assertReviewerCheckpoint(
  value: unknown,
  expectedIdentity: ReviewerCheckpointIdentity,
  expectedStage?: ReviewerCheckpointStage,
): asserts value is ReviewerCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reviewer checkpoint is not an object");
  const checkpoint = value as Record<string, unknown>;
  const keys = [...IDENTITY_KEYS, "createdAt", "result", "resultDigest", "stage", "version"].sort();
  if (Object.keys(checkpoint).sort().join(",") !== keys.join(",")) throw new Error("Reviewer checkpoint fields are invalid");
  for (const key of IDENTITY_KEYS) {
    if (checkpoint[key] !== expectedIdentity[key]) throw new Error(`Reviewer checkpoint ${key} drifted`);
  }
  if (expectedStage !== undefined && checkpoint.stage !== expectedStage) throw new Error("Reviewer checkpoint stage drifted");
  if (!Number.isFinite(Date.parse(String(checkpoint.createdAt)))) throw new Error("Reviewer checkpoint createdAt is invalid");
  if (!validDigest(checkpoint.resultDigest) || checkpoint.resultDigest !== digest(checkpoint.result)) {
    throw new Error("Reviewer checkpoint result digest drifted");
  }
  if ((checkpoint.stage === "standards-axis" || checkpoint.stage === "spec-axis") && checkpoint.version === 1) {
    if (!validAxisResult(checkpoint.result)) throw new Error("Reviewer axis checkpoint result is invalid");
    return;
  }
  if (checkpoint.stage === "validation" && checkpoint.version === 2) {
    if (!validValidationResult(checkpoint.result)) throw new Error("Reviewer validation checkpoint result is invalid");
    return;
  }
  if (checkpoint.stage === "reviewer-preflight" && checkpoint.version === 1) {
    if (!validPreflightResult(checkpoint.result)) throw new Error("Reviewer preflight checkpoint result is invalid");
    return;
  }
  if (checkpoint.stage === "reviewer-final" && checkpoint.version === 1) {
    if (!validFinalResult(checkpoint.result)) throw new Error("Reviewer final checkpoint result is invalid");
    return;
  }
  throw new Error("Reviewer checkpoint stage or version is invalid");
}

export function reviewerCheckpointIsCompatible(
  checkpoint: ReviewerCheckpoint,
  consumer: ReviewerCheckpointIdentity,
): boolean {
  return IDENTITY_KEYS.every((key) => (
    key === "sourceAttemptId" || key === "jobRevision" || checkpoint[key] === consumer[key]
  ));
}

export function reviewerCheckpointIdentity(
  job: Job,
  attempt: Attempt,
  sourceJobRevision = attempt.contextEnvelope?.identity.sourceJobRevision,
): ReviewerCheckpointIdentity {
  const snapshot = attempt.executionSnapshot;
  const context = snapshot?.context;
  if (
    attempt.lane !== "reviewer"
    || !attempt.expectedHeadSha
    || !snapshot
    || !context
    || !Number.isInteger(sourceJobRevision)
    || sourceJobRevision! < 0
    || (attempt.contextEnvelope !== undefined && (
      attempt.contextEnvelope.identity.jobId !== job.id
      || attempt.contextEnvelope.identity.attemptId !== attempt.id
      || attempt.contextEnvelope.identity.taskDigest !== job.task.digest
      || attempt.contextEnvelope.identity.sourceJobRevision !== sourceJobRevision
    ))
  ) throw new Error("Reviewer checkpoint identity lost its bound Attempt context");
  return {
    jobId: job.id,
    sourceAttemptId: attempt.id,
    jobRevision: sourceJobRevision!,
    taskDigest: job.task.digest,
    baseSha: attempt.baseSha,
    reviewedHeadSha: attempt.expectedHeadSha,
    runtimeDigest: digest({
      adapter: snapshot.adapter,
      executable: snapshot.executable,
      runtimeVersion: snapshot.runtimeVersion,
      thinking: snapshot.thinking,
      tools: snapshot.tools,
      sessionMode: snapshot.sessionMode,
      retryMode: snapshot.retryMode,
      compactionMode: snapshot.compactionMode,
      compactionPolicy: snapshot.compactionPolicy ?? null,
      credentialMode: snapshot.credentialMode,
      dockerHost: snapshot.dockerHost,
    }),
    providerDigest: digest(snapshot.provider),
    modelDigest: digest(snapshot.model),
    resourceDigest: digest(snapshot.resources),
    repositoryContextBundleDigest: context.bundleDigest,
  };
}

function validAxisResult(value: unknown): value is ReviewerAxisCheckpointResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join(",") !== "evidenceRefs,findings,outputByteCount,outputDigest,status,summary,truncated") return false;
  if ((result.status !== "pass" && result.status !== "changes")
    || !isBoundedText(result.summary, 2_048)
    || !validEvidenceRefs(result.evidenceRefs, 64)
    || !Number.isSafeInteger(result.outputByteCount) || (result.outputByteCount as number) < 0
    || !validDigest(result.outputDigest)
    || typeof result.truncated !== "boolean"
    || !Array.isArray(result.findings) || result.findings.length > 32) return false;
  for (const finding of result.findings) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return false;
    const entry = finding as Record<string, unknown>;
    if (Object.keys(entry).sort().join(",") !== "evidenceRefs,severity,summary"
      || (entry.severity !== "critical" && entry.severity !== "major" && entry.severity !== "minor")
      || !isBoundedText(entry.summary, 1_000)
      || !validEvidenceRefs(entry.evidenceRefs, 16, 1)) return false;
  }
  return result.status === "changes" ? result.findings.length > 0 : result.findings.length === 0;
}

function validEvidenceRefs(value: unknown, limit: number, minimum = 0): value is string[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= limit && value.every((entry) => (
    typeof entry === "string" && entry.trim().length > 0 && !/[\r\n\0]/.test(entry) && Buffer.byteLength(entry, "utf8") <= 512
  ));
}

function validValidationResult(value: unknown): value is ReviewerValidationStageResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join(",") !== [
    "completedAt",
    "dockerHost",
    "durationMs",
    "error",
    "exitCode",
    "relevantEnvironmentDigest",
    "signal",
    "sourceSnapshotDigest",
    "startedAt",
    "status",
    "stderr",
    "stdout",
    "timeout",
    "validationArgv",
    "validationArgvDigest",
  ].sort().join(",")) return false;
  if (!Array.isArray(result.validationArgv) || result.validationArgv.length < 1 || result.validationArgv.length > 32
    || result.validationArgv.some((argument) => typeof argument !== "string" || argument.length < 1 || argument.length > 8_192)
    || result.validationArgvDigest !== digest(result.validationArgv)
    || !Number.isFinite(Date.parse(String(result.startedAt)))
    || !Number.isFinite(Date.parse(String(result.completedAt)))
    || !Number.isSafeInteger(result.durationMs) || (result.durationMs as number) < 0
    || (result.exitCode !== null && (!Number.isInteger(result.exitCode) || (result.exitCode as number) < 0))
    || (result.signal !== null && !isBoundedText(result.signal, 64))
    || typeof result.timeout !== "boolean"
    || (result.error !== null && !isBoundedText(result.error, 4_000))
    || (result.dockerHost !== null && (typeof result.dockerHost !== "string" || !result.dockerHost.startsWith("unix:///") || /[\0\r\n]/.test(result.dockerHost)))
    || !validDigest(result.relevantEnvironmentDigest)
    || !validDigest(result.sourceSnapshotDigest)
    || !validValidationOutput(result.stdout)
    || !validValidationOutput(result.stderr)
    || (result.status !== "passed" && result.status !== "failed-checks" && result.status !== "infrastructure-error")) return false;
  const deterministic = result.signal === null && result.timeout === false && result.error === null;
  return (result.status === "passed" && deterministic && result.exitCode === 0)
    || (result.status === "failed-checks" && deterministic && result.exitCode !== null && result.exitCode !== 0)
    || (result.status === "infrastructure-error" && !deterministic);
}

function validPreflightResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return Object.keys(result).sort().join(",") === "status,validationReceiptDigest,validationStatus"
    && result.status === "passed"
    && validDigest(result.validationReceiptDigest)
    && (result.validationStatus === "passed" || result.validationStatus === "failed-checks");
}

function validFinalResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join(",") !== "findings,status,summary"
    || !["pass", "changes", "blocked", "failed"].includes(String(result.status))
    || !isBoundedText(result.summary, 4_000)
    || !Array.isArray(result.findings) || result.findings.length > 64) return false;
  for (const finding of result.findings) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return false;
    const entry = finding as Record<string, unknown>;
    if (Object.keys(entry).sort().join(",") !== "evidence,severity,summary"
      || !["critical", "major", "minor"].includes(String(entry.severity))
      || !isBoundedText(entry.summary, 1_000)
      || !isBoundedText(entry.evidence, 4_000)) return false;
  }
  return result.status === "pass" ? result.findings.length === 0 : result.status !== "changes" || result.findings.length > 0;
}

function validValidationOutput(value: unknown): value is ReviewerValidationOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  if (Object.keys(output).sort().join(",") !== "byteCount,redacted,sha256,text,truncated") return false;
  return typeof output.text === "string"
    && typeof output.truncated === "boolean"
    && typeof output.redacted === "boolean"
    && Number.isSafeInteger(output.byteCount)
    && (output.byteCount as number) >= 0
    && validDigest(output.sha256)
    && (output.byteCount === 0
      ? output.text === "" && output.truncated === false && output.redacted === false
      : output.text === "[redacted validation output]" && output.truncated === true && output.redacted === true);
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}
