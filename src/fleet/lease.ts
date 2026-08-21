import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ProcessLeaseObservation =
  | { status: "absent" }
  | { status: "alive"; pid: number; acquiredAt: string; instanceId: string }
  | { status: "stale"; pid: number; acquiredAt: string; instanceId: string }
  | { status: "malformed"; error: string };

type Lease = { version: 1; instanceId: string; pid: number; acquiredAt: string };

export function fleetLeasePath(stateDir: string): string {
  return join(stateDir, "fleet-supervisor-lease.json");
}

export function controllerLeasePathForProject(stateDir: string): string {
  return join(stateDir, "controller-lease.json");
}

export function acquireFleetLease(stateDir: string): { stop(): void } {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = fleetLeasePath(stateDir);
  const lease: Lease = { version: 1, instanceId: randomUUID(), pid: process.pid, acquiredAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(lease)}\n`, { encoding: "utf8" });
      } catch (error) {
        closeSync(fd);
        try { unlinkSync(path); } catch { /* The next acquisition fails closed if cleanup cannot complete. */ }
        throw error;
      }
      closeSync(fd);
      return { stop: () => release(path, lease.instanceId) };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const observed = observeLeasePath(path);
      if (observed.status === "alive") {
        throw new Error(`Fleet Supervisor lease is held by pid ${observed.pid} since ${observed.acquiredAt}: ${path}`);
      }
      if (observed.status === "malformed") throw new Error(`Fleet Supervisor lease is malformed: ${observed.error}`);
      if (observed.status === "absent") continue;
      const confirmed = observeLeasePath(path);
      if (confirmed.status !== "stale" || confirmed.instanceId !== observed.instanceId) continue;
      try { unlinkSync(path); } catch (unlinkError) { if (errorCode(unlinkError) !== "ENOENT") throw unlinkError; }
    }
  }
  throw new Error(`Fleet Supervisor lease changed while acquiring: ${path}`);
}

export function observeProjectControllerLease(stateDir: string): ProcessLeaseObservation {
  return observeLeasePath(controllerLeasePathForProject(stateDir));
}

export function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) !== "ESRCH"; }
}

function observeLeasePath(path: string): ProcessLeaseObservation {
  if (!existsSync(path)) return { status: "absent" };
  try {
    const lease = parseLease(path);
    return processIsAlive(lease.pid) ? { status: "alive", ...lease } : { status: "stale", ...lease };
  } catch (error) {
    return { status: "malformed", error: error instanceof Error ? error.message : String(error) };
  }
}

function parseLease(path: string): Omit<Lease, "version"> {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Lease>;
  if (value.version !== 1 || typeof value.instanceId !== "string" || !value.instanceId
    || !Number.isInteger(value.pid) || (value.pid ?? 0) < 1
    || typeof value.acquiredAt !== "string" || !Number.isFinite(Date.parse(value.acquiredAt))) {
    throw new Error(`invalid lease at ${path}`);
  }
  return { instanceId: value.instanceId, pid: value.pid, acquiredAt: value.acquiredAt } as Omit<Lease, "version">;
}

function release(path: string, instanceId: string): void {
  if (!existsSync(path)) return;
  const current = parseLease(path);
  if (current.instanceId !== instanceId) throw new Error(`Fleet Supervisor lease ownership changed before release: ${path}`);
  unlinkSync(path);
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}
