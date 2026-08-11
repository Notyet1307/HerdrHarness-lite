import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEvidence } from "../src/adapters/local-evidence.js";
import type { CommandRunner } from "../src/adapters/command.js";
import type { Job } from "../src/model.js";

test("advanced evidence separates dirty worktree progress and exposes only safe runtime receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-evidence-"));
  try {
    const stateDir = join(root, "state");
    const worktree = join(root, "worktree");
    const attemptId = "worker-attempt-1";
    const jobId = "job-1";
    const runtime = join(stateDir, "worker-attempts", jobId, attemptId, "runtime");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, "ready.json"), JSON.stringify({
      version: 1,
      attemptId,
      ok: true,
      credentialMode: "canonical-oauth",
      accessToken: "MUST_NOT_LEAK",
    }));
    writeFileSync(join(runtime, "terminal.json"), JSON.stringify({
      version: 1,
      attemptId,
      ok: false,
      error: "network access_token_MUST_NOT_LEAK",
      failureDomain: "provider",
      failureCode: "provider_network",
      retryable: true,
      phase: "tool_error_recovery",
    }));

    const outputs = new Map([
      ["status --short --branch", "## agent/test\nM  staged.ts\n M unstaged.ts\n?? note.md\n"],
      ["diff --stat aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa...HEAD", ""],
      ["diff --cached --stat", " staged.ts | 10 ++++++++++\n"],
      ["diff --cached --name-status", "M\tstaged.ts\n"],
      ["diff --stat", " unstaged.ts | 2 ++\n"],
      ["diff --name-status", "M\tunstaged.ts\n"],
      ["ls-files --others --exclude-standard", "note.md\n"],
    ]);
    const runner: CommandRunner = {
      run: (_command, args) => ({
        ok: true,
        code: 0,
        stdout: outputs.get(args.slice(2).join(" ")) ?? "",
        stderr: "",
        error: null,
      }),
    };
    const attempt = {
      id: attemptId,
      lane: "worker",
      phase: "settled",
      round: 1,
      baseSha: "a".repeat(40),
      expectedHeadSha: null,
      resultPath: join(worktree, ".harness", "result.json"),
      promptDigest: "b".repeat(64),
      handle: null,
      result: null,
      startedAt: "2026-08-11T00:00:00.000Z",
      completedAt: "2026-08-11T00:05:00.000Z",
    } as const;
    const job = {
      id: jobId,
      revision: 10,
      state: "blocked",
      baseSha: "a".repeat(40),
      headSha: null,
      branch: "agent/test",
      reviewRound: 1,
      ciReworkCount: 0,
      lastError: "provider network",
      worktree: { workspaceId: "w", path: worktree, branch: "agent/test" },
      task: { digest: "d".repeat(64) },
      incident: null,
      ciFailure: null,
      activeAttempt: attempt,
      attempts: [attempt],
    } as unknown as Job;

    const evidence = new LocalEvidence(runner, stateDir);
    const initial = await evidence.initial(job);
    const progress = initial.items.find((entry) => entry.ref === "worktree-progress");
    assert.ok(progress);
    assert.match(progress.summary, /staged\.ts/);
    assert.match(progress.summary, /unstaged\.ts/);
    assert.match(progress.summary, /note\.md/);

    const [runtimeEvidence] = await evidence.collect(job, [{
      kind: "attempt_runtime",
      path: null,
      reason: "Inspect safe runtime receipts.",
    }]);
    assert.ok(runtimeEvidence);
    assert.match(runtimeEvidence.summary, /provider_network/);
    assert.match(runtimeEvidence.summary, /canonical-oauth/);
    assert.equal(runtimeEvidence.summary.includes("MUST_NOT_LEAK"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
