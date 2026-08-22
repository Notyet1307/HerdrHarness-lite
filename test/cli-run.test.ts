import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { validReviewerArgv, validWorkerArgv } from "./fakes.js";

test("long-running Controller retries a transient preflight failure", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-cli-run-"));
  try {
    const bin = join(root, "bin");
    const source = join(root, "source");
    const stateDir = join(root, "state");
    const worktreeRoot = join(root, "worktrees");
    const agentDir = join(root, "pi-agent");
    const configPath = join(root, "harness.json");
    for (const path of [bin, source, stateDir, worktreeRoot, agentDir]) mkdirSync(path, { recursive: true });

    executable(join(bin, "gh"), [
      "#!/usr/bin/env node",
      `process.stdout.write(${JSON.stringify(JSON.stringify([{
        number: 1,
        title: "Transient provider retry",
        body: "",
        state: "OPEN",
        updatedAt: "2026-08-10T00:00:00Z",
        labels: [{ name: "ready-for-agent" }],
        assignees: [],
        blockedBy: { nodes: [] },
        parent: null,
        subIssues: { nodes: [] },
      }]))});`,
    ].join("\n"));
    executable(join(bin, "pi"), [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) process.stdout.write('0.84.0\\n');",
      "else { process.stderr.write('provider temporarily unavailable\\n'); process.exitCode = 1; }",
    ].join("\n"));

    writeFileSync(configPath, JSON.stringify({
      repo: "owner/repo",
      localPath: source,
      stateDir,
      baseRef: "main",
      readyLabel: "ready-for-agent",
      claimLabel: "agent:claimed",
      worktreeRoot,
      maxReviewRounds: 3,
      maxAnalystTurns: 3,
      reviewerValidationArgv: [process.execPath, "--version"],
      workerArgv: validWorkerArgv,
      reviewerArgv: validReviewerArgv,
      preflight: { piBin: "pi", dockerRequired: false },
      herdr: { bin: "herdr", session: "test" },
      analyst: { command: process.execPath },
    }), { mode: 0o600 });

    const run = spawnSync(process.execPath, [
      resolve("dist/src/cli.js"), "run", "--config", configPath, "--poll-ms", "100", "--max-cycles", "2",
    ], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        PI_CODING_AGENT_DIR: agentDir,
      },
    });
    assert.equal(run.status, 1, run.stderr);
    const cycles = run.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(cycles.map((cycle) => cycle.cycle), [1, 2]);
    assert.ok(cycles.every((cycle) => cycle.action === "preflight_failed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight command reports bounded success and failure without creating a ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-cli-preflight-"));
  try {
    const bin = join(root, "bin");
    const source = join(root, "source");
    const stateDir = join(root, "state");
    const worktreeRoot = join(root, "worktrees");
    const agentDir = join(root, "pi-agent");
    const configPath = join(root, "harness.json");
    for (const path of [bin, source, stateDir, worktreeRoot, agentDir]) mkdirSync(path, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
    executable(join(bin, "pi"), [
      "#!/usr/bin/env node",
      "process.stdout.write('HERDR_HARNESS_PROVIDER_OK\\n');",
    ].join("\n"));
    writeFileSync(configPath, JSON.stringify({
      repo: "owner/repo",
      localPath: source,
      stateDir,
      baseRef: "main",
      readyLabel: "ready-for-agent",
      claimLabel: "agent:claimed",
      worktreeRoot,
      maxReviewRounds: 3,
      maxAnalystTurns: 3,
      reviewerValidationArgv: [process.execPath, "--version"],
      workerArgv: validWorkerArgv,
      reviewerArgv: validReviewerArgv,
      preflight: { piBin: "pi", dockerRequired: false },
      herdr: { bin: "herdr", session: "test" },
      analyst: { command: process.execPath },
    }), { mode: 0o600 });
    const env = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      PI_CODING_AGENT_DIR: agentDir,
    };

    const passed = spawnSync(process.execPath, [
      resolve("dist/src/cli.js"), "preflight", "--config", configPath, "--lane", "worker", "--json",
    ], { encoding: "utf8", timeout: 10_000, env });
    assert.equal(passed.status, 0, passed.stderr);
    const passReport = JSON.parse(passed.stdout);
    assert.equal(passReport.version, 1);
    assert.equal(passReport.ok, true);
    assert.deepEqual(passReport.lanes, ["worker"]);
    assert.match(passReport.configDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(passReport.docker, { required: false, available: null });
    assert.equal(existsSync(join(stateDir, "state.json")), false);

    executable(join(bin, "pi"), [
      "#!/usr/bin/env node",
      "process.stderr.write('access_token_PREFLIGHT_SENTINEL\\n');",
      "process.exitCode = 1;",
    ].join("\n"));
    const failed = spawnSync(process.execPath, [
      resolve("dist/src/cli.js"), "preflight", "--config", configPath, "--lane", "worker", "--json",
    ], { encoding: "utf8", timeout: 10_000, env });
    assert.equal(failed.status, 1);
    const failReport = JSON.parse(failed.stdout);
    assert.equal(failReport.ok, false);
    assert.deepEqual(failReport.failure, { code: "oauth_probe_failed", retryable: false });
    assert.equal(`${failed.stdout}${failed.stderr}`.includes("PREFLIGHT_SENTINEL"), false);
    assert.equal(existsSync(join(stateDir, "state.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function executable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o700 });
  chmodSync(path, 0o700);
}
