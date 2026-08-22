#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { telegramTransportGoldenFixtures } from "../dist/src/transport/golden-fixtures.js";

const root = resolve(import.meta.dirname, "..");
const fixtureDir = resolve(root, "test/fixtures/telegram-transport-v2");
const schemaPath = resolve(root, "schemas/telegram-transport-v2.schema.json");
const write = process.argv.includes("--write");
const fixtures = telegramTransportGoldenFixtures();
const expected = Object.fromEntries(Object.entries(fixtures).map(([name, value]) => [name, `${JSON.stringify(value)}\n`]));
const manifest = {
  version: 2,
  schemaSha256: sha256(readFileSync(schemaPath, "utf8")),
  fixtures: Object.fromEntries(Object.keys(expected).sort().map((name) => [name, sha256(expected[name])])),
};
expected["manifest.json"] = `${JSON.stringify(manifest, null, 2)}\n`;

if (write) {
  mkdirSync(fixtureDir, { recursive: true });
  for (const [name, value] of Object.entries(expected)) writeFileSync(resolve(fixtureDir, name), value);
  process.stdout.write(`${JSON.stringify({ ok: true, action: "fixtures_written", files: Object.keys(expected).length })}\n`);
} else {
  for (const [name, value] of Object.entries(expected)) {
    const path = resolve(fixtureDir, name);
    if (!existsSync(path) || readFileSync(path, "utf8") !== value) throw new Error(`Transport fixture drift: ${path}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, action: "fixtures_verified", schemaSha256: manifest.schemaSha256 })}\n`);
}

function sha256(value) {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}
