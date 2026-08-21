import type { FleetRestartPolicy } from "./types.js";

export type RestartDecision =
  | { kind: "restart"; timestamps: number[]; backoffMs: number; nextStartAt: number }
  | { kind: "trip"; timestamps: number[] };

export function decideRestart(input: {
  policy: FleetRestartPolicy;
  timestamps: number[];
  now: number;
  runtimeMs: number;
}): RestartDecision {
  const history = input.runtimeMs >= input.policy.stableAfterMs
    ? []
    : input.timestamps.filter((timestamp) => timestamp >= input.now - input.policy.windowMs);
  const timestamps = [...history, input.now];
  if (timestamps.length > input.policy.maxRestarts) return { kind: "trip", timestamps };
  const exponent = Math.max(0, timestamps.length - 1);
  const backoffMs = Math.min(
    input.policy.maxBackoffMs,
    input.policy.initialBackoffMs * (2 ** exponent),
  );
  return { kind: "restart", timestamps, backoffMs, nextStartAt: input.now + backoffMs };
}

export function parseRestartTimestamps(values: string[]): number[] {
  return values
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
}
