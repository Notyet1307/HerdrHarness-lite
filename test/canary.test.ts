import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  aggregateCanaryReport,
  canaryFailureFromDiagnostic,
  canaryMatrix,
  canaryUnits,
  runCanaryMatrix,
  type CanaryExecutor,
  type CanaryUnit,
  type CanaryUnitResult,
} from "../src/canary.js";
import { CanaryIds, LiveCanaryExecutor, loadCanaryConfig } from "../src/canary-live.js";
import { FakeRuntimePreflight, validReviewerArgv, validWorkerArgv } from "./fakes.js";
import type { HerdrPort } from "../src/ports.js";
import { makeSafeRuntimeDiagnostic } from "../src/pi-rpc-diagnostics.js";
import type { AgentHandle, Attempt, AttemptResult, WorktreeHandle } from "../src/model.js";

test("canary matrix preserves unsupported trust-boundary cells", () => {
  const matrix = canaryMatrix();
  for (const task of [
    "short-change",
    "medium-change",
    "long-tools",
    "reviewer-exact-head",
    "validation-long",
    "validation-large-output",
    "provider-network-fault",
    "provider-continuation-lost",
  ]) assert.equal(matrix.some((cell) => cell.task === task), true, task);
  for (const runtime of ["herdr-pi-cli", "pi-rpc"]) {
    for (const lane of ["worker", "reviewer"]) {
      assert.equal(matrix.some((cell) => cell.runtime === runtime && cell.lane === lane), true, `${runtime}/${lane}`);
    }
  }
  assert.equal(matrix.some((cell) => (
    cell.provider === "custom-api-key" && cell.lane === "worker" && cell.execution === "unsupported"
  )), true);
  assert.equal(matrix.some((cell) => (
    cell.provider === "openai-oauth" && cell.lane === "reviewer"
    && cell.axisConcurrency === 2 && cell.execution === "unsupported"
  )), true);
  assert.equal(matrix.some((cell) => (
    cell.runtime === "pi-rpc" && cell.lane === "worker" && cell.task === "long-tools"
    && cell.compaction === "controlled-threshold" && cell.execution === "live"
  )), true);
  const ids = new CanaryIds("unit");
  assert.equal(ids.next("worker") === ids.next("worker"), false);
});

test("canary resumes an interrupted unit without a second dispatch and writes both reports", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-canary-"));
  const configDigest = "a".repeat(64);
  const dispatched = new Map<string, number>();
  let interrupt = true;
  const executor: CanaryExecutor = {
    async execute(unit, unitDir) {
      const dispatch = join(unitDir, "fake-dispatch.json");
      if (!existsSync(dispatch)) {
        writeFileSync(dispatch, JSON.stringify({ attemptId: unit.id }));
        dispatched.set(unit.id, (dispatched.get(unit.id) ?? 0) + 1);
      }
      if (interrupt) {
        interrupt = false;
        throw new Error("simulated process interruption after dispatch");
      }
      writeFileSync(join(unitDir, "PRIVATE_TRANSCRIPT_MUST_NOT_LEAK"), "access_token_MUST_NOT_LEAK");
      return passed(unit);
    },
  };
  try {
    await assert.rejects(() => runCanaryMatrix({
      stateDir: root,
      configDigest,
      repetitions: 1,
      executor,
    }), /simulated process interruption/);

    const serial = await runCanaryMatrix({
      stateDir: root,
      configDigest,
      repetitions: 1,
      executor,
    });
    assert.equal([...dispatched.values()].every((count) => count === 1), true);
    assert.equal(serial.partial, true);
    assert.equal(serial.totals.failed, 0);
    assert.ok(serial.totals.simulated > 0);
    assert.ok(serial.totals.unsupported > 0);
    assert.equal(serial.observations.rpcVsInteractive.incrementalFailure, 0);
    assert.equal(serial.observations.oauthAxisConcurrency.supported, false);

    const complete = await runCanaryMatrix({
      stateDir: root,
      configDigest,
      repetitions: 1,
      group: "stress",
      stressConcurrency: 3,
      executor,
    });
    assert.equal(complete.partial, false);
    assert.equal(complete.totals.completed, complete.totals.planned);
    assert.ok(complete.observations.rpcVsInteractive.confidence95);
    assert.ok(complete.observations.rpcVsInteractive.confidence95.low < 0);
    assert.ok(complete.observations.rpcVsInteractive.confidence95.high > 0);
    assert.equal(existsSync(join(root, "report.json")), true);
    assert.equal(existsSync(join(root, "report.md")), true);
    const serialized = readFileSync(join(root, "report.json"), "utf8");
    assert.equal(serialized.includes("access_token_MUST_NOT_LEAK"), false);
    assert.equal(serialized.includes("PRIVATE_TRANSCRIPT_MUST_NOT_LEAK"), false);
    const markdown = readFileSync(join(root, "report.md"), "utf8");
    for (const answer of [
      "Worker failure",
      "RPC vs interactive",
      "OAuth vs custom Provider",
      "Validation-followed continuation failure",
      "Result-present observation failure",
      "Controlled vs disabled compaction",
      "OAuth axis concurrency effect",
    ]) assert.equal(markdown.includes(answer), true, answer);
    assert.equal(Object.hasOwn(aggregateCanaryReport(complete), "units"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnose CLI reads canary reports without a production config", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-canary-diagnose-"));
  const configDigest = "b".repeat(64);
  const executor: CanaryExecutor = { execute: async (unit) => passed(unit) };
  try {
    await runCanaryMatrix({ stateDir: root, configDigest, repetitions: 1, executor });
    await runCanaryMatrix({
      stateDir: root,
      configDigest,
      repetitions: 1,
      group: "stress",
      stressConcurrency: 2,
      executor,
    });
    const aggregate = spawnSync(process.execPath, [
      resolve("dist/src/cli.js"), "diagnose", "--canary", join(root, "report.json"),
    ], { encoding: "utf8" });
    assert.equal(aggregate.status, 0, aggregate.stderr);
    assert.equal(Object.hasOwn(JSON.parse(aggregate.stdout) as object, "units"), false);

    const detailed = spawnSync(process.execPath, [
      resolve("dist/src/cli.js"), "diagnose", "--canary", join(root, "report.json"), "--json",
    ], { encoding: "utf8" });
    assert.equal(detailed.status, 0, detailed.stderr);
    const parsed = JSON.parse(detailed.stdout) as { partial: boolean; units: unknown[] };
    assert.equal(parsed.partial, false);
    assert.ok(parsed.units.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incremental failure uses the Newcombe score interval", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-canary-newcombe-"));
  const executor: CanaryExecutor = {
    execute: async (unit) => unit.runtime === "pi-rpc" ? failed(unit) : passed(unit),
  };
  try {
    const report = await runCanaryMatrix({
      stateDir: root,
      configDigest: "c".repeat(64),
      repetitions: 1,
      executor,
    });
    const comparison = report.observations.rpcVsInteractive;
    const samples = comparison.baseline.failures.denominator;
    assert.equal(comparison.baseline.failures.numerator, 0);
    assert.equal(comparison.candidate.failures.numerator, samples);
    const z2 = 1.959963984540054 ** 2;
    const oneSidedWilsonWidth = z2 / (samples + z2);
    const expectedLower = 1 - Math.sqrt(2 * oneSidedWilsonWidth ** 2);
    assert.ok(comparison.confidence95);
    assert.ok(Math.abs(comparison.confidence95.low - expectedLower) < 1e-12);
    assert.equal(comparison.confidence95.high, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live canary creates and reopens a fixed disposable Git repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-canary-live-"));
  try {
    const production = join(root, "production");
    const source = join(production, "source");
    const state = join(production, "state");
    const worktrees = join(production, "worktrees");
    for (const path of [source, state, worktrees]) mkdirSync(path, { recursive: true });
    const harnessPath = join(root, "harness.json");
    writeFileSync(harnessPath, JSON.stringify({
      repo: "owner/repo",
      localPath: source,
      stateDir: state,
      baseRef: "main",
      readyLabel: "ready-for-agent",
      claimLabel: "agent:claimed",
      worktreeRoot: worktrees,
      maxReviewRounds: 3,
      maxAnalystTurns: 3,
      workerRuntime: "herdr-pi-cli",
      reviewerRuntime: "herdr-pi-cli",
      workerCompaction: { mode: "disabled" },
      reviewerValidationArgv: [process.execPath, "--version"],
      workerArgv: validWorkerArgv,
      reviewerArgv: [...validReviewerArgv, "--provider", "openai-codex", "--model", "gpt-canary"],
      reviewerProviderProfiles: {
        active: "oauth",
        profiles: {
          oauth: {
            credentialMode: "canonical-oauth",
            provider: "openai-codex",
            model: "gpt-canary",
          },
          custom: {
            credentialMode: "canonical-model-config",
            provider: "custom-canary",
            model: "custom-model",
          },
        },
      },
      herdr: { session: "canary-test" },
    }));
    const canaryPath = join(root, "canary.json");
    const canaryState = join(root, "canary-state");
    writeFileSync(canaryPath, JSON.stringify({
      version: 1,
      stateDir: canaryState,
      harnessConfig: harnessPath,
      herdrSession: "canary-test-isolated",
      repetitions: 1,
      stressConcurrency: 2,
      oauthReviewerProfile: "oauth",
      customReviewerProfile: "custom",
      validationLongMs: 1000,
      validationOutputBytes: 256 * 1024,
    }));

    const config = loadCanaryConfig(canaryPath);
    assert.equal(config.herdr.session, "canary-test-isolated");
    new LiveCanaryExecutor(config);
    const fixture = join(canaryState, "fixture", "source");
    assert.equal(existsSync(join(fixture, ".git")), true);
    assert.equal(existsSync(join(fixture, "scripts", "context-probe.js")), true);
    const probe = spawnSync(process.execPath, [join(fixture, "scripts", "context-probe.js"), "0"], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(Buffer.byteLength(probe.stdout), 24 * 1024);
    assert.equal(probe.stdout.startsWith("probe=0\n"), true);
    const first = spawnSync("git", ["-C", fixture, "rev-parse", "HEAD"], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout.trim(), /^[0-9a-f]{40}$/);
    new LiveCanaryExecutor(config);
    const second = spawnSync("git", ["-C", fixture, "status", "--porcelain"], { encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, "");

    const localHerdr = new LocalCanaryHerdr();
    const preflight = new FakeRuntimePreflight();
    preflight.executable = process.execPath;
    preflight.version = "0.84.2";
    preflight.agentDir = join(root, "pi-agent");
    mkdirSync(preflight.agentDir, { recursive: true });
    const live = new LiveCanaryExecutor(config, { herdr: localHerdr, preflight });
    const worker = canaryUnits(1).find((candidate) => (
      candidate.execution === "live"
      && candidate.group === "serial"
      && candidate.lane === "worker"
      && candidate.runtime === "herdr-pi-cli"
      && candidate.task === "short-change"
    ))!;
    const workerResult = await live.execute(worker, join(canaryState, "live-worker"));
    assert.equal(workerResult.outcome, "passed");
    assert.equal(workerResult.resultPresent, true);
    assert.equal(localHerdr.worktrees, 1);
    const resumedWorker = await live.execute(worker, join(canaryState, "live-worker"));
    assert.equal(resumedWorker.outcome, "passed");
    assert.equal(localHerdr.worktrees, 1);

    const reviewer = canaryUnits(1).find((candidate) => (
      candidate.execution === "live"
      && candidate.group === "serial"
      && candidate.lane === "reviewer"
      && candidate.runtime === "herdr-pi-cli"
      && candidate.provider === "openai-oauth"
      && candidate.task === "reviewer-exact-head"
    ))!;
    const reviewerResult = await live.execute(reviewer, join(canaryState, "live-reviewer"));
    assert.equal(reviewerResult.outcome, "passed");
    assert.equal(reviewerResult.validationRan, true);
    assert.equal(reviewerResult.resultPresent, true);

    const unit = canaryUnits(1).find((candidate) => (
      candidate.execution === "live" && candidate.lane === "reviewer" && candidate.group === "serial"
    ))!;
    const unitDir = join(canaryState, "setup-recovery-unit");
    mkdirSync(unitDir, { recursive: true });
    const fixtureManifest = JSON.parse(readFileSync(join(canaryState, "fixture", "fixture.json"), "utf8")) as {
      baseSha: string;
    };
    writeFileSync(join(unitDir, "setup.json"), JSON.stringify({
      version: 1,
      unitId: unit.id,
      generation: 1,
      phase: "reserved",
      baseSha: fixtureManifest.baseSha,
      branch: `canary/${unit.id}-setup-1`,
      worktreePath: join(canaryState, "worktrees", `${unit.id}-setup-1`),
    }));
    const branches: string[] = [];
    const interruptedHerdr = {
      async createWorktree(input: { branch: string; path: string }) {
        branches.push(input.branch);
        return { workspaceId: `workspace-${branches.length}`, path: join(root, "missing"), branch: input.branch };
      },
    } as unknown as HerdrPort;
    await new LiveCanaryExecutor(config, { herdr: interruptedHerdr }).execute(unit, unitDir);
    await new LiveCanaryExecutor(config, { herdr: interruptedHerdr }).execute(unit, unitDir);
    assert.deepEqual(branches, [
      `canary/${unit.id}-setup-2`,
      `canary/${unit.id}-setup-3`,
    ]);
    const setup = JSON.parse(readFileSync(join(unitDir, "setup.json"), "utf8")) as {
      phase: string;
      generation: number;
    };
    assert.equal(setup.phase, "reserved");
    assert.equal(setup.generation, 3);

    const badReadyDir = join(canaryState, "bad-ready-unit");
    mkdirSync(badReadyDir, { recursive: true });
    writeFileSync(join(badReadyDir, "setup.json"), JSON.stringify({
      version: 1,
      unitId: unit.id,
      generation: 1,
      phase: "ready",
      baseSha: fixtureManifest.baseSha,
      headSha: fixtureManifest.baseSha,
      branch: `canary/${unit.id}-setup-1`,
      worktreePath: fixture,
      worktree: {
        workspaceId: "wrong-workspace",
        path: fixture,
        branch: `canary/${unit.id}-setup-1`,
      },
    }));
    const beforeBadReady = branches.length;
    const badReady = await new LiveCanaryExecutor(config, { herdr: interruptedHerdr }).execute(unit, badReadyDir);
    assert.equal(badReady.outcome, "failed");
    assert.equal(branches.length, beforeBadReady);

    const sameSession = JSON.parse(readFileSync(canaryPath, "utf8")) as Record<string, unknown>;
    sameSession.herdrSession = "canary-test";
    writeFileSync(canaryPath, JSON.stringify(sameSession));
    assert.throws(() => loadCanaryConfig(canaryPath), /must differ/);
  } finally {
    spawnSync("/bin/chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  }
});

function passed(unit: CanaryUnit): CanaryUnitResult {
  const now = new Date().toISOString();
  return {
    version: 1,
    unit,
    evidence: "measured",
    outcome: "passed",
    startedAt: now,
    completedAt: now,
    durationMs: 1,
    resultPresent: true,
    terminalObserved: true,
    validationRan: unit.lane === "reviewer",
    validationDurationMs: unit.lane === "reviewer" ? 10 : null,
    validationOutputBytes: unit.lane === "reviewer" ? 100 : null,
    compactionCount: unit.runtime === "pi-rpc" ? 0 : null,
    failure: null,
  };
}

function failed(unit: CanaryUnit): CanaryUnitResult {
  const now = new Date().toISOString();
  return {
    ...passed(unit),
    outcome: "failed",
    startedAt: now,
    completedAt: now,
    resultPresent: false,
    failure: canaryFailureFromDiagnostic(makeSafeRuntimeDiagnostic({
      domain: "execution",
      code: "runtime_internal",
      stage: "agent-run",
      failureDomain: "runner_internal",
      failureCode: "runner_unclassified",
      retryable: false,
    })),
  };
}

class LocalCanaryHerdr implements HerdrPort {
  worktrees = 0;
  private readonly worktreeByAttempt = new Map<string, string>();

  async createWorktree(input: {
    sourcePath: string;
    branch: string;
    baseRef: string;
    path: string;
  }): Promise<WorktreeHandle> {
    mkdirSync(dirname(input.path), { recursive: true });
    const created = spawnSync("git", [
      "-C", input.sourcePath, "worktree", "add", "-b", input.branch, input.path, input.baseRef,
    ], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    this.worktrees += 1;
    return { workspaceId: `workspace-${this.worktrees}`, path: input.path, branch: input.branch };
  }

  async createAttemptPane(input: {
    worktree: WorktreeHandle;
    attempt: { id: string; lane: "worker" | "reviewer" };
  }): Promise<AgentHandle> {
    this.worktreeByAttempt.set(input.attempt.id, input.worktree.path);
    return {
      agentName: `agent-${input.attempt.id}`,
      paneId: `pane-${input.attempt.id}`,
      tabId: `tab-${input.attempt.id}`,
      workspaceId: input.worktree.workspaceId,
    };
  }

  async startAgent(): Promise<void> {}

  async runInPane(): Promise<void> {
    throw new Error("interactive local canary must not launch an RPC pane command");
  }

  async prompt(input: {
    attempt: Attempt;
    dispatchId: string;
    skill: "implement" | "code-review";
  }): Promise<void> {
    assert.equal(input.dispatchId, input.attempt.id);
    const path = this.worktreeByAttempt.get(input.attempt.id);
    assert.ok(path);
    mkdirSync(dirname(input.attempt.resultPath), { recursive: true });
    let result: AttemptResult;
    if (input.attempt.lane === "worker") {
      const output = join(path, `canary-${input.attempt.id}.txt`);
      writeFileSync(output, "measured\n");
      git(path, ["add", output]);
      git(path, ["commit", "-m", "test: complete local canary"]);
      const headSha = git(path, ["rev-parse", "HEAD"]).trim();
      result = {
        version: 1,
        jobId: `canary-${input.attempt.id.split("-").slice(1, 2).join("")}`,
        attemptId: input.attempt.id,
        lane: "worker",
        status: "completed",
        summary: "completed",
        headSha,
        failedCommands: [],
      };
    } else {
      result = {
        version: 1,
        jobId: "",
        attemptId: input.attempt.id,
        lane: "reviewer",
        status: "pass",
        summary: "pass",
        reviewedHeadSha: input.attempt.expectedHeadSha,
        findings: [],
      };
    }
    const jobId = input.attempt.contextEnvelope?.identity.jobId;
    assert.ok(jobId);
    writeFileSync(input.attempt.resultPath, JSON.stringify({ ...result, jobId }));
  }

  async wait(input: {
    resultPath: string;
  }): Promise<{ agentStatus: "done"; result: AttemptResult; diagnostic: null }> {
    return {
      agentStatus: "done",
      result: JSON.parse(readFileSync(input.resultPath, "utf8")) as AttemptResult,
      diagnostic: null,
    };
  }

  async terminate(): Promise<void> {}

  async close(): Promise<void> {}
}

function git(path: string, argv: string[]): string {
  const result = spawnSync("git", ["-C", path, ...argv], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
