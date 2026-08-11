import test from "node:test";
import assert from "node:assert/strict";
import { JsonCommandAnalyst, parseAnalystTurn } from "../src/adapters/json-command-analyst.js";
import type { TaskSnapshot } from "../src/model.js";

const task: TaskSnapshot = {
  repo: "owner/repo",
  issueNumber: 1,
  mapNumber: null,
  title: "Task",
  objective: "Objective",
  labels: ["agent:claimed"],
  issueUpdatedAt: "2026-08-04T00:00:00.000Z",
  digest: "a".repeat(64),
};

test("JSON Analyst adapter rejects fabricated session identity", async () => {
  const analyst = new JsonCommandAnalyst("wrapper", [], {
    run: () => ({
      ok: true,
      code: 0,
      stdout: JSON.stringify({ sessionId: "not-a-codex-uuid", agentName: "codex", startedAt: "not-a-date" }),
      stderr: "",
      error: null,
    }),
  });

  await assert.rejects(() => analyst.start({ jobId: "job-1", task }), /invalid session identity/);
});

test("JSON Analyst adapter rejects noop close for a recorded session", async () => {
  const analyst = new JsonCommandAnalyst("wrapper", [], {
    run: () => ({
      ok: true,
      code: 0,
      stdout: JSON.stringify({ status: "noop" }),
      stderr: "",
      error: null,
    }),
  });

  await assert.rejects(() => analyst.close({
    jobId: "job-1",
    taskDigest: task.digest,
    session: {
      id: "019fc279-5388-7a62-b91f-1a8990102301",
      agentName: "codex-job-1",
      startedAt: "2026-08-04T00:00:00.000Z",
      taskDigest: task.digest,
    },
  }), /invalid close response/);
});

test("JSON Analyst protocol rejects unbounded advice", () => {
  assert.throws(
    () => parseAnalystTurn({
      kind: "advice",
      action: "retry_fresh_worker",
      summary: "bounded",
      resolutionBrief: "x".repeat(2_001),
      evidenceRefs: ["task"],
      unknowns: [],
    }),
    /Analyst advice is invalid/,
  );
});

test("JSON Analyst protocol accepts a bounded fresh Reviewer retry", () => {
  assert.deepEqual(
    parseAnalystTurn({
      kind: "advice",
      action: "retry_fresh_reviewer",
      summary: "Reviewer infrastructure failed before producing a result",
      resolutionBrief: "Retry review against the unchanged implementation HEAD.",
      evidenceRefs: ["incident", "git-status"],
      unknowns: [],
    }),
    {
      kind: "advice",
      action: "retry_fresh_reviewer",
      summary: "Reviewer infrastructure failed before producing a result",
      resolutionBrief: "Retry review against the unchanged implementation HEAD.",
      evidenceRefs: ["incident", "git-status"],
      unknowns: [],
    },
  );
});

test("JSON Analyst protocol accepts structured hypotheses and advanced evidence", () => {
  const evidence = parseAnalystTurn({
    kind: "need_evidence",
    requests: [
      { kind: "worktree_progress", path: null, reason: "Separate staged and unstaged work." },
      { kind: "attempt_runtime", path: null, reason: "Inspect bounded runtime receipts." },
      { kind: "controller_health", path: null, reason: "Reject a Controller crash hypothesis." },
    ],
  });
  assert.equal(evidence.kind, "need_evidence");

  const advice = parseAnalystTurn({
    kind: "advice",
    action: "retry_fresh_worker",
    summary: "Provider failed after useful work was produced.",
    resolutionBrief: "Preserve the dirty worktree and start one fresh Worker.",
    evidenceRefs: ["runtime-diagnostic", "worktree-progress"],
    unknowns: ["The exact upstream network failure is not persisted."],
    diagnosis: {
      primaryCause: "A retryable Provider network failure ended the Worker before durable submission.",
      confidence: "high",
      contributingFactors: ["The attempt had entered tool error recovery."],
      preservationConstraints: ["Keep staged and unstaged worktree changes."],
      hypotheses: [
        {
          claim: "The Controller crashed.",
          status: "rejected",
          confidence: "high",
          evidenceRefs: ["controller-health"],
        },
        {
          claim: "The Provider connection failed.",
          status: "supported",
          confidence: "high",
          evidenceRefs: ["runtime-diagnostic"],
        },
      ],
    },
  });
  if (advice.kind !== "advice") throw new Error("expected advice");
  assert.equal(advice.diagnosis?.hypotheses[0]?.status, "rejected");
});

test("JSON Analyst protocol rejects malformed evidence paths", () => {
  assert.throws(
    () => parseAnalystTurn({
      kind: "need_evidence",
      requests: [{ kind: "file_excerpt", path: 42, reason: "Inspect the file." }],
    }),
    /unsupported evidence operation/,
  );
});
