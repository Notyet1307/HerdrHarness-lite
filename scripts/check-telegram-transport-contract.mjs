#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const harnessRoot = resolve(import.meta.dirname, "..");
const bridgeRoot = resolve(process.argv[2] ?? resolve(harnessRoot, "../harness-telegram-bridge"));
const files = [
  "schemas/telegram-transport-v2.schema.json",
  "test/fixtures/telegram-transport-v2/project-view.json",
  "test/fixtures/telegram-transport-v2/fleet-view.json",
  "test/fixtures/telegram-transport-v2/diagnostic-view.json",
  "test/fixtures/telegram-transport-v2/event-provider-transient.json",
  "test/fixtures/telegram-transport-v2/event-controller-down.json",
  "test/fixtures/telegram-transport-v2/event-project-tripped.json",
  "test/fixtures/telegram-transport-v2/approval-card.json",
  "test/fixtures/telegram-transport-v2/manifest.json",
];
const digests = {};
for (const file of files) {
  const harness = readFileSync(resolve(harnessRoot, file));
  const bridge = readFileSync(resolve(bridgeRoot, file));
  const harnessDigest = sha256(harness);
  const bridgeDigest = sha256(bridge);
  if (harnessDigest !== bridgeDigest) throw new Error(`Transport contract differs: ${file}`);
  digests[file] = harnessDigest;
}
process.stdout.write(`${JSON.stringify({ ok: true, version: 2, bridgeRoot, digests }, null, 2)}\n`);

function sha256(value) {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}
