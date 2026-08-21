import test from "node:test";
import assert from "node:assert/strict";
import { ShutdownSignal } from "../src/shutdown-signal.js";

test("shutdown signal interrupts a pending poll sleep", async () => {
  const signal = new ShutdownSignal();
  const wait = signal.wait(10_000);
  signal.request();
  assert.equal(await wait, true);
  assert.equal(signal.requested, true);
  assert.equal(await signal.wait(10_000), true);
});

test("shutdown signal wait expires normally without a request", async () => {
  const signal = new ShutdownSignal();
  assert.equal(await signal.wait(5), false);
  assert.equal(signal.requested, false);
});
