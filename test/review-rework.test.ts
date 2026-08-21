import test from "node:test";
import assert from "node:assert/strict";
import { HarnessController } from "../src/controller.js";
import { assertJobInvariant, digest } from "../src/model.js";
import type { HarnessConfig } from "../src/ports.js";
import {
  FakeAnalyst,
  FakeClock,
  FakeEvidence,
  FakeGit,
  FakeGitHub,
  FakeHerdr,
  FakeRuntimePreflight,
  MemoryStore,
  SequenceIds,
  issue,
  validReviewerArgv,
  validWorkerArgv,
} from "./fakes.js";

const config: HarnessConfig = {
  repo: "owner/repo",
  localPath: "/repo",
  stateDir: "/state",
  baseRef: "main",
  readyLabel: "ready-for-agent",
  claimLabel: "agent:claimed",
  worktreeRoot: "/worktrees",
  maxReviewRounds: 3,
  maxAnalystTurns: 3,
  reviewerValidationArgv: ["npm", "run", "verify"],
  workerArgv: validWorkerArgv,
  reviewerArgv: validReviewerArgv,
};

test("actionable review findings create a fresh worker and a fresh reviewer", async () => {
  const store = new MemoryStore();
  const herdr = new FakeHerdr([
    { lane: "worker", status: "completed", headSha: "b".repeat(40) },
    {
      lane: "reviewer",
      status: "changes",
      reviewedHeadSha: "b".repeat(40),
      summary: "one correctness issue",
      findings: [{ severity: "major", summary: "handle empty input", evidence: "src/core.ts:12" }],
    },
    { lane: "worker", status: "completed", headSha: "c".repeat(40) },
    { lane: "reviewer", status: "pass", reviewedHeadSha: "c".repeat(40) },
  ]);
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 41, title: "Review loop" })]),
    git: new FakeGit(),
    herdr,
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 14; index += 1) await controller.tick();
  const handoff = store.state.activeJob?.pendingHandoff;
  assert.equal(handoff?.kind, "review_changes");
  assert.equal(handoff?.source.attemptId, store.state.activeJob?.attempts.at(-1)?.id);
  assert.equal(handoff?.source.headSha, "b".repeat(40));
  assert.equal(handoff?.target.lane, "worker");
  assert.equal(handoff?.target.baseSha, "b".repeat(40));
  assert.deepEqual(handoff?.obligations, [{
    severity: "major",
    summary: "handle empty input",
    evidence: "src/core.ts:12",
  }]);
  const { id: ignored, ...body } = handoff!;
  const wrongBody = { ...body, target: { ...body.target, baseSha: "a".repeat(40) } };
  assert.throws(() => assertJobInvariant({
    ...store.state.activeJob!,
    pendingHandoff: { ...wrongBody, id: `handoff-${digest(wrongBody).slice(0, 32)}` },
  }), /pending handoff is not bound/);
  assert.throws(() => assertJobInvariant({ ...store.state.activeJob!, pendingBrief: "legacy free-form brief" }), /legacy pendingBrief/);

  await controller.tick();
  assert.equal(store.state.activeJob?.pendingHandoff, null);
  assert.deepEqual(store.state.activeJob?.activeAttempt?.contextEnvelope?.handoff?.value, handoff);

  for (let index = 0; index < 10; index += 1) await controller.tick();
  assert.equal(store.state.activeJob?.state, "publish_ready");
  assert.equal(herdr.prepared.filter((entry) => entry.lane === "worker").length, 2);
  assert.equal(herdr.prepared.filter((entry) => entry.lane === "reviewer").length, 2);
  const workerPrompts = herdr.prompts.filter((prompt) => prompt.text.includes("Pi implementation worker"));
  assert.equal(workerPrompts.length, 2);
  assert.match(workerPrompts[1]?.text ?? "", /Typed handoff: review_changes/);
  assert.match(workerPrompts[1]?.text ?? "", /handle empty input/);
  assert.match(workerPrompts[1]?.text ?? "", /src\/core\.ts:12/);
});
