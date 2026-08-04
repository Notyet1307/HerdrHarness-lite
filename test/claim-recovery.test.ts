import test from "node:test";
import assert from "node:assert/strict";
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
} from "./fakes.js";

const config: HarnessConfig = {
  repo: "owner/repo",
  localPath: "/repo",
  baseRef: "main",
  readyLabel: "ready-for-agent",
  claimLabel: "agent:claimed",
  worktreeRoot: "/worktrees",
  maxReviewRounds: 3,
  maxAnalystTurns: 3,
  workerArgv: ["pi", "--profile", "worker"],
  reviewerArgv: ["pi", "--profile", "reviewer"],
};

test("a durable claim intent recovers when GitHub label mutation succeeded before the process crashed", async () => {
  const store = new MemoryStore();
  const github = new FakeGitHub([issue({ number: 51, title: "Crash-safe claim" })]);
  const analyst = new FakeAnalyst();
  const controller = new HarnessController({
    config,
    store,
    github,
    git: new FakeGit(),
    herdr: new FakeHerdr([]),
    analyst,
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
  });

  await controller.tick();
  assert.equal(store.state.activeJob?.claimConfirmed, false);
  github.graph[0]!.labels = ["agent:claimed"];

  const recovered = await controller.tick();
  assert.equal(recovered.action, "claimed");
  assert.equal(store.state.activeJob?.claimConfirmed, true);
  assert.equal(github.claims.length, 0);
  assert.equal(analyst.starts.length, 1);
});
