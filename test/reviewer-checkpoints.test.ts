import test from "node:test";
import assert from "node:assert/strict";
import { assertReviewerCheckpoint, reviewerCheckpointIsCompatible } from "../src/reviewer-checkpoints.js";
import type { ReviewerCheckpoint, ReviewerCheckpointIdentity } from "../src/model.js";

const identity: ReviewerCheckpointIdentity = {
  jobId: "job-1",
  sourceAttemptId: "reviewer-1",
  jobRevision: 7,
  taskDigest: "1".repeat(64),
  baseSha: "a".repeat(40),
  reviewedHeadSha: "b".repeat(40),
  runtimeDigest: "2".repeat(64),
  providerDigest: "3".repeat(64),
  modelDigest: "4".repeat(64),
  resourceDigest: "5".repeat(64),
  repositoryContextBundleDigest: "6".repeat(64),
};

test("a Standards checkpoint accepts only its exact digest-bound identity", () => {
  const checkpoint = {
    version: 1,
    ...identity,
    stage: "standards-axis",
    createdAt: "2026-08-21T00:00:00.000Z",
    result: {
      status: "pass",
      summary: "Standards satisfied",
      findings: [],
      evidenceRefs: ["src/model.ts:1"],
      outputByteCount: 128,
      outputDigest: "b".repeat(64),
      truncated: false,
    },
    resultDigest: "f1f5fac7699901395a04b5ecf01f16ae82cfee2ff64e593e056878ff68226aba",
  };

  assertReviewerCheckpoint(checkpoint, identity, "standards-axis");
  assert.equal(checkpoint.stage, "standards-axis");
});

test("a validation receipt is a structured Reviewer checkpoint", () => {
  const emptyOutput = {
    text: "",
    truncated: false,
    redacted: false,
    byteCount: 0,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };
  const checkpoint = {
    version: 2,
    ...identity,
    stage: "validation",
    createdAt: "2026-08-21T00:00:01.000Z",
    result: {
      status: "passed",
      validationArgv: ["npm", "run", "verify"],
      validationArgvDigest: "2a7a83661dd7375015f66718c4920935b502412e6bf3820a9fb617752e3143ff",
      startedAt: "2026-08-21T00:00:00.000Z",
      completedAt: "2026-08-21T00:00:01.000Z",
      durationMs: 1_000,
      exitCode: 0,
      signal: null,
      timeout: false,
      error: null,
      stdout: emptyOutput,
      stderr: emptyOutput,
      dockerHost: null,
      relevantEnvironmentDigest: "7".repeat(64),
      sourceSnapshotDigest: "8".repeat(64),
    },
    resultDigest: "8a4960ff119395771fc81c617623f8d0c9a065d47131b7e994a9a33dddfeead4",
  };

  assertReviewerCheckpoint(checkpoint, identity, "validation");
  assert.equal(checkpoint.result.status, "passed");
});

test("Reviewer preflight records only its validation-bound structured result", () => {
  const checkpoint = {
    version: 1,
    ...identity,
    stage: "reviewer-preflight",
    createdAt: "2026-08-21T00:00:02.000Z",
    result: {
      status: "passed",
      validationReceiptDigest: "9".repeat(64),
      validationStatus: "passed",
    },
    resultDigest: "1a66765c8cec36393e105bd1834932520fd3c390b3e3cb6ff2ce992b1b4204ed",
  };

  assertReviewerCheckpoint(checkpoint, identity, "reviewer-preflight");
  assert.equal(Object.hasOwn(checkpoint.result, "validationReceipt"), false);
});

test("Reviewer final checkpoint remains a proposal until review_submit writes the result", () => {
  const checkpoint = {
    version: 1,
    ...identity,
    stage: "reviewer-final",
    createdAt: "2026-08-21T00:00:03.000Z",
    result: { status: "pass", summary: "Review passed", findings: [] },
    resultDigest: "081d4fe8e122ab30e04e613dc640567b9d6f12ee15262867a7056a0d1b5adc5d",
  };

  assertReviewerCheckpoint(checkpoint, identity, "reviewer-final");
  assert.equal(Object.hasOwn(checkpoint, "attemptId"), false);
});

test("fresh aggregation rejects a checkpoint from a different exact HEAD", () => {
  const checkpoint = standardsCheckpoint();
  const consumer = { ...identity, sourceAttemptId: "reviewer-2", jobRevision: 12, reviewedHeadSha: "c".repeat(40) };

  assert.equal(reviewerCheckpointIsCompatible(checkpoint, consumer), false);
});

test("fresh aggregation rejects a checkpoint after role resource drift", () => {
  const checkpoint = standardsCheckpoint();
  const consumer = { ...identity, sourceAttemptId: "reviewer-2", jobRevision: 12, resourceDigest: "a".repeat(64) };

  assert.equal(reviewerCheckpointIsCompatible(checkpoint, consumer), false);
});

function standardsCheckpoint(): ReviewerCheckpoint {
  return {
    version: 1,
    ...identity,
    stage: "standards-axis",
    createdAt: "2026-08-21T00:00:00.000Z",
    result: {
      status: "pass",
      summary: "Standards satisfied",
      findings: [],
      evidenceRefs: ["src/model.ts:1"],
      outputByteCount: 128,
      outputDigest: "b".repeat(64),
      truncated: false,
    },
    resultDigest: "f1f5fac7699901395a04b5ecf01f16ae82cfee2ff64e593e056878ff68226aba",
  };
}
