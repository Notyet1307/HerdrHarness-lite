import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateHarnessConfig } from "../src/controller/config-validation.js";

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
