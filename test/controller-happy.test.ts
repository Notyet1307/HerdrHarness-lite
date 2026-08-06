import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { HarnessController } from "../src/controller.js";
import type { HarnessConfig } from "../src/ports.js";
import {
  FakeAnalyst,
  FakeClock,
  FakeEvidence,
  FakeGit,
  FakeGitHub,
  FakeHerdr,
  MemoryStore,
  SequenceIds,
  issue,
  substituteCodeReviewSkillPath,
  untrustedImplementSkillPath,
  validCodeReviewSkillPath,
  validImplementSkillPath,
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

test("config rejects non-string native Pi arguments", () => {
  for (const field of ["workerArgv", "reviewerArgv"] as const) {
    const invalidConfig = { ...config, [field]: [42] } as unknown as HarnessConfig;
    assert.throws(() => new HarnessController({
      config: invalidConfig,
      store: new MemoryStore(),
      github: new FakeGitHub([]),
      git: new FakeGit(),
      herdr: new FakeHerdr([]),
      analyst: new FakeAnalyst(),
      evidence: new FakeEvidence(),
      clock: new FakeClock(),
      ids: new SequenceIds(),
    }), new RegExp(`${field} must be an array of strings`));
  }
});

test("config allows Worker high, xhigh, or max and requires Reviewer max thinking", () => {
  new HarnessController({
    config,
    store: new MemoryStore(),
    github: new FakeGitHub([]),
    git: new FakeGit(),
    herdr: new FakeHerdr([]),
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
  });
  new HarnessController({
    config: { ...config, workerArgv: validWorkerArgv.map((value) => value === "high" ? "max" : value) },
    store: new MemoryStore(),
    github: new FakeGitHub([]),
    git: new FakeGit(),
    herdr: new FakeHerdr([]),
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
  });
  new HarnessController({
    config: { ...config, workerArgv: validWorkerArgv.map((value) => value === "high" ? "xhigh" : value) },
    store: new MemoryStore(),
    github: new FakeGitHub([]),
    git: new FakeGit(),
    herdr: new FakeHerdr([]),
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
  });
  assert.throws(() => new HarnessController({
    config: { ...config, reviewerArgv: validReviewerArgv.map((value) => value === "max" ? "high" : value) },
    store: new MemoryStore(),
    github: new FakeGitHub([]),
    git: new FakeGit(),
    herdr: new FakeHerdr([]),
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
  }), /reviewerArgv must enforce the Pi role contract: --thinking max is required/);
});

test("config rejects incomplete Pi role contracts", () => {
  for (const invalidConfig of [
    { ...config, workerArgv: [] },
    { ...config, reviewerArgv: [] },
    { ...config, workerArgv: [...validWorkerArgv.slice(0, 2), ...validWorkerArgv.slice(4)] },
    { ...config, workerArgv: validWorkerArgv.map((value) => value === "high" ? "low" : value) },
    { ...config, reviewerArgv: validReviewerArgv.filter((value) => value !== "--no-extensions") },
    { ...config, reviewerArgv: [...validReviewerArgv, "--extension", "/tmp/override.js"] },
    { ...config, reviewerArgv: [...validReviewerArgv, "--continue"] },
    {
      ...config,
      reviewerArgv: validReviewerArgv.map((value) => value === validCodeReviewSkillPath ? "/tmp/code-review" : value),
    },
    { ...config, reviewerArgv: [...validReviewerArgv, "--skill", "/tmp/code-review"] },
    { ...config, reviewerArgv: [...validReviewerArgv, "--skill", substituteCodeReviewSkillPath] },
    {
      ...config,
      workerArgv: validWorkerArgv.map((value) => value === validImplementSkillPath ? untrustedImplementSkillPath : value),
    },
    {
      ...config,
      reviewerArgv: validReviewerArgv.map((value) => (
        value === "read,grep,find,ls,subagent,review_validate,review_submit" ? `${value},write` : value
      )),
    },
  ]) {
    assert.throws(() => new HarnessController({
      config: invalidConfig,
      store: new MemoryStore(),
      github: new FakeGitHub([]),
      git: new FakeGit(),
      herdr: new FakeHerdr([]),
      analyst: new FakeAnalyst(),
      evidence: new FakeEvidence(),
      clock: new FakeClock(),
      ids: new SequenceIds(),
    }), /(?:workerArgv|reviewerArgv) must enforce the Pi role contract/);
  }
});

test("config rejects state paths that overlap source or worktree roots", () => {
  for (const invalidConfig of [
    { ...config, stateDir: "/" },
    { ...config, stateDir: "/state", worktreeRoot: "/state/worktrees" },
    { ...config, stateDir: "/state/reviewer", worktreeRoot: "/state" },
  ]) {
    assert.throws(() => new HarnessController({
      config: invalidConfig,
      store: new MemoryStore(),
      github: new FakeGitHub([]),
      git: new FakeGit(),
      herdr: new FakeHerdr([]),
      analyst: new FakeAnalyst(),
      evidence: new FakeEvidence(),
      clock: new FakeClock(),
      ids: new SequenceIds(),
    }), /must not overlap/);
  }
});

test("Reviewer attempt binds validation argv before later config changes", async () => {
  const mutableConfig = { ...config, reviewerValidationArgv: [...config.reviewerValidationArgv] };
  const git = new FakeGit();
  const controller = new HarnessController({
    config: mutableConfig,
    store: new MemoryStore(),
    github: new FakeGitHub([issue({ number: 24, title: "Bind review validation" })]),
    git,
    herdr: new FakeHerdr([{ lane: "worker", status: "completed", headSha: "b".repeat(40) }]),
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
  });

  for (let index = 0; index < 9; index += 1) await controller.tick();
  mutableConfig.reviewerValidationArgv[0] = "changed-after-preparation";
  await controller.tick();
  assert.deepEqual(git.reviewerValidationArgv, [["npm", "run", "verify"]]);
});

test("blocked Reviewer cannot bypass worktree verification", async () => {
  const store = new MemoryStore();
  const git = new FakeGit();
  git.reviewerFailure = "reviewer left an untracked product file";
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 22, title: "Verify blocked review" })]),
    git,
    herdr: new FakeHerdr([
      { lane: "worker", status: "completed", headSha: "b".repeat(40) },
      { lane: "reviewer", status: "blocked", summary: "review evidence unavailable" },
    ]),
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
  });

  for (let index = 0; index < 13; index += 1) await controller.tick();
  assert.equal(store.state.activeJob?.incident?.class, "integrity_violation");
  assert.match(store.state.activeJob?.incident?.summary ?? "", /untracked product file/);
});

test("Reviewer wait failure cannot bypass worktree verification", async () => {
  const store = new MemoryStore();
  const git = new FakeGit();
  git.reviewerFailure = "reviewer changed the worktree before wait failed";
  const herdr = new FakeHerdr([
    { lane: "worker", status: "completed", headSha: "b".repeat(40) },
  ]);
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 23, title: "Verify failed review wait" })]),
    git,
    herdr,
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
  });

  for (let index = 0; index < 12; index += 1) await controller.tick();
  herdr.waitFailure = new Error("Herdr wait unavailable");
  await controller.tick();
  assert.equal(store.state.activeJob?.incident?.class, "integrity_violation");
  assert.match(store.state.activeJob?.incident?.summary ?? "", /changed the worktree/);
});

test("happy path claims, starts Analyst, runs fresh Pi worker/reviewer, publishes, and archives", async () => {
  const store = new MemoryStore();
  const github = new FakeGitHub([issue({ number: 21, title: "Implement feature" })]);
  const herdr = new FakeHerdr([
    { lane: "worker", status: "completed", headSha: "b".repeat(40) },
    { lane: "reviewer", status: "pass" },
  ]);
  const analyst = new FakeAnalyst();
  const controller = new HarnessController({
    config,
    store,
    github,
    git: new FakeGit(),
    herdr,
    analyst,
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
  });

  const actions: string[] = [];
  for (let index = 0; index < 14; index += 1) actions.push((await controller.tick()).action);
  github.mergeStatus = "open";
  actions.push((await controller.tick()).action);
  github.mergeStatus = "merged";
  actions.push((await controller.tick()).action);
  actions.push((await controller.tick()).action);

  assert.deepEqual(actions, [
    "selected",
    "claimed",
    "worktree_created",
    "attempt_prepared",
    "attempt_pane_ready",
    "attempt_agent_ready",
    "attempt_dispatched",
    "attempt_completed",
    "attempt_prepared",
    "attempt_pane_ready",
    "attempt_agent_ready",
    "attempt_dispatched",
    "attempt_completed",
    "published",
    "waiting_for_merge",
    "merged",
    "archived",
  ]);
  assert.equal(github.claims.length, 1);
  assert.equal(github.claims[0]?.issue, 21);
  assert.equal(analyst.starts.length, 1);
  assert.deepEqual(analyst.closes, [{
    jobId: "job-001",
    sessionId: "analyst-job-001",
    taskDigest: analyst.starts[0]!.taskDigest,
  }]);
  assert.equal(herdr.prepared.length, 2);
  assert.equal(herdr.prepared[0]?.lane, "worker");
  assert.equal(herdr.prepared[1]?.lane, "reviewer");
  assert.match(herdr.prepared[1]?.cwd ?? "", /^\/state\/reviewer-attempts\/job-001\/reviewer-/);
  assert.match(herdr.prepared[1]?.env.HERDR_HARNESS_REVIEW_DESCRIPTOR ?? "", /\/descriptor\.json$/);
  assert.ok(herdr.prepared[1]?.env.PI_SUBAGENT_CAPABILITY_CEILING_V1);
  assert.deepEqual(JSON.parse(Buffer.from(
    herdr.prepared[1]!.env.PI_SUBAGENT_CAPABILITY_CEILING_V1!,
    "base64url",
  ).toString("utf8")), {
    version: 1,
    allowedTools: ["find", "grep", "ls", "read"],
    allowedAgents: ["herdr-harness-review-axis"],
    denyExtensions: true,
    sources: ["herdr-harness-lite"],
  });
  assert.ok(herdr.prepared[0]?.attemptId !== herdr.prepared[1]?.attemptId);
  assert.deepEqual(herdr.prompts.map((prompt) => prompt.skill), ["implement", "code-review"]);
  assert.deepEqual(herdr.closed, [
    herdr.prepared[0]!.handle.agentName,
    herdr.prepared[1]!.handle.agentName,
  ]);
  assert.equal(github.published[0]?.headSha, "b".repeat(40));
  assert.equal(store.state.activeJob, null);
  assert.equal(store.state.terminalJobs[0]?.state, "done");
});

test("an ambiguous prompt failure never replays the same dispatch", async () => {
  const store = new MemoryStore();
  const herdr = new FakeHerdr([
    { lane: "worker", status: "completed", headSha: "b".repeat(40) },
  ]);
  herdr.promptFailureAfterDispatch = new Error("connection closed after submission");
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 22, title: "At-most-once dispatch" })]),
    git: new FakeGit(),
    herdr,
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
  });

  for (let index = 0; index < 4; index += 1) await controller.tick();
  const paneReady = await controller.tick();
  assert.equal(paneReady.action, "attempt_pane_ready");
  assert.equal(store.state.activeJob?.activeAttempt?.phase, "pane_ready");
  assert.equal(herdr.started.length, 0);

  await controller.tick();
  assert.equal(store.state.activeJob?.activeAttempt?.phase, "agent_ready");
  assert.equal(herdr.started.length, 1);

  const ambiguous = await controller.tick();
  assert.equal(ambiguous.action, "attempt_dispatched");
  assert.equal(ambiguous.ok, false);
  assert.equal(store.state.activeJob?.activeAttempt?.phase, "running");
  assert.equal(herdr.prompts.length, 1);

  await controller.tick();
  assert.equal(herdr.prompts.length, 1);
  assert.equal(store.state.activeJob?.state, "reviewer_ready");
});

test("a durable valid result completes even when the closed agent is no longer known", async () => {
  const store = new MemoryStore();
  const herdr = new FakeHerdr([
    { lane: "worker", status: "completed", headSha: "b".repeat(40), agentStatus: "unknown" },
  ]);
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 23, title: "Recover closed pane" })]),
    git: new FakeGit(),
    herdr,
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
  });

  for (let index = 0; index < 8; index += 1) await controller.tick();

  assert.equal(store.state.activeJob?.state, "reviewer_ready");
  assert.equal(herdr.closed.length, 1);
});

test("a terminal job is retained when its exact Analyst session cannot be closed", async () => {
  const store = new MemoryStore();
  const github = new FakeGitHub([issue({ number: 24, title: "Retain cleanup failure" })]);
  const analyst = new FakeAnalyst();
  analyst.closeFailure = new Error("session delete failed");
  const controller = new HarnessController({
    config,
    store,
    github,
    git: new FakeGit(),
    herdr: new FakeHerdr([
      { lane: "worker", status: "completed", headSha: "b".repeat(40) },
      { lane: "reviewer", status: "pass" },
    ]),
    analyst,
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
  });

  for (let index = 0; index < 14; index += 1) await controller.tick();
  github.mergeStatus = "merged";
  await controller.tick();
  const retained = await controller.tick();

  assert.equal(retained.action, "archived");
  assert.equal(retained.ok, false);
  assert.match(retained.message, /session delete failed/);
  assert.equal(store.state.activeJob?.state, "done");
  assert.equal(store.state.terminalJobs.length, 0);
});
