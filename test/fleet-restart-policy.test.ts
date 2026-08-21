import test from "node:test";
import assert from "node:assert/strict";
import { decideRestart } from "../src/fleet/restart-policy.js";

const policy = {
  initialBackoffMs: 1_000,
  maxBackoffMs: 8_000,
  maxRestarts: 3,
  windowMs: 60_000,
  stableAfterMs: 30_000,
};

test("restart policy applies bounded exponential backoff and then trips", () => {
  const first = decideRestart({ policy, timestamps: [], now: 100_000, runtimeMs: 1_000 });
  assert.equal(first.kind, "restart");
  if (first.kind !== "restart") return;
  assert.equal(first.backoffMs, 1_000);

  const second = decideRestart({ policy, timestamps: first.timestamps, now: 101_000, runtimeMs: 1_000 });
  assert.equal(second.kind, "restart");
  if (second.kind !== "restart") return;
  assert.equal(second.backoffMs, 2_000);

  const third = decideRestart({ policy, timestamps: second.timestamps, now: 103_000, runtimeMs: 1_000 });
  assert.equal(third.kind, "restart");
  if (third.kind !== "restart") return;
  assert.equal(third.backoffMs, 4_000);

  const fourth = decideRestart({ policy, timestamps: third.timestamps, now: 107_000, runtimeMs: 1_000 });
  assert.equal(fourth.kind, "trip");
});

test("stable runtime clears the short-failure history", () => {
  const decision = decideRestart({
    policy,
    timestamps: [90_000, 95_000, 99_000],
    now: 130_000,
    runtimeMs: 31_000,
  });
  assert.equal(decision.kind, "restart");
  if (decision.kind !== "restart") return;
  assert.equal(decision.timestamps.length, 1);
  assert.equal(decision.backoffMs, 1_000);
});
