export const OBSERVER_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000] as const;

export function scheduleObserverRetry(entry: { attempts: number; nextAttemptAt: number }, now = Date.now()): void {
  entry.attempts += 1;
  entry.nextAttemptAt = now + OBSERVER_RETRY_DELAYS_MS[Math.min(entry.attempts - 1, OBSERVER_RETRY_DELAYS_MS.length - 1)]!;
}
