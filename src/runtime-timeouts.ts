import type { Attempt, ExecutionSnapshot, RuntimeTimeouts } from "./model.js";
import type { HarnessConfig } from "./ports.js";

export const DEFAULT_WORKER_TIMEOUTS = {
  totalTimeoutMs: 90 * 60 * 1000,
  noProgressTimeoutMs: 15 * 60 * 1000,
} as const;
export const DEFAULT_REVIEWER_TIMEOUTS = {
  totalTimeoutMs: 45 * 60 * 1000,
  noProgressTimeoutMs: 10 * 60 * 1000,
} as const;
export const DEFAULT_VALIDATION_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_TERMINATION_TIMEOUTS = {
  sigtermGraceMs: 10_000,
  sigkillGraceMs: 5_000,
} as const;
export const MAX_TIMEOUT_MS = 2_147_483_647;

export function configuredRuntimeTimeouts(config: HarnessConfig, lane: Attempt["lane"]): RuntimeTimeouts {
  const defaults = lane === "worker" ? DEFAULT_WORKER_TIMEOUTS : DEFAULT_REVIEWER_TIMEOUTS;
  const configured = lane === "worker" ? config.worker : config.reviewer;
  return {
    totalTimeoutMs: configured?.totalTimeoutMs ?? defaults.totalTimeoutMs,
    noProgressTimeoutMs: configured?.noProgressTimeoutMs ?? defaults.noProgressTimeoutMs,
    sigtermGraceMs: config.termination?.sigtermGraceMs ?? DEFAULT_TERMINATION_TIMEOUTS.sigtermGraceMs,
    sigkillGraceMs: config.termination?.sigkillGraceMs ?? DEFAULT_TERMINATION_TIMEOUTS.sigkillGraceMs,
  };
}

export function snapshotRuntimeTimeouts(snapshot: ExecutionSnapshot, lane: Attempt["lane"]): RuntimeTimeouts {
  const defaults = lane === "worker" ? DEFAULT_WORKER_TIMEOUTS : DEFAULT_REVIEWER_TIMEOUTS;
  return snapshot.runtimeTimeouts ?? { ...defaults, ...DEFAULT_TERMINATION_TIMEOUTS };
}

export function configuredValidationTimeoutMs(config: HarnessConfig): number {
  return config.validation?.totalTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
}

export function validTimeoutMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_TIMEOUT_MS;
}
