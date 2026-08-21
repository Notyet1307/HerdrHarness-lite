import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GitCli } from "../src/adapters/git-cli.js";
import { executionResourceDigest } from "../src/attempt-plan.js";
import { type CommandResult, type CommandRunner, requireSuccess, SyncCommandRunner } from "../src/adapters/command.js";
import { REVIEWER_CONTEXT_BUDGET_BYTES, REVIEWER_CONTEXT_BUDGET_RESERVE_BYTES } from "../src/reviewer-context-budget.js";
import { digest, type ReviewerValidationCheckpoint, type ReviewerValidationReceipt } from "../src/model.js";
import type { ReviewerCheckpointIdentity } from "../src/model.js";

const head = "b".repeat(40);
const worktree = { path: "/repo", branch: "agent/issue-1", workspaceId: "w1" };
const allowedResultPaths = [
  "/repo/.harness/attempt-worker.json",
  "/repo/.harness/attempt-reviewer.json",
];

function requireValidationCheckpoint(receipt: ReviewerValidationReceipt): ReviewerValidationCheckpoint {
  assert.equal("stage" in receipt && receipt.stage === "validation" && receipt.version === 2, true);
  if (!("stage" in receipt) || receipt.stage !== "validation" || receipt.version !== 2) {
    throw new Error("expected a v2 validation checkpoint");
  }
  return receipt;
}

test("Reviewer Git verification rejects untracked files outside Harness results", async () => {
  const allowed = await new GitCli(new ReviewRunner(
    "?? .harness/attempt-worker.json\n?? .harness/attempt-reviewer.json\n",
  )).verifyReviewer({ worktree, expectedHeadSha: head, reportedHeadSha: head, allowedResultPaths });
  assert.deepEqual(allowed, { ok: true });

  const rejected = await new GitCli(new ReviewRunner(
    "?? .harness/attempt-reviewer.json\n?? notes.txt\n",
  )).verifyReviewer({ worktree, expectedHeadSha: head, reportedHeadSha: head, allowedResultPaths });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.reason, /notes\.txt/);
});

test("trusted context is exported from the exact base SHA with Pi-compatible precedence", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-context-"));
  const repo = join(root, "repo");
  const attemptRoot = join(root, "state", "attempt-1");
  const runner = new SyncCommandRunner();
  const git = (...args: string[]): string => requireSuccess(runner.run("git", ["-C", repo, ...args]), `git ${args[0]}`);
  try {
    mkdirSync(repo);
    git("init", "--quiet");
    git("config", "user.email", "context@example.test");
    git("config", "user.name", "Context Test");
    writeFileSync(join(repo, "AGENTS.override.md"), "trusted override\n");
    writeFileSync(join(repo, "AGENTS.md"), "lower priority\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "trusted base");
    const baseSha = git("rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "AGENTS.override.md"), "candidate instruction\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "candidate");

    const cli = new GitCli(runner);
    const input = {
      localPath: repo,
      rootPath: attemptRoot,
      trustAnchorSha: baseSha,
      jobId: "job-1",
      attemptId: "reviewer-1",
      lane: "reviewer" as const,
      agentDir: join(root, "agent-dir"),
    };
    const context = await cli.prepareTrustedContext(input);
    assert.deepEqual(context.entries.map((entry) => entry.path), ["AGENTS.override.md"]);
    assert.equal(context.entries[0]?.sourceSha, baseSha);
    assert.match(readFileSync(context.bundlePath, "utf8"), /trusted override/);
    assert.equal(readFileSync(context.bundlePath, "utf8").includes("candidate instruction"), false);
    assert.match(readFileSync(context.bundlePath, "utf8"), /review subjects only/);
    assert.match(readFileSync(context.bundlePath, "utf8"), /reference from trusted policy.*does not grant.*instruction authority/i);
    assert.equal(lstatSync(context.bundlePath).mode & 0o222, 0);
    assert.deepEqual(await cli.prepareTrustedContext(input), context);

    chmodSync(context.bundlePath, 0o600);
    writeFileSync(context.bundlePath, "tampered\n");
    await assert.rejects(() => cli.verifyTrustedContext(context), /changed after preparation/);
  } finally {
    makeWritableForCleanup(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted context accepts an explicit empty manifest and rejects unsafe policy blobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-context-boundary-"));
  const repo = join(root, "repo");
  const runner = new SyncCommandRunner();
  const git = (...args: string[]): string => requireSuccess(runner.run("git", ["-C", repo, ...args]), `git ${args[0]}`);
  try {
    mkdirSync(repo);
    git("init", "--quiet");
    git("config", "user.email", "context@example.test");
    git("config", "user.name", "Context Test");
    writeFileSync(join(repo, "product.txt"), "base\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "empty policy");
    const cli = new GitCli(runner);
    const emptySha = git("rev-parse", "HEAD").trim();
    const empty = await cli.prepareTrustedContext({
      localPath: repo,
      rootPath: join(root, "state", "empty"),
      trustAnchorSha: emptySha,
      jobId: "job-1",
      attemptId: "worker-empty",
      lane: "worker",
      agentDir: join(root, "agent-dir"),
    });
    assert.deepEqual(empty.entries, []);
    assert.match(readFileSync(empty.bundlePath, "utf8"), /No trusted repository policy file/);

    symlinkSync("product.txt", join(repo, "AGENTS.override.md"), "file");
    git("add", ".");
    git("commit", "--quiet", "-m", "symlink policy");
    await assert.rejects(() => cli.prepareTrustedContext({
      localPath: repo,
      rootPath: join(root, "state", "symlink"),
      trustAnchorSha: git("rev-parse", "HEAD").trim(),
      jobId: "job-1",
      attemptId: "worker-symlink",
      lane: "worker",
      agentDir: join(root, "agent-dir"),
    }), /not a regular Git blob/);

    rmSync(join(repo, "AGENTS.override.md"));
    writeFileSync(join(repo, "AGENTS.override.md"), `unsafe\0${"x".repeat(128 * 1024)}`);
    git("add", ".");
    git("commit", "--quiet", "-m", "unsafe policy");
    await assert.rejects(() => cli.prepareTrustedContext({
      localPath: repo,
      rootPath: join(root, "state", "unsafe"),
      trustAnchorSha: git("rev-parse", "HEAD").trim(),
      jobId: "job-1",
      attemptId: "worker-unsafe",
      lane: "worker",
      agentDir: join(root, "agent-dir"),
    }), /contains NUL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reviewer preparation exports a read-only exact-HEAD snapshot and writable validation copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-review-workspace-"));
  const repo = join(root, "repo");
  const attemptRoot = join(root, "state", "attempt-1");
  const reviewAxisAgentPath = join(root, "review-axis.md");
  const fakePiPath = join(root, "fake-pi");
  const dockerConfig = join(root, "docker-config");
  const previousSecret = process.env.HERDR_REVIEWER_TEST_SECRET;
  const runner = new SyncCommandRunner();
  const git = (...args: string[]): string => requireSuccess(runner.run("git", ["-C", repo, ...args]), `git ${args[0]}`);
  try {
    mkdirSync(repo, { recursive: true });
    git("init", "--quiet");
    git("config", "user.email", "reviewer@example.test");
    git("config", "user.name", "Reviewer Test");
    writeFileSync(join(repo, "product.txt"), "base\n");
    git("add", "product.txt");
    git("commit", "--quiet", "-m", "base");
    const baseSha = git("rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "product.txt"), "head\n");
    git("add", "product.txt");
    git("commit", "--quiet", "-m", "head");
    const expectedHeadSha = git("rev-parse", "HEAD").trim();
    writeFileSync(reviewAxisAgentPath, "---\nname: herdr-harness-review-axis\ndescription: test\n---\nread only\n");
    writeFileSync(fakePiPath, "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '0.84.0\\n'; exit 0; fi\n: > \"$FAKE_PI_ARGS\"\nfor arg in \"$@\"; do printf '%s\\n' \"$arg\" >> \"$FAKE_PI_ARGS\"; done\n", { mode: 0o500 });
    chmodSync(fakePiPath, 0o500);
    mkdirSync(dockerConfig);
    mkdirSync(attemptRoot, { recursive: true });
    writeFileSync(join(attemptRoot, "trusted-context.md"), "preserve me\n");
    const input = {
      worktree: { path: repo, branch: "agent/issue-1", workspaceId: "w1" },
      rootPath: attemptRoot,
      resultPath: join(attemptRoot, "result.json"),
      jobId: "job-1",
      attemptId: "reviewer-1",
      taskDigest: "1".repeat(64),
      baseSha,
      expectedHeadSha,
      validationArgv: [
        "/usr/bin/env",
        `DOCKER_CONFIG=${dockerConfig}`,
        process.execPath,
        resolve("test/fixtures/reviewer-validation.js"),
        "--stdout-bytes", String(21 * 1024 * 1024),
        "--stderr-bytes", String(5 * 1024 * 1024),
      ],
      dockerHost: null,
      resourceDigest: "2".repeat(64),
      checkpointIdentity: {
        jobId: "job-1",
        sourceAttemptId: "reviewer-1",
        jobRevision: 7,
        taskDigest: "1".repeat(64),
        baseSha,
        reviewedHeadSha: expectedHeadSha,
        runtimeDigest: "3".repeat(64),
        providerDigest: "4".repeat(64),
        modelDigest: "5".repeat(64),
        resourceDigest: "2".repeat(64),
        repositoryContextBundleDigest: "6".repeat(64),
      },
      reviewAxisAgent: {
        kind: "agent" as const,
        path: reviewAxisAgentPath,
        digest: executionResourceDigest(reviewAxisAgentPath),
      },
      piExecutable: fakePiPath,
      piRuntimeVersion: "0.84.0",
      piAgentDir: join(root, "pi-agent"),
      prompt: "bounded Reviewer prompt",
      trustedContextPath: join(attemptRoot, "trusted-context.md"),
      reviewerSkillPath: reviewAxisAgentPath,
      contextBudgetBytes: REVIEWER_CONTEXT_BUDGET_BYTES,
      contextBudgetReserveBytes: REVIEWER_CONTEXT_BUDGET_RESERVE_BYTES,
    };

    const cli = new GitCli(runner);
    process.env.HERDR_REVIEWER_TEST_SECRET = "must-not-leak";
    const validation = await cli.runReviewerValidation(input);
    const validationReceipt = requireValidationCheckpoint(validation.receipt);
    assert.equal(validationReceipt.sourceAttemptId, "reviewer-1");
    assert.equal(validationReceipt.jobRevision, 7);
    assert.equal(validationReceipt.result.status, "passed");
    assert.equal(validationReceipt.result.stdout.byteCount, 21 * 1024 * 1024);
    assert.equal(validationReceipt.result.stderr.byteCount, 5 * 1024 * 1024);
    assert.equal(validationReceipt.result.stdout.truncated, true);
    assert.equal(validationReceipt.result.stderr.truncated, true);
    assert.equal(validationReceipt.result.stdout.redacted, true);
    assert.equal(validationReceipt.result.stderr.redacted, true);
    assert.equal(validationReceipt.result.stdout.text, "[redacted validation output]");
    assert.equal(validationReceipt.result.stderr.text, "[redacted validation output]");
    assert.match(validationReceipt.result.stdout.sha256, /^[0-9a-f]{64}$/);
    assert.match(validationReceipt.result.stderr.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(readdirSync(join(attemptRoot, "evidence")), []);
    const validationEnv = JSON.parse(readFileSync(join(attemptRoot, "workspace", "validation", "validation-env.json"), "utf8")) as Record<string, string>;
    assert.equal(validationEnv.HERDR_REVIEWER_TEST_SECRET, undefined);
    assert.equal(validationEnv.DOCKER_CONFIG, dockerConfig);
    assert.equal(validationEnv.HOME, join(attemptRoot, "workspace", "scratch", "home"));
    writeFileSync(join(attemptRoot, "workspace", "validation", "validation-only.txt"), "sentinel");
    assert.deepEqual(await cli.runReviewerValidation(input), validation);
    assert.equal(readFileSync(join(attemptRoot, "workspace", "validation", "validation-only.txt"), "utf8"), "sentinel");
    await assert.rejects(() => cli.verifyReviewerValidation({
      ...input,
      expectedHeadSha: "c".repeat(40),
      binding: validation.binding,
    }), /checkpoint identity drifted|receipt binding is invalid or drifted/);
    const failedRoot = join(root, "state", "attempt-failed");
    const failed = await cli.runReviewerValidation({
      ...input,
      rootPath: failedRoot,
      resultPath: join(failedRoot, "result.json"),
      attemptId: "reviewer-failed",
      checkpointIdentity: { ...input.checkpointIdentity, sourceAttemptId: "reviewer-failed" },
      validationArgv: [process.execPath, resolve("test/fixtures/reviewer-validation.js"), "--exit-code", "7"],
    });
    const failedReceipt = requireValidationCheckpoint(failed.receipt);
    assert.equal(failedReceipt.result.status, "failed-checks");
    assert.equal(failedReceipt.result.exitCode, 7);
    assert.equal(failedReceipt.result.error, null);
    const missingRoot = join(root, "state", "attempt-missing");
    const missing = await cli.runReviewerValidation({
      ...input,
      rootPath: missingRoot,
      resultPath: join(missingRoot, "result.json"),
      attemptId: "reviewer-missing",
      checkpointIdentity: { ...input.checkpointIdentity, sourceAttemptId: "reviewer-missing" },
      validationArgv: ["definitely-missing-review-command"],
    });
    const missingReceipt = requireValidationCheckpoint(missing.receipt);
    assert.equal(missingReceipt.result.status, "infrastructure-error");
    assert.match(missingReceipt.result.error ?? "", /executable is unavailable/);
    const timeoutRoot = join(root, "state", "attempt-timeout");
    const timedOut = await new GitCli(runner).runReviewerValidation({
      ...input,
      rootPath: timeoutRoot,
      resultPath: join(timeoutRoot, "result.json"),
      attemptId: "reviewer-timeout",
      checkpointIdentity: { ...input.checkpointIdentity, sourceAttemptId: "reviewer-timeout" },
      validationArgv: [process.execPath, resolve("test/fixtures/reviewer-validation.js"), "--sleep-ms", "200"],
      totalTimeoutMs: 25,
      sigtermGraceMs: 10,
      sigkillGraceMs: 10,
    });
    const timedOutReceipt = requireValidationCheckpoint(timedOut.receipt);
    assert.equal(timedOutReceipt.result.status, "infrastructure-error");
    assert.equal(timedOutReceipt.result.timeout, true);
    assert.match(timedOutReceipt.result.error ?? "", /attempt_deadline/);
    const validationProgress = JSON.parse(readFileSync(join(timeoutRoot, "runtime", "validation-progress.json"), "utf8")) as Record<string, unknown>;
    const { digest: validationProgressDigest, ...validationProgressBody } = validationProgress;
    assert.equal(validationProgressDigest, digest(validationProgressBody));
    assert.equal(validationProgress.lastProgressType, "validation_heartbeat");
    assert.ok(Number(validationProgress.eventCount) >= 2);
    assert.equal(existsSync(join(timeoutRoot, "runtime", "validation-terminate.json")), true);
    assert.equal(existsSync(join(timeoutRoot, "runtime", "validation-terminating.json")), true);
    assert.equal(existsSync(join(timeoutRoot, "runtime", "validation-terminated.json")), true);

    const killRoot = join(root, "state", "attempt-kill");
    const killed = await cli.runReviewerValidation({
      ...input,
      rootPath: killRoot,
      resultPath: join(killRoot, "result.json"),
      attemptId: "reviewer-kill",
      checkpointIdentity: { ...input.checkpointIdentity, sourceAttemptId: "reviewer-kill" },
      validationArgv: [process.execPath, resolve("test/fixtures/reviewer-validation.js"), "--sleep-ms", "10000", "--ignore-sigterm"],
      totalTimeoutMs: 2_000,
      noProgressTimeoutMs: 500,
      sigtermGraceMs: 50,
      sigkillGraceMs: 50,
    });
    const killedReceipt = requireValidationCheckpoint(killed.receipt);
    assert.equal(killedReceipt.result.timeout, true);
    assert.equal(killedReceipt.result.signal, "SIGKILL");
    assert.match(killedReceipt.result.error ?? "", /attempt_deadline/);
    const killedProgress = JSON.parse(readFileSync(join(killRoot, "runtime", "validation-progress.json"), "utf8")) as Record<string, unknown>;
    assert.equal(processAlive(Number(killedProgress.childPid)), false);

    const orphanRoot = join(root, "state", "attempt-orphan");
    const orphanPidPath = join(root, "validation-orphan.pid");
    const orphaned = await cli.runReviewerValidation({
      ...input,
      rootPath: orphanRoot,
      resultPath: join(orphanRoot, "result.json"),
      attemptId: "reviewer-orphan",
      checkpointIdentity: { ...input.checkpointIdentity, sourceAttemptId: "reviewer-orphan" },
      validationArgv: [process.execPath, resolve("test/fixtures/reviewer-validation.js"), "--spawn-orphan-pid-path", orphanPidPath],
      sigtermGraceMs: 50,
      sigkillGraceMs: 50,
    });
    assert.equal(requireValidationCheckpoint(orphaned.receipt).result.status, "passed");
    assert.equal(processAlive(Number(readFileSync(orphanPidPath, "utf8"))), false);
    const preparedInput = {
      ...input,
      validationSource: input,
      validationReceipt: validation.binding,
      checkpointInputs: [],
      checkpointSources: [],
    };
    const workspace = await cli.prepareReviewer(preparedInput);
    assert.equal(readFileSync(join(workspace.reviewPath, "product.txt"), "utf8"), "head\n");
    assert.equal(lstatSync(join(workspace.reviewPath, "product.txt")).mode & 0o222, 0);
    writeFileSync(join(attemptRoot, "workspace", "validation", "product.txt"), "validation mutation\n");
    assert.match(readFileSync(workspace.evidencePath, "utf8"), new RegExp(`Head SHA: ${expectedHeadSha}`));
    const descriptor = JSON.parse(readFileSync(join(attemptRoot, "workspace", "descriptor.json"), "utf8")) as {
      validationReceiptPath: string;
      validationReceiptDigest: string;
      checkpointIdentity: { sourceAttemptId: string; jobRevision: number; resourceDigest: string };
      checkpointInputs: unknown[];
      checkpointPaths: Record<string, string>;
      runtimePath: string;
      emptyAppendSystemPromptPath: string;
      piSubagentWrapperPath: string;
      piRuntimeVersion: string;
      privateEvidenceDir: string;
      initialContextBytes: number;
      contextBudgetBytes: number;
      contextBudgetReserveBytes: number;
    };
    assert.equal(descriptor.validationReceiptPath, validation.binding.path);
    assert.equal(descriptor.validationReceiptDigest, validation.binding.digest);
    assert.equal(descriptor.checkpointIdentity.sourceAttemptId, "reviewer-1");
    assert.equal(descriptor.checkpointIdentity.jobRevision, 7);
    assert.equal(descriptor.checkpointIdentity.resourceDigest, "2".repeat(64));
    assert.deepEqual(descriptor.checkpointInputs, []);
    assert.deepEqual(Object.values(descriptor.checkpointPaths).sort(), [
      join(attemptRoot, "reviewer-final.json"),
      join(attemptRoot, "reviewer-preflight.json"),
      join(attemptRoot, "spec-axis.json"),
      join(attemptRoot, "standards-axis.json"),
    ].sort());
    assert.equal(descriptor.runtimePath, join(attemptRoot, "workspace", "review-runtime"));
    assert.equal(descriptor.piRuntimeVersion, "0.84.0");
    assert.equal(descriptor.privateEvidenceDir, join(attemptRoot, "evidence"));
    assert.equal(lstatSync(descriptor.privateEvidenceDir).mode & 0o077, 0);
    assert.equal(descriptor.initialContextBytes, Buffer.byteLength(input.prompt)
      + readFileSync(input.trustedContextPath).byteLength + readFileSync(input.reviewerSkillPath).byteLength);
    assert.equal(descriptor.contextBudgetBytes, REVIEWER_CONTEXT_BUDGET_BYTES);
    assert.equal(descriptor.contextBudgetReserveBytes, REVIEWER_CONTEXT_BUDGET_RESERVE_BYTES);
    assert.equal(readFileSync(descriptor.emptyAppendSystemPromptPath, "utf8"), "");
    assert.match(readFileSync(descriptor.piSubagentWrapperPath, "utf8"), /--append-system-prompt/);
    assert.equal(lstatSync(descriptor.piSubagentWrapperPath).mode & 0o222, 0);
    assert.equal(Boolean(lstatSync(descriptor.piSubagentWrapperPath).mode & 0o111), true);
    const childArgsPath = join(root, "child-args.txt");
    const wrapped = spawnSync(descriptor.piSubagentWrapperPath, ["--mode", "json"], {
      env: { ...process.env, FAKE_PI_ARGS: childArgsPath },
      encoding: "utf8",
    });
    assert.equal(wrapped.status, 0);
    assert.deepEqual(readFileSync(childArgsPath, "utf8").trim().split("\n"), [
      "--append-system-prompt",
      descriptor.emptyAppendSystemPromptPath,
      "--mode",
      "json",
    ]);
    assert.equal(readFileSync(join(attemptRoot, "trusted-context.md"), "utf8"), "preserve me\n");
    assert.deepEqual(await new GitCli(runner).prepareReviewer(preparedInput), workspace);
    await assert.rejects(() => new GitCli(runner).prepareReviewer({
      ...preparedInput,
      prompt: "x".repeat(REVIEWER_CONTEXT_BUDGET_BYTES),
    }), /reviewer_context_budget_exceeded/);
    chmodSync(fakePiPath, 0o700);
    writeFileSync(fakePiPath, "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '0.85.0\\n'; exit 0; fi\nexit 0\n", { mode: 0o500 });
    chmodSync(fakePiPath, 0o500);
    const drifted = spawnSync(descriptor.piSubagentWrapperPath, [], { encoding: "utf8" });
    assert.equal(drifted.status, 70);
    assert.match(drifted.stderr, /Pi runtime version changed/);
    await assert.rejects(() => new GitCli(runner).prepareReviewer({
      ...preparedInput,
      rootPath: join(repo, "review-state"),
      resultPath: join(repo, "review-state", "result.json"),
    }), /outside the product worktree/);
    await assert.rejects(() => new GitCli(runner).prepareReviewer({
      ...preparedInput,
      rootPath: root,
      resultPath: join(root, "result.json"),
    }), /outside the product worktree/);
    const linkedState = join(repo, "linked-review-state");
    mkdirSync(linkedState);
    const stateLink = join(root, "state-link");
    symlinkSync(linkedState, stateLink, "dir");
    await assert.rejects(() => new GitCli(runner).prepareReviewer({
      ...preparedInput,
      rootPath: stateLink,
      resultPath: join(stateLink, "result.json"),
    }), /outside the product worktree/);
    symlinkSync("/tmp", join(repo, "escape"), "dir");
    git("add", "escape");
    git("commit", "--quiet", "-m", "candidate symlink");
    const symlinkRoot = join(root, "state", "attempt-symlink");
    await assert.rejects(() => cli.runReviewerValidation({
      ...input,
      rootPath: symlinkRoot,
      resultPath: join(symlinkRoot, "result.json"),
      attemptId: "reviewer-symlink",
      expectedHeadSha: git("rev-parse", "HEAD").trim(),
    }), /source snapshot contains a symbolic link/);
  } finally {
    if (previousSecret === undefined) delete process.env.HERDR_REVIEWER_TEST_SECRET;
    else process.env.HERDR_REVIEWER_TEST_SECRET = previousSecret;
    const sourcePath = join(attemptRoot, "workspace", "source");
    const productPath = join(sourcePath, "product.txt");
    for (const path of [
      join(attemptRoot, "workspace", "review-runtime"),
      join(attemptRoot, "workspace", "review-runtime", ".agents"),
      join(attemptRoot, "workspace", "subagent-config"),
      join(attemptRoot, "workspace", "subagent-config", "extensions"),
      join(attemptRoot, "workspace", "subagent-config", "extensions", "subagent"),
    ]) {
      if (existsSync(path)) chmodSync(path, 0o700);
    }
    if (existsSync(sourcePath)) chmodSync(sourcePath, 0o700);
    if (existsSync(productPath)) chmodSync(productPath, 0o600);
    makeWritableForCleanup(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reviewer checkpoints are reusable once only for the same bound work", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-review-checkpoint-"));
  const sourceIdentity: ReviewerCheckpointIdentity = {
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
  const checkpoint = {
    version: 1,
    ...sourceIdentity,
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
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "standards-axis.json"), `${JSON.stringify(checkpoint)}\n`, { mode: 0o400 });
    const cli = new GitCli();
    const consumerIdentity = { ...sourceIdentity, sourceAttemptId: "reviewer-2", jobRevision: 12 };
    const reusable = await cli.findReusableReviewerCheckpoints({
      source: { rootPath: root, identity: sourceIdentity },
      consumerIdentity,
      excludedDigests: [],
    });
    assert.deepEqual(reusable.map((binding) => binding.stage), ["standards-axis"]);
    const verified = await cli.verifyReviewerCheckpoints({
      bindings: reusable,
      sources: [{ rootPath: root, identity: sourceIdentity }],
      consumerIdentity,
    });
    assert.deepEqual(verified.map((record) => record.checkpoint.stage), ["standards-axis"]);
    assert.deepEqual(await cli.findReusableReviewerCheckpoints({
      source: { rootPath: root, identity: sourceIdentity },
      consumerIdentity,
      excludedDigests: [reusable[0]!.digest],
    }), []);
    assert.deepEqual(await cli.findReusableReviewerCheckpoints({
      source: { rootPath: root, identity: sourceIdentity },
      consumerIdentity: { ...consumerIdentity, reviewedHeadSha: "c".repeat(40) },
      excludedDigests: [],
    }), []);
    assert.deepEqual(await cli.findReusableReviewerCheckpoints({
      source: { rootPath: root, identity: sourceIdentity },
      consumerIdentity: { ...consumerIdentity, resourceDigest: "a".repeat(64) },
      excludedDigests: [],
    }), []);
    chmodSync(join(root, "standards-axis.json"), 0o600);
    await assert.rejects(() => cli.verifyReviewerCheckpoints({
      bindings: reusable,
      sources: [{ rootPath: root, identity: sourceIdentity }],
      consumerIdentity,
    }), /not immutable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeWritableForCleanup(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chmodSync(path, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
  if (stat.isDirectory()) for (const name of readdirSync(path)) makeWritableForCleanup(join(path, name));
}

test("Worker Git verification rejects untracked files outside Harness results", async () => {
  const input = {
    worktree,
    branch: worktree.branch,
    baseSha: "a".repeat(40),
    reportedHeadSha: head,
    expectedRemoteHeadSha: null,
    allowedResultPaths: ["/repo/.harness/attempt-worker.json"],
  };

  const allowed = await new GitCli(new WorkerRunner(
    head,
    null,
    "?? .harness/attempt-worker.json\n",
  )).verifyWorker(input);
  assert.deepEqual(allowed, { ok: true, headSha: head });

  const rejected = await new GitCli(new WorkerRunner(
    head,
    null,
    "?? .harness/attempt-worker.json\n?? investigations/issue_33/__pycache__/probe.pyc\n",
  )).verifyWorker(input);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.reason, /probe\.pyc/);
});

test("post-PR Worker verification requires the remote branch to remain on the reviewed anchor", async () => {
  const publishedHead = "b".repeat(40);
  const reworkedHead = "c".repeat(40);
  const input = {
    worktree,
    branch: worktree.branch,
    baseSha: publishedHead,
    reportedHeadSha: reworkedHead,
    expectedRemoteHeadSha: publishedHead,
    allowedResultPaths: [],
  };

  const accepted = await new GitCli(new WorkerRunner(reworkedHead, publishedHead)).verifyWorker(input);
  assert.deepEqual(accepted, { ok: true, headSha: reworkedHead });

  const drifted = await new GitCli(new WorkerRunner(reworkedHead, "d".repeat(40))).verifyWorker(input);
  assert.equal(drifted.ok, false);
  if (!drifted.ok) assert.match(drifted.reason, /remote branch .* differs from reviewed anchor/);

  const premature = await new GitCli(new WorkerRunner(reworkedHead, publishedHead)).verifyWorker({
    ...input,
    expectedRemoteHeadSha: null,
  });
  assert.equal(premature.ok, false);
  if (!premature.ok) assert.match(premature.reason, /pushed the branch before review/);
});

test("base refresh merges a newer base locally without moving the reviewed remote branch", async () => {
  const fixture = baseSyncFixture(false);
  try {
    const cli = new GitCli(fixture.runner);
    const latestBaseSha = await cli.refreshBase(fixture.repo, "main");
    const result = await cli.syncBase({
      worktree: { path: fixture.repo, branch: fixture.branch, workspaceId: "w1" },
      branch: fixture.branch,
      baseRef: "main",
      expectedHeadSha: fixture.issueHead,
      expectedRemoteHeadSha: fixture.issueHead,
      latestBaseSha,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.headSha !== fixture.issueHead);
    fixture.git("merge-base", "--is-ancestor", fixture.issueHead, result.headSha);
    fixture.git("merge-base", "--is-ancestor", latestBaseSha, result.headSha);
    assert.equal(fixture.git("ls-remote", "--heads", "origin", fixture.branch).split(/\s+/, 1)[0], fixture.issueHead);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("base refresh aborts a conflict and preserves the reviewed HEAD", async () => {
  const fixture = baseSyncFixture(true);
  try {
    const cli = new GitCli(fixture.runner);
    const result = await cli.syncBase({
      worktree: { path: fixture.repo, branch: fixture.branch, workspaceId: "w1" },
      branch: fixture.branch,
      baseRef: "main",
      expectedHeadSha: fixture.issueHead,
      expectedRemoteHeadSha: fixture.issueHead,
      latestBaseSha: await cli.refreshBase(fixture.repo, "main"),
    });

    assert.deepEqual(result.ok, false);
    if (result.ok) return;
    assert.equal(result.class, "agent_decision");
    assert.equal(fixture.git("rev-parse", "HEAD").trim(), fixture.issueHead);
    assert.equal(fixture.git("status", "--porcelain", "--untracked-files=no"), "");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

class ReviewRunner implements CommandRunner {
  constructor(private readonly status: string) {}

  run(_command: string, args: string[]): CommandResult {
    const operation = args[2];
    if (operation === "rev-parse") return ok(`${head}\n`);
    if (operation === "status") return ok(args.includes("--untracked-files=no") ? "" : this.status);
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  }
}

class WorkerRunner implements CommandRunner {
  constructor(
    private readonly localHead: string,
    private readonly remoteHead: string | null,
    private readonly status = "",
  ) {}

  run(_command: string, args: string[]): CommandResult {
    const operation = args[2];
    if (operation === "rev-parse") return ok(`${this.localHead}\n`);
    if (operation === "branch") return ok(`${worktree.branch}\n`);
    if (operation === "merge-base") return ok("");
    if (operation === "rev-list") return ok("1\n");
    if (operation === "status") return ok(args.includes("--untracked-files=no") ? "" : this.status);
    if (operation === "ls-remote") {
      return ok(this.remoteHead ? `${this.remoteHead}\trefs/heads/${worktree.branch}\n` : "");
    }
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  }
}

function ok(stdout: string): CommandResult {
  return { ok: true, code: 0, stdout, stderr: "", error: null };
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function baseSyncFixture(conflict: boolean): {
  root: string;
  repo: string;
  branch: string;
  issueHead: string;
  runner: SyncCommandRunner;
  git: (...args: string[]) => string;
} {
  const root = mkdtempSync(join(tmpdir(), "herdr-base-sync-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const branch = "agent/issue-1";
  const runner = new SyncCommandRunner();
  requireSuccess(runner.run("git", ["init", "--bare", "--quiet", origin]), "git init bare");
  mkdirSync(repo);
  requireSuccess(runner.run("git", ["-C", repo, "init", "--quiet"]), "git init");
  const git = (...args: string[]): string => requireSuccess(runner.run("git", ["-C", repo, ...args]), `git ${args[0]}`);
  git("config", "user.email", "controller@example.test");
  git("config", "user.name", "Controller Test");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git("add", "shared.txt");
  git("commit", "--quiet", "-m", "base");
  git("branch", "-M", "main");
  git("remote", "add", "origin", origin);
  git("push", "--quiet", "-u", "origin", "main");

  git("switch", "--quiet", "-c", branch);
  writeFileSync(join(repo, conflict ? "shared.txt" : "issue.txt"), "issue\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "issue");
  const issueHead = git("rev-parse", "HEAD").trim();
  git("push", "--quiet", "-u", "origin", branch);

  git("switch", "--quiet", "main");
  writeFileSync(join(repo, conflict ? "shared.txt" : "main.txt"), "main\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "advance main");
  git("push", "--quiet", "origin", "main");
  git("switch", "--quiet", branch);
  return { root, repo, branch, issueHead, runner, git };
}
