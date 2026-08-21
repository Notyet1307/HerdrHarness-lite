/**
 * Process signal latch used by long-running foreground loops. A signal interrupts
 * the current poll sleep, allowing surrounding finally blocks to release leases
 * and heartbeat processes instead of relying on stale-lease recovery.
 */
export class ShutdownSignal {
  private requestedValue = false;
  private readonly waiters = new Set<() => void>();

  get requested(): boolean {
    return this.requestedValue;
  }

  request(): void {
    if (this.requestedValue) return;
    this.requestedValue = true;
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  wait(milliseconds: number): Promise<boolean> {
    if (!Number.isInteger(milliseconds) || milliseconds < 0) {
      throw new Error("shutdown wait must be a non-negative integer");
    }
    if (this.requestedValue) return Promise.resolve(true);
    return new Promise((resolveWait) => {
      let settled = false;
      let timer: unknown = null;
      const finish = (interrupted: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        this.waiters.delete(onShutdown);
        resolveWait(interrupted);
      };
      const onShutdown = (): void => finish(true);
      this.waiters.add(onShutdown);
      timer = setTimeout(() => finish(false), milliseconds);
    });
  }
}

export function installProcessShutdownSignal(): ShutdownSignal {
  const signal = new ShutdownSignal();
  process.on("SIGINT", () => signal.request());
  process.on("SIGTERM", () => signal.request());
  return signal;
}
