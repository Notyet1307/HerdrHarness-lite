import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFleetConfig } from "../src/fleet/config.js";

test("Fleet config rejects unknown keys before producing runtime authority", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-config-"));
  try {
    const path = join(root, "fleet.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      stateDir: join(root, "state"),
      projects: [],
      unexpected: true,
    }));
    assert.throws(() => loadFleetConfig(path), /unsupported keys: unexpected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Fleet project enabled flag must be boolean", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-config-"));
  try {
    const path = join(root, "fleet.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      stateDir: join(root, "state"),
      projects: [{ id: "api", config: "missing.json", enabled: "yes" }],
    }));
    assert.throws(() => loadFleetConfig(path), /projects\[0\]\.enabled must be boolean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
