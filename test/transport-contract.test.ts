import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { telegramTransportGoldenFixtures } from "../src/transport/golden-fixtures.js";
import { TELEGRAM_TRANSPORT_VERSION } from "../src/transport/telegram-protocol.js";

test("Harness generates the committed Transport v2 golden fixtures", () => {
  const directory = resolve("test/fixtures/telegram-transport-v2");
  const fixtures = telegramTransportGoldenFixtures();
  assert.deepEqual(Object.keys(fixtures).sort(), [
    "approval-card.json",
    "diagnostic-view.json",
    "event-controller-down.json",
    "event-project-tripped.json",
    "event-provider-transient.json",
    "fleet-view.json",
    "project-view.json",
  ]);
  for (const [name, expected] of Object.entries(fixtures)) {
    const raw = readFileSync(resolve(directory, name), "utf8");
    assert.deepEqual(JSON.parse(raw), expected, name);
    assert.equal(expected.version, TELEGRAM_TRANSPORT_VERSION);
    assert.equal(raw.includes("<b>"), false);
  }

  const schemaRaw = readFileSync(resolve("schemas/telegram-transport-v2.schema.json"), "utf8");
  const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.version, TELEGRAM_TRANSPORT_VERSION);
  assert.equal(manifest.schemaSha256, sha256(schemaRaw));
  assert.deepEqual(manifest.fixtures, Object.fromEntries(Object.keys(fixtures).sort().map((name) => [
    name,
    sha256(readFileSync(resolve(directory, name), "utf8")),
  ])));
});

function sha256(value: string): string {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}
