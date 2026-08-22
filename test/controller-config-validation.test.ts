import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateHarnessConfig } from "../src/controller/config-validation.js";
import { workerCompactionMode } from "../src/controller/runtime-contract.js";
import type { HarnessConfig } from "../src/ports.js";
import {
  configuredRuntimeTimeouts,
  configuredValidationTimeoutMs,
  DEFAULT_REVIEWER_TIMEOUTS,
  DEFAULT_TERMINATION_TIMEOUTS,
  DEFAULT_VALIDATION_TIMEOUT_MS,
  DEFAULT_WORKER_TIMEOUTS,
} from "../src/runtime-timeouts.js";

test("single-project config rejects source checkout and worktree root overlap", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-config-overlap-"));
  try {
    const localPath = join(root, "source");
    const stateDir = join(root, "state");
    const worktreeRoot = join(localPath, "worktrees");
    for (const path of [localPath, stateDir, worktreeRoot]) mkdirSync(path, { recursive: true });
    assert.throws(() => validateHarnessConfig({
      repo: "owner/repo",
      localPath,
      stateDir,
      baseRef: "main",
      readyLabel: "ready-for-agent",
      claimLabel: "agent:claimed",
      worktreeRoot,
      maxReviewRounds: 3,
      maxAnalystTurns: 3,
      reviewerValidationArgv: ["npm", "test"],
      workerArgv: [],
      reviewerArgv: [],
    }), /localPath and worktreeRoot must not overlap/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime timeout defaults remain compatible and overrides fail closed", () => {
  const config = {} as HarnessConfig;
  assert.deepEqual(configuredRuntimeTimeouts(config, "worker"), { ...DEFAULT_WORKER_TIMEOUTS, ...DEFAULT_TERMINATION_TIMEOUTS });
  assert.deepEqual(configuredRuntimeTimeouts(config, "reviewer"), { ...DEFAULT_REVIEWER_TIMEOUTS, ...DEFAULT_TERMINATION_TIMEOUTS });
  assert.equal(configuredValidationTimeoutMs(config), DEFAULT_VALIDATION_TIMEOUT_MS);
  assert.deepEqual(configuredRuntimeTimeouts({
    reviewer: { totalTimeoutMs: 9_000, noProgressTimeoutMs: 2_000 },
    termination: { sigtermGraceMs: 300, sigkillGraceMs: 200 },
  } as HarnessConfig, "reviewer"), {
    totalTimeoutMs: 9_000,
    noProgressTimeoutMs: 2_000,
    sigtermGraceMs: 300,
    sigkillGraceMs: 200,
  });
  assert.equal(configuredValidationTimeoutMs({ validation: { totalTimeoutMs: 7_000 } } as HarnessConfig), 7_000);

  const root = mkdtempSync(join(tmpdir(), "herdr-config-timeouts-"));
  try {
    const localPath = join(root, "source");
    const stateDir = join(root, "state");
    const worktreeRoot = join(root, "worktrees");
    for (const path of [localPath, stateDir, worktreeRoot]) mkdirSync(path, { recursive: true });
    const base: HarnessConfig = {
      repo: "owner/repo",
      localPath,
      stateDir,
      baseRef: "main",
      readyLabel: "ready-for-agent",
      claimLabel: "agent:claimed",
      worktreeRoot,
      maxReviewRounds: 3,
      maxAnalystTurns: 3,
      reviewerValidationArgv: ["npm", "test"],
      workerArgv: [],
      reviewerArgv: [],
    };
    assert.throws(() => validateHarnessConfig({ ...base, worker: { totalTimeoutMs: 100, noProgressTimeoutMs: 101 } }), /must not exceed/);
    assert.throws(() => validateHarnessConfig({ ...base, validation: { totalTimeoutMs: 0 } }), /validation\.totalTimeoutMs/);
    assert.throws(() => validateHarnessConfig({ ...base, termination: { sigtermGraceMs: -1 } }), /termination grace/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Worker compaction defaults disabled and rejects ambiguous or unused configuration", () => {
  assert.equal(workerCompactionMode({} as HarnessConfig), "disabled");
  assert.equal(workerCompactionMode({ workerCompaction: { mode: "controlled-threshold" } } as HarnessConfig), "controlled-threshold");
  const root = mkdtempSync(join(tmpdir(), "herdr-config-compaction-"));
  try {
    const base = {
      repo: "owner/repo",
      localPath: join(root, "source"),
      stateDir: join(root, "state"),
      baseRef: "main",
      readyLabel: "ready-for-agent",
      claimLabel: "agent:claimed",
      worktreeRoot: join(root, "worktrees"),
      maxReviewRounds: 3,
      maxAnalystTurns: 3,
      reviewerValidationArgv: ["npm", "test"],
      workerArgv: [],
      reviewerArgv: [],
    } satisfies HarnessConfig;
    for (const path of [base.localPath, base.stateDir, base.worktreeRoot]) mkdirSync(path, { recursive: true });
    assert.throws(() => validateHarnessConfig({
      ...base,
      workerCompaction: { mode: "invalid" },
    } as unknown as HarnessConfig), /workerCompaction/);
    assert.throws(() => validateHarnessConfig({
      ...base,
      workerCompaction: { mode: "controlled-threshold" },
    }), /requires workerRuntime=pi-rpc/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
