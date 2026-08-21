import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStateStore } from "../src/adapters/json-store.js";

test("authoritative state commit is not reported as failed when audit append degrades", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-json-store-audit-"));
  try {
    mkdirSync(join(root, "events.jsonl"), { recursive: true });
    const store = new JsonStateStore(root);
    const state = { version: 1 as const, activeJob: null, terminalJobs: [] };
    await store.save(state, null);
    assert.deepEqual(await store.load(), state);
    const degradationPath = join(root, "events.degraded.json");
    assert.equal(existsSync(degradationPath), true);
    assert.match(readFileSync(degradationPath, "utf8"), /stateCommittedAt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
