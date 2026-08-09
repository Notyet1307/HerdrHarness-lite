import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type ControllerLease = {
  version: 1;
  instanceId: string;
  pid: number;
  acquiredAt: string;
};

export function controllerLeasePath(stateDir: string): string {
  return join(stateDir, "controller-lease.json");
}

/** Excludes concurrent run/tick processes before either can perform an external effect. */
export function acquireControllerLease(stateDir: string): { stop(): void } {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = controllerLeasePath(stateDir);
  const lease: ControllerLease = {
    version: 1,
    instanceId: randomUUID(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(lease)}\n`, { encoding: "utf8" });
      } catch (error) {
        closeSync(fd);
        try {
          unlinkSync(path);
        } catch {
          // A malformed leftover lease fails closed on the next acquisition.
        }
        throw error;
      }
      closeSync(fd);
      return { stop: () => release(path, lease.instanceId) };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const owner = readLease(path);
      if (processIsAlive(owner.pid)) {
        throw new Error(`Controller lease is held by pid ${owner.pid} since ${owner.acquiredAt}: ${path}`);
      }
      if (readLease(path).instanceId !== owner.instanceId) continue;
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if (!isMissing(unlinkError)) throw unlinkError;
      }
    }
  }
  throw new Error(`Controller lease changed while acquiring: ${path}`);
}

function release(path: string, instanceId: string): void {
  let current: ControllerLease;
  try {
    current = readLease(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (current.instanceId !== instanceId) {
    throw new Error(`Controller lease ownership changed before release: ${path}`);
  }
  unlinkSync(path);
}

function readLease(path: string): ControllerLease {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ControllerLease>;
  if (
    value.version !== 1
    || typeof value.instanceId !== "string"
    || !value.instanceId
    || !Number.isInteger(value.pid)
    || (value.pid ?? 0) < 1
    || typeof value.acquiredAt !== "string"
    || !Number.isFinite(Date.parse(value.acquiredAt))
  ) throw new Error(`Controller lease is malformed; refusing to replace it: ${path}`);
  return value as ControllerLease;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    return true;
  }
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isNoSuchProcess(error: unknown): boolean {
  return errorCode(error) === "ESRCH";
}
