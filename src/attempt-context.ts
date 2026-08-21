import { dirname, resolve } from "node:path";
import { digest, type Attempt, type AttemptContextEnvelope, type ExecutionSnapshot, type Job, type TypedHandoff } from "./model.js";

export function buildAttemptContextEnvelope(input: {
  job: Job;
  attempt: Attempt;
  executionSnapshot: ExecutionSnapshot;
  handoff: TypedHandoff | null;
}): AttemptContextEnvelope {
  const context = input.executionSnapshot.context;
  if (!context) throw new Error("Attempt context envelope requires trusted repository context");
  const handoff = input.handoff
    ? {
        trust: "untrusted-task-data" as const,
        digest: digest(input.handoff),
        value: {
          ...input.handoff,
          source: { ...input.handoff.source },
          target: { ...input.handoff.target },
          obligations: input.handoff.obligations.map((item) => ({ ...item })),
          evidenceRefs: [...input.handoff.evidenceRefs],
          unknowns: [...input.handoff.unknowns],
        },
      }
    : null;
  return {
    version: 1,
    identity: {
      jobId: input.job.id,
      sourceJobRevision: input.job.revision,
      attemptId: input.attempt.id,
      lane: input.attempt.lane,
      round: input.attempt.round,
      taskDigest: input.job.task.digest,
      preparedAt: input.attempt.startedAt,
    },
    authority: {
      roleResources: input.executionSnapshot.resources.flatMap((resource) => (
        resource.kind === "skill" || resource.kind === "extension" || resource.kind === "agent"
          ? [{ kind: resource.kind, digest: resource.digest }]
          : []
      )),
      repositoryPolicy: {
        trustAnchorSha: context.trustAnchorSha,
        entries: context.entries.map((entry) => ({ ...entry })),
        bundleDigest: context.bundleDigest,
        manifestDigest: context.manifestDigest,
      },
    },
    task: { ...input.job.task, labels: [...input.job.task.labels], trust: "untrusted-task-data" },
    target: {
      branch: input.job.branch,
      baseSha: input.attempt.baseSha,
      expectedHeadSha: input.attempt.expectedHeadSha,
      expectedRemoteHeadSha: input.attempt.expectedRemoteHeadSha ?? null,
    },
    handoff,
    evidence: {
      trust: "untrusted-evidence",
      refs: [...(input.handoff?.evidenceRefs ?? [])],
      reviewEvidencePath: input.attempt.lane === "reviewer"
        ? resolve(dirname(input.attempt.resultPath), "workspace", "review-evidence.txt")
        : null,
      validationArgv: input.attempt.reviewerValidationArgv ? [...input.attempt.reviewerValidationArgv] : null,
      validationReceiptPath: input.attempt.lane === "reviewer"
        ? input.attempt.reviewerValidationReceipt?.path ?? resolve(dirname(input.attempt.resultPath), "validation-receipt.json")
        : null,
      ...(input.attempt.lane === "reviewer"
        ? { reviewerCheckpointInputs: (input.attempt.reviewerCheckpointInputs ?? []).map((binding) => ({ ...binding })) }
        : {}),
    },
    runtime: {
      snapshotDigest: digest(input.executionSnapshot),
      adapter: input.executionSnapshot.adapter,
      runtimeVersion: input.executionSnapshot.runtimeVersion,
      provider: input.executionSnapshot.provider,
      model: input.executionSnapshot.model,
      thinking: input.executionSnapshot.thinking,
      tools: [...input.executionSnapshot.tools],
      sessionMode: input.executionSnapshot.sessionMode,
      retryMode: input.executionSnapshot.retryMode,
      compactionMode: input.executionSnapshot.compactionMode,
      ...(input.executionSnapshot.compactionPolicy
        ? { compactionPolicy: { ...input.executionSnapshot.compactionPolicy } }
        : {}),
      credentialMode: input.executionSnapshot.credentialMode,
      ...(input.executionSnapshot.credentialDomainId
        ? { credentialDomainId: input.executionSnapshot.credentialDomainId }
        : {}),
      ...(input.executionSnapshot.axisConcurrency
        ? { axisConcurrency: input.executionSnapshot.axisConcurrency }
        : {}),
      ...(input.executionSnapshot.runtimeTimeouts
        ? { runtimeTimeouts: { ...input.executionSnapshot.runtimeTimeouts } }
        : {}),
      ...(input.executionSnapshot.runtimeDeadlineAt !== undefined
        ? { runtimeDeadlineAt: input.executionSnapshot.runtimeDeadlineAt }
        : {}),
      ...(input.executionSnapshot.validationTimeoutMs !== undefined
        ? { validationTimeoutMs: input.executionSnapshot.validationTimeoutMs }
        : {}),
    },
    writeback: input.attempt.lane === "worker"
      ? { tool: "worker_submit", statuses: ["completed", "blocked", "failed"] }
      : { tool: "review_submit", statuses: ["pass", "changes", "blocked", "failed"] },
  };
}
