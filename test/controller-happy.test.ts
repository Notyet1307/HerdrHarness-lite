import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HarnessController } from "../src/controller.js";
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
  substituteCodeReviewSkillPath,
  substituteTddSkillPath,
  untrustedImplementSkillPath,
  validCodeReviewSkillPath,
  validImplementSkillPath,
  validPiSubagentsExtensionPath,
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
const rpcWorkerArgv = [...validWorkerArgv, "--provider", "test", "--model", "model"];

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
      preflight: new FakeRuntimePreflight(),
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
    preflight: new FakeRuntimePreflight(),
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
    preflight: new FakeRuntimePreflight(),
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
    preflight: new FakeRuntimePreflight(),
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
    preflight: new FakeRuntimePreflight(),
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
    { ...config, workerArgv: [...validWorkerArgv, "--skill", validCodeReviewSkillPath] },
    { ...config, reviewerArgv: [...validReviewerArgv, "--skill", substituteCodeReviewSkillPath] },
    {
      ...config,
      workerArgv: validWorkerArgv.map((value) => value === validImplementSkillPath ? untrustedImplementSkillPath : value),
    },
    {
      ...config,
      workerArgv: validWorkerArgv.map((value) => value.endsWith("/pi/skills/tdd") ? substituteTddSkillPath : value),
    },
    {
      ...config,
      reviewerArgv: validReviewerArgv.map((value) => (
        value === "read,grep,find,ls,subagent,review_preflight,review_validate,review_submit" ? `${value},write` : value
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
      preflight: new FakeRuntimePreflight(),
    }), /(?:workerArgv|reviewerArgv) must enforce the Pi role contract/);
  }
});

test("config rejects an unqualified pi-subagents version", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-pi-subagents-version-"));
  const packageRoot = join(root, "pi-subagents");
  try {
    cpSync(resolve("test/fixtures/pi-subagents"), packageRoot, { recursive: true });
    const manifestPath = join(packageRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string };
    manifest.version = "0.42.2";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const reviewerArgv = validReviewerArgv.map((value) => (
      value === validPiSubagentsExtensionPath ? join(packageRoot, "index.js") : value
    ));
    assert.throws(() => new HarnessController({
      config: { ...config, reviewerArgv },
      store: new MemoryStore(),
      github: new FakeGitHub([]),
      git: new FakeGit(),
      herdr: new FakeHerdr([]),
      analyst: new FakeAnalyst(),
      evidence: new FakeEvidence(),
      clock: new FakeClock(),
      ids: new SequenceIds(),
      preflight: new FakeRuntimePreflight(),
    }), /reviewerArgv must enforce the Pi role contract/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config requires every ambient-discovery hardening flag", () => {
  for (const field of ["workerArgv", "reviewerArgv"] as const) {
    for (const flag of ["--no-session", "--no-context-files", "--no-prompt-templates", "--no-themes"]) {
      assert.throws(() => new HarnessController({
        config: { ...config, [field]: config[field].filter((value) => value !== flag) },
        store: new MemoryStore(),
        github: new FakeGitHub([]),
        git: new FakeGit(),
        herdr: new FakeHerdr([]),
        analyst: new FakeAnalyst(),
        evidence: new FakeEvidence(),
        clock: new FakeClock(),
        ids: new SequenceIds(),
        preflight: new FakeRuntimePreflight(),
      }), new RegExp(`exactly one ${flag} is required`));
    }
  }
});

test("Pi RPC configuration requires the Worker runtime adapter", () => {
  const dependencies = {
    config: { ...config, workerRuntime: "pi-rpc" as const, workerArgv: rpcWorkerArgv },
    store: new MemoryStore(),
    github: new FakeGitHub([]),
    git: new FakeGit(),
    herdr: new FakeHerdr([]),
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
    preflight: new FakeRuntimePreflight(),
  };
  assert.throws(() => new HarnessController(dependencies), /requires the Worker RPC adapter/);
  assert.throws(() => new HarnessController({ ...dependencies, config: { ...config, workerRuntime: "pi-rpc" } }), /requires one explicit --provider/);
});

test("runtime preflight fails before claim and does not reserve an issue", async () => {
  const store = new MemoryStore();
  const github = new FakeGitHub([issue({ number: 30, title: "Preflight before claim" })]);
  const preflight = new FakeRuntimePreflight();
  preflight.providerFailure = new Error("provider sessions are full");
  const controller = new HarnessController({
    config,
    store,
    github,
    git: new FakeGit(),
    herdr: new FakeHerdr([]),
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
    preflight,
  });

  const output = await controller.tick();
  assert.equal(output.action, "preflight_failed");
  assert.equal(output.ok, false);
  assert.match(output.message, /provider sessions are full/);
  assert.equal(store.state.activeJob, null);
  assert.equal(github.claims.length, 0);
});

test("Attempt binds one immutable execution snapshot and ignores later config drift", async () => {
  const store = new MemoryStore();
  const herdr = new FakeHerdr([{ lane: "worker", status: "completed", headSha: "b".repeat(40) }]);
  const runtimeConfig: HarnessConfig = { ...config, workerArgv: [...validWorkerArgv] };
  const preflight = new FakeRuntimePreflight();
  const controller = new HarnessController({
    config: runtimeConfig,
    store,
    github: new FakeGitHub([issue({ number: 31, title: "Immutable execution plan" })]),
    git: new FakeGit(),
    herdr,
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
    preflight,
  });

  for (let index = 0; index < 4; index += 1) await controller.tick();
  const attempt = store.state.activeJob?.activeAttempt;
  assert.equal(attempt?.executionSnapshot?.executable, "/opt/pi");
  assert.equal(attempt?.executionSnapshot?.runtimeVersion, "0.84.0");
  assert.equal(attempt?.executionSnapshot?.resources.length, 4);
  assert.equal(attempt?.executionSnapshot?.sessionMode, "ephemeral");
  assert.deepEqual(attempt?.executionSnapshot?.argv.slice(-2), [
    "--append-system-prompt",
    attempt?.executionSnapshot?.context?.bundlePath,
  ]);
  assert.match(attempt?.planDigest ?? "", /^[0-9a-f]{64}$/);

  runtimeConfig.workerArgv = validWorkerArgv.map((value) => value === "high" ? "max" : value);
  runtimeConfig.preflight = { dockerRequired: true };
  await controller.tick();
  await controller.tick();
  assert.deepEqual(herdr.startedArgv, [attempt!.executionSnapshot!.argv]);
  assert.deepEqual(preflight.providerCalls.at(-1)?.roleArgv, attempt!.executionSnapshot!.argv);
  assert.equal(herdr.prepared[0]?.env.DOCKER_HOST, "");
});

test("Attempt fails closed when its plan or inspected runtime drifts", async () => {
  for (const mutate of [
    (store: MemoryStore, preflight: FakeRuntimePreflight) => { preflight.version = "0.85.0"; },
    (store: MemoryStore) => { store.state.activeJob!.activeAttempt!.executionSnapshot!.argv.push("--no-session"); },
  ]) {
    const store = new MemoryStore();
    const preflight = new FakeRuntimePreflight();
    const herdr = new FakeHerdr([]);
    const controller = new HarnessController({
      config,
      store,
      github: new FakeGitHub([issue({ number: 32, title: "Reject execution drift" })]),
      git: new FakeGit(),
      herdr,
      analyst: new FakeAnalyst(),
      evidence: new FakeEvidence(),
      clock: new FakeClock(),
      ids: new SequenceIds(),
      preflight,
    });
    for (let index = 0; index < 4; index += 1) await controller.tick();
    mutate(store, preflight);
    const output = await controller.tick();
    assert.equal(output.action, "blocked");
    assert.equal(store.state.activeJob?.incident?.class, "integrity_violation");
    assert.equal(herdr.prepared.length, 0);
  }
});

test("Attempt blocks before pane creation when trusted context or ambient SYSTEM state drifts", async () => {
  for (const breakBoundary of [
    (git: FakeGit) => { git.trustedContextFailure = new Error("bundle digest changed"); },
    (_git: FakeGit, preflight: FakeRuntimePreflight) => { preflight.ambientFailure = new Error("global SYSTEM appeared"); },
  ]) {
    const store = new MemoryStore();
    const git = new FakeGit();
    const preflight = new FakeRuntimePreflight();
    const herdr = new FakeHerdr([]);
    const controller = new HarnessController({
      config,
      store,
      github: new FakeGitHub([issue({ number: 35, title: "Context drift" })]),
      git,
      herdr,
      analyst: new FakeAnalyst(),
      evidence: new FakeEvidence(),
      clock: new FakeClock(),
      ids: new SequenceIds(),
      preflight,
    });
    for (let index = 0; index < 4; index += 1) await controller.tick();
    breakBoundary(git, preflight);
    const output = await controller.tick();
    assert.equal(output.action, "blocked");
    assert.equal(store.state.activeJob?.incident?.class, "integrity_violation");
    assert.equal(herdr.prepared.length, 0);
  }
});

test("Attempt binds the Docker host and rejects environment drift", async () => {
  const store = new MemoryStore();
  const preflight = new FakeRuntimePreflight();
  const herdr = new FakeHerdr([]);
  const controller = new HarnessController({
    config: { ...config, preflight: { dockerRequired: true } },
    store,
    github: new FakeGitHub([issue({ number: 38, title: "Bind Docker environment" })]),
    git: new FakeGit(),
    herdr,
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
    preflight,
  });
  for (let index = 0; index < 4; index += 1) await controller.tick();
  assert.equal(store.state.activeJob?.activeAttempt?.executionSnapshot?.dockerHost, preflight.dockerHost);

  preflight.dockerHost = "unix:///tmp/other.sock";
  const output = await controller.tick();
  assert.equal(output.action, "blocked");
  assert.equal(store.state.activeJob?.incident?.class, "integrity_violation");
  assert.equal(herdr.prepared.length, 0);
});

test("Worker and Reviewer contexts both trust the job base, never candidate Head", async () => {
  const store = new MemoryStore();
  const git = new FakeGit();
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 36, title: "Reviewer trust anchor" })]),
    git,
    herdr: new FakeHerdr([
      { lane: "worker", status: "completed", headSha: "b".repeat(40) },
      { lane: "reviewer", status: "pass" },
    ]),
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
    preflight: new FakeRuntimePreflight(),
  });
  for (let index = 0; index < 9; index += 1) await controller.tick();

  assert.deepEqual(git.trustedContexts.map((context) => context.trustAnchorSha), [git.baseSha, git.baseSha]);
  assert.deepEqual(git.trustedContexts.map((context) => context.lane), ["worker", "reviewer"]);
  assert.equal(store.state.activeJob?.activeAttempt?.executionSnapshot?.resources.some((resource) => resource.kind === "agent"), true);
});

test("Pi RPC canary preflights and routes only Worker through its isolated runtime", async () => {
  const store = new MemoryStore();
  const herdr = new FakeHerdr([{ lane: "reviewer", status: "pass" }]);
  const workerRpc = new FakeHerdr([{ lane: "worker", status: "completed", headSha: "b".repeat(40) }]);
  const preflight = new FakeRuntimePreflight();
  const controller = new HarnessController({
    config: { ...config, workerRuntime: "pi-rpc", workerArgv: rpcWorkerArgv },
    store,
    github: new FakeGitHub([issue({ number: 37, title: "Worker RPC canary" })]),
    git: new FakeGit(),
    herdr,
    workerRpc,
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
    preflight,
  });
  for (let index = 0; index < 13; index += 1) await controller.tick();

  assert.equal(workerRpc.started.length, 1);
  assert.equal(herdr.prepared.find((entry) => entry.lane === "worker")?.env.PI_CODING_AGENT_DIR, "/pi-agent");
  assert.deepEqual(workerRpc.prompts.map((prompt) => prompt.skill), ["implement"]);
  assert.equal(herdr.started.length, 1);
  assert.deepEqual(herdr.prompts.map((prompt) => prompt.skill), ["code-review"]);
  assert.equal(store.state.activeJob?.attempts[0]?.executionSnapshot?.adapter, "pi-rpc");
  assert.equal(store.state.activeJob?.attempts[0]?.executionSnapshot?.retryMode, "disabled");
  assert.equal(store.state.activeJob?.attempts[1]?.executionSnapshot?.adapter, "herdr-pi-cli");
  assert.deepEqual(store.state.activeJob?.attempts[0]?.executionSnapshot?.argv.slice(-2), ["--mode", "rpc"]);
  const rpcProbes = preflight.providerCalls.filter((call) => call.lane === "worker");
  assert.equal(rpcProbes.length, 2);
  assert.equal(rpcProbes[0]?.agentDir, "/state/preflight/pi-rpc-agent");
  assert.equal(rpcProbes[0]?.oauthAgentDir, "/pi-agent");
  assert.equal(rpcProbes[0]?.piBin, "/opt/pi");
  assert.equal(rpcProbes[0]?.rpcHost?.kind, "runtime");
  assert.match(rpcProbes[1]?.agentDir ?? "", /\/runtime\/pi-agent$/);
  assert.equal(rpcProbes[1]?.rpcHost?.kind, "runtime");
  assert.equal(preflight.providerCalls.some((call) => call.lane === "worker" && call.agentDir === undefined), false);
});

test("Pi RPC Worker admission failure makes no durable selection or claim", async () => {
  const store = new MemoryStore();
  const github = new FakeGitHub([issue({ number: 38, title: "RPC admission" })]);
  const preflight = new FakeRuntimePreflight();
  preflight.providerFailure = new Error("subscription OAuth unavailable");
  const controller = new HarnessController({
    config: { ...config, workerRuntime: "pi-rpc", workerArgv: rpcWorkerArgv },
    store,
    github,
    git: new FakeGit(),
    herdr: new FakeHerdr([]),
    workerRpc: new FakeHerdr([]),
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
    preflight,
  });

  const output = await controller.tick();

  assert.equal(output.action, "preflight_failed");
  assert.equal(store.state.activeJob, null);
  assert.deepEqual(github.claims, []);
  assert.equal(preflight.providerCalls.length, 1);
  assert.equal(preflight.providerCalls[0]?.lane, "worker");
  assert.equal(preflight.providerCalls[0]?.agentDir, "/state/preflight/pi-rpc-agent");
  assert.equal(preflight.providerCalls[0]?.rpcHost?.kind, "runtime");
});

test("legacy running Attempts remain observable but legacy pre-start Attempts cannot launch", async () => {
  for (const phase of ["prepared", "running"] as const) {
    const store = new MemoryStore();
    const herdr = new FakeHerdr([{ lane: "worker", status: "completed", headSha: "b".repeat(40) }]);
    const controller = new HarnessController({
      config,
      store,
      github: new FakeGitHub([issue({ number: phase === "prepared" ? 33 : 34, title: `Legacy ${phase}` })]),
      git: new FakeGit(),
      herdr,
      analyst: new FakeAnalyst(),
      evidence: new FakeEvidence(),
      clock: new FakeClock(),
      ids: new SequenceIds(),
      preflight: new FakeRuntimePreflight(),
    });
    const ticks = phase === "prepared" ? 4 : 7;
    for (let index = 0; index < ticks; index += 1) await controller.tick();
    delete store.state.activeJob!.activeAttempt!.executionSnapshot;
    delete store.state.activeJob!.activeAttempt!.planDigest;
    const output = await controller.tick();
    assert.equal(output.action, phase === "prepared" ? "blocked" : "attempt_completed");
    if (phase === "prepared") assert.equal(herdr.prepared.length, 0);
  }
});

test("Docker and lane Provider preflights bind the local socket before Worker and Reviewer panes", async () => {
  const store = new MemoryStore();
  const git = new FakeGit();
  const herdr = new FakeHerdr([
    { lane: "worker", status: "completed", headSha: "b".repeat(40) },
  ]);
  const preflight = new FakeRuntimePreflight();
  const controller = new HarnessController({
    config: { ...config, preflight: { piBin: "/opt/pi", dockerRequired: true } },
    store,
    github: new FakeGitHub([issue({ number: 31, title: "Bind Docker preflight" })]),
    git,
    herdr,
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
    preflight,
  });

  for (let index = 0; index < 10; index += 1) await controller.tick();

  assert.deepEqual(preflight.providerCalls.map((call) => call.lane), ["worker", "reviewer", "worker", "reviewer"]);
  assert.equal(preflight.providerCalls.every((call) => call.piBin === "/opt/pi"), true);
  assert.equal(preflight.dockerCalls.length >= 5, true);
  assert.equal(herdr.prepared.find((entry) => entry.lane === "worker")?.env.DOCKER_HOST, preflight.dockerHost);
  assert.deepEqual(git.reviewerDockerHosts, [preflight.dockerHost]);
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
      preflight: new FakeRuntimePreflight(),
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
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 9; index += 1) await controller.tick();
  mutableConfig.reviewerValidationArgv[0] = "changed-after-preparation";
  await controller.tick();
  assert.deepEqual(git.reviewerValidationArgv, [["npm", "run", "verify"]]);
});

test("Reviewer preflight attributes pre-existing worktree residue before any Reviewer handle", async () => {
  const store = new MemoryStore();
  const git = new FakeGit();
  const herdr = new FakeHerdr([
    { lane: "worker", status: "completed", headSha: "b".repeat(40) },
  ]);
  const controller = new HarnessController({
    config,
    store,
    github: new FakeGitHub([issue({ number: 25, title: "Preflight residue" })]),
    git,
    herdr,
    analyst: new FakeAnalyst(),
    evidence: new FakeEvidence(),
    clock: new FakeClock(),
    ids: new SequenceIds(),
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 9; index += 1) await controller.tick();
  assert.equal(herdr.prepared.find((entry) => entry.lane === "worker")?.env.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(herdr.prepared.find((entry) => entry.lane === "worker")?.env.PI_CODING_AGENT_DIR, "/pi-agent");
  git.reviewerFailure = "worktree has changes outside Harness result files:\n?? generated.pyc";
  await controller.tick();

  assert.equal(store.state.activeJob?.incident?.class, "reviewer_preflight_dirty");
  assert.equal(store.state.activeJob?.activeAttempt?.handle, null);
  assert.equal(herdr.prepared.filter((entry) => entry.lane === "reviewer").length, 0);
  assert.match(store.state.activeJob?.incident?.summary ?? "", /before Reviewer start/);
});

test("blocked Reviewer cannot bypass worktree verification", async () => {
  const store = new MemoryStore();
  const git = new FakeGit();
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
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 12; index += 1) await controller.tick();
  git.reviewerFailure = "reviewer left an untracked product file";
  await controller.tick();
  assert.equal(store.state.activeJob?.incident?.class, "integrity_violation");
  assert.match(store.state.activeJob?.incident?.summary ?? "", /untracked product file/);
});

test("Reviewer wait failure cannot bypass worktree verification", async () => {
  const store = new MemoryStore();
  const git = new FakeGit();
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
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 12; index += 1) await controller.tick();
  git.reviewerFailure = "reviewer changed the worktree before wait failed";
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
    preflight: new FakeRuntimePreflight(),
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
  assert.match(herdr.prepared[0]?.env.HERDR_HARNESS_WORKER_DESCRIPTOR ?? "", /\/descriptor\.json$/);
  assert.equal(herdr.prepared[0]?.env.PI_CODING_AGENT_DIR, "/pi-agent");
  assert.match(herdr.prepared[1]?.cwd ?? "", /^\/state\/reviewer-attempts\/job-001\/reviewer-/);
  assert.match(herdr.prepared[1]?.env.HERDR_HARNESS_REVIEW_DESCRIPTOR ?? "", /\/descriptor\.json$/);
  assert.equal(herdr.prepared[1]?.env.PI_CODING_AGENT_DIR, "/pi-agent");
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
  assert.match(herdr.prompts[0]?.text ?? "", /focused-self-check exactly once/);
  assert.match(herdr.prompts[0]?.text ?? "", /Do not run code-review or launch review subagents/);
  assert.match(herdr.prompts[0]?.text ?? "", /call worker_submit exactly once/);
  assert.equal(/Required identity:/.test(herdr.prompts[0]?.text ?? ""), false);
  assert.match(herdr.prompts[1]?.text ?? "", /Call review_preflight before/);
  assert.deepEqual(herdr.closed, [
    herdr.prepared[0]!.handle.agentName,
    herdr.prepared[1]!.handle.agentName,
  ]);
  assert.equal(github.published[0]?.headSha, "b".repeat(40));
  assert.deepEqual(github.releasedClaims, [21]);
  assert.ok(!github.graph[0]?.labels.includes("agent:claimed"));
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
    preflight: new FakeRuntimePreflight(),
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
    preflight: new FakeRuntimePreflight(),
  });

  for (let index = 0; index < 8; index += 1) await controller.tick();

  assert.equal(store.state.activeJob?.state, "reviewer_ready");
  assert.equal(herdr.closed.length, 1);
});

test("terminal archive keeps Analyst close fail-closed but treats claim cleanup as best effort", async () => {
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
    preflight: new FakeRuntimePreflight(),
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

  analyst.closeFailure = null;
  github.releaseClaimFailure = new Error("label cleanup failed");
  const archived = await controller.tick();

  assert.equal(archived.ok, true);
  assert.match(archived.message, /warning: claim label cleanup failed: label cleanup failed/);
  assert.equal(store.state.activeJob, null);
  assert.equal(store.state.terminalJobs[0]?.state, "done");
});
