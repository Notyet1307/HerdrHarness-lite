#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { QUALIFIED_PI_AUTHENTICATED_READY_VERSION } from "./compatibility.js";

export const CREDENTIAL_STARTUP_ERROR_CODES = [
  "credential_lock_timeout",
  "credential_lock_stale",
  "oauth_refresh_timeout",
  "oauth_missing",
  "oauth_probe_failed",
] as const;

export type CredentialStartupErrorCode = typeof CREDENTIAL_STARTUP_ERROR_CODES[number];

export type CredentialDomain = {
  credentialDomainId: string;
  authPath: string;
  coordinationDir: string;
};

type LeaseRecord = {
  version: 1;
  provider: string;
  credentialDomainId: string;
  instanceId: string;
  pid: number;
  acquiredAt: string;
  heartbeat: string;
};

type ProbeCacheRecord = {
  version: 1;
  provider: string;
  model: string;
  credentialDomainId: string;
  authRevisionId: string;
  succeededAt: string;
  expiresAt: string;
};

export type CredentialStartupLease = {
  instanceId: string;
  path: string;
  heartbeat(): void;
  stop(): void;
};

type LeaseOptions = {
  timeoutMs?: number;
  staleAfterMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  pid?: number;
  now?: () => number;
  processAlive?: (pid: number) => boolean;
};

const DEFAULT_LOCK_TIMEOUT_MS = 25_000;
const DEFAULT_STALE_AFTER_MS = 10_000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_HEARTBEAT_MS = 1_000;
const PROBE_CACHE_TTL_MS = 60_000;
const MAX_CHILD_EVENT_BYTES = 1024 * 1024;

export class CredentialStartupError extends Error {
  constructor(readonly code: CredentialStartupErrorCode) {
    super(code);
    this.name = "CredentialStartupError";
  }
}

export function credentialStartupErrorCode(error: unknown): CredentialStartupErrorCode | null {
  if (error instanceof CredentialStartupError) return error.code;
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && (CREDENTIAL_STARTUP_ERROR_CODES as readonly string[]).includes(code)
    ? code as CredentialStartupErrorCode
    : null;
}

export function credentialStartupRetryable(code: CredentialStartupErrorCode): boolean {
  return code === "credential_lock_timeout" || code === "oauth_refresh_timeout";
}

const CHILD_EVENT_TYPES = new Set([
  "session", "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end", "bash_execution_update",
]);

export function projectCredentialChildEvent(value: unknown): {
  event: Record<string, unknown>;
  authenticatedReady: boolean;
  providerFailed: boolean;
} {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const reportedType = typeof input.type === "string" && CHILD_EVENT_TYPES.has(input.type) ? input.type : "unknown";
  const message = input.message && typeof input.message === "object" && !Array.isArray(input.message)
    ? input.message as Record<string, unknown>
    : null;
  const role = typeof message?.role === "string" ? message.role : null;
  const stopReason = typeof message?.stopReason === "string" ? message.stopReason : null;
  const providerFailed = role === "assistant" && (stopReason === "error" || stopReason === "aborted");
  const authenticatedReady = reportedType === "message_start" && role === "assistant" && !providerFailed;
  if (reportedType === "message_start") {
    return { event: { type: reportedType, message: { role, stopReason } }, authenticatedReady, providerFailed };
  }
  if (reportedType === "message_end") {
    const text = role === "assistant" && stopReason === "stop" && !providerFailed && Array.isArray(message?.content)
      ? message.content.flatMap((part) => (
          part && typeof part === "object" && !Array.isArray(part)
            && (part as { type?: unknown }).type === "text"
            && typeof (part as { text?: unknown }).text === "string"
            ? [{ type: "text", text: (part as { text: string }).text }]
            : []
        ))
      : [];
    const bounded = Buffer.byteLength(JSON.stringify(text), "utf8") <= 64 * 1024 ? text : [];
    return {
      event: { type: reportedType, message: { role, stopReason, content: bounded } },
      authenticatedReady: false,
      providerFailed,
    };
  }
  if (reportedType.startsWith("tool_execution") || reportedType === "bash_execution_update") {
    const toolName = typeof input.toolName === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(input.toolName)
      ? input.toolName
      : undefined;
    return {
      event: { type: reportedType, ...(toolName ? { toolName } : {}), isError: input.isError === true },
      authenticatedReady: false,
      providerFailed: false,
    };
  }
  if (reportedType === "message_update") {
    const delta = input.assistantMessageEvent && typeof input.assistantMessageEvent === "object"
      && !Array.isArray(input.assistantMessageEvent)
      ? input.assistantMessageEvent as { type?: unknown }
      : null;
    return {
      event: { type: reportedType, assistantMessageEvent: { type: typeof delta?.type === "string" ? delta.type : "unknown" } },
      authenticatedReady: false,
      providerFailed: false,
    };
  }
  return { event: { type: reportedType }, authenticatedReady: false, providerFailed: false };
}

/** Resolve one canonical OAuth store without reading auth.json bytes. */
export function resolveCredentialDomain(authPath: string, expectedId?: string): CredentialDomain {
  try {
    if (!isAbsolute(authPath)) throw new Error("not absolute");
    const logical = lstatSync(authPath);
    if (!logical.isFile() || logical.isSymbolicLink() || logical.nlink !== 1 || (logical.mode & 0o777) !== 0o600) {
      throw new Error("not a private regular file");
    }
    const canonical = realpathSync(authPath);
    const canonicalStat = lstatSync(canonical);
    if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink() || canonicalStat.nlink !== 1 || (canonicalStat.mode & 0o777) !== 0o600) {
      throw new Error("not a canonical private file");
    }
    const credentialDomainId = sha256(canonical);
    if (expectedId !== undefined && expectedId !== credentialDomainId) {
      throw new CredentialStartupError("credential_lock_stale");
    }
    return {
      credentialDomainId,
      authPath: canonical,
      coordinationDir: join(dirname(canonical), ".herdr-harness-credential-coordination"),
    };
  } catch (error) {
    if (error instanceof CredentialStartupError) throw error;
    throw new CredentialStartupError("oauth_missing");
  }
}

export function credentialAuthRevisionId(domain: CredentialDomain): string {
  try {
    const identity = lstatSync(domain.authPath);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 || (identity.mode & 0o777) !== 0o600) {
      throw new Error("changed");
    }
    const stat = statSync(domain.authPath);
    return sha256(JSON.stringify({
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    }));
  } catch {
    throw new CredentialStartupError("oauth_missing");
  }
}

export function credentialLeasePath(domain: CredentialDomain, provider: string): string {
  validateSelector(provider);
  return join(domain.coordinationDir, `lease-${sha256(`${provider}\0${domain.credentialDomainId}`)}.json`);
}

export async function acquireCredentialStartupLease(
  domain: CredentialDomain,
  provider: string,
  options: LeaseOptions = {},
): Promise<CredentialStartupLease> {
  validateSelector(provider);
  prepareCoordinationDirectory(domain.coordinationDir);
  const path = credentialLeasePath(domain, provider);
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const timeoutMs = positive(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const staleAfterMs = positive(options.staleAfterMs, DEFAULT_STALE_AFTER_MS);
  const pollMs = positive(options.pollMs, DEFAULT_POLL_MS);
  const heartbeatMs = positive(options.heartbeatMs, DEFAULT_HEARTBEAT_MS);
  const alive = options.processAlive ?? processIsAlive;
  const deadline = now() + timeoutMs;

  for (;;) {
    const timestamp = new Date(now()).toISOString();
    const lease: LeaseRecord = {
      version: 1,
      provider,
      credentialDomainId: domain.credentialDomainId,
      instanceId: randomUUID(),
      pid,
      acquiredAt: timestamp,
      heartbeat: timestamp,
    };
    try {
      writeExclusive(path, lease);
      return ownedLease(path, lease, heartbeatMs, now);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw asLockError(error);
    }

    let observed: LeaseRecord;
    try {
      observed = readLease(path, provider, domain.credentialDomainId);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw new CredentialStartupError("credential_lock_stale");
    }
    const ownerAlive = alive(observed.pid);
    const heartbeatAge = now() - Date.parse(observed.heartbeat);
    if (!ownerAlive && heartbeatAge >= staleAfterMs) {
      const replaced = replaceStaleLeaseUnderNativeLock(
        path,
        provider,
        domain.credentialDomainId,
        observed,
        lease,
        staleAfterMs,
        Math.max(1, deadline - now()),
      );
      if (replaced) return ownedLease(path, lease, heartbeatMs, now);
      continue;
    }
    if (now() >= deadline) {
      throw new CredentialStartupError(ownerAlive ? "credential_lock_timeout" : "credential_lock_stale");
    }
    await delay(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}

export function assertCredentialStartupLease(
  domain: CredentialDomain,
  provider: string,
  instanceId: string,
  ownerPid?: number,
): void {
  try {
    const lease = readLease(credentialLeasePath(domain, provider), provider, domain.credentialDomainId);
    if (lease.instanceId !== instanceId || (ownerPid !== undefined && lease.pid !== ownerPid)) {
      throw new Error("owner changed");
    }
  } catch {
    throw new CredentialStartupError("credential_lock_stale");
  }
}

export function probeCacheIsFresh(input: {
  domain: CredentialDomain;
  provider: string;
  model: string;
  authRevisionId: string;
  leaseInstanceId: string;
  now?: number;
}): boolean {
  assertCredentialStartupLease(input.domain, input.provider, input.leaseInstanceId);
  const path = probeCachePath(input.domain, input.provider, input.model);
  if (!existsSync(path)) return false;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ProbeCacheRecord>;
    const now = input.now ?? Date.now();
    if (!validProbeCache(value, input)) return false;
    const succeededAt = Date.parse(value.succeededAt);
    const expiresAt = Date.parse(value.expiresAt);
    return succeededAt <= now
      && now - succeededAt <= PROBE_CACHE_TTL_MS
      && expiresAt > now
      && expiresAt > succeededAt
      && expiresAt - succeededAt <= PROBE_CACHE_TTL_MS;
  } catch {
    unlinkIfExists(path);
    return false;
  }
}

export function recordProbeSuccess(input: {
  domain: CredentialDomain;
  provider: string;
  model: string;
  authRevisionId: string;
  leaseInstanceId: string;
  now?: number;
}): void {
  assertCredentialStartupLease(input.domain, input.provider, input.leaseInstanceId);
  const now = input.now ?? Date.now();
  writeAtomic(probeCachePath(input.domain, input.provider, input.model), {
    version: 1,
    provider: input.provider,
    model: input.model,
    credentialDomainId: input.domain.credentialDomainId,
    authRevisionId: input.authRevisionId,
    succeededAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PROBE_CACHE_TTL_MS).toISOString(),
  } satisfies ProbeCacheRecord);
}

export function invalidateProbeSuccess(input: {
  domain: CredentialDomain;
  provider: string;
  model: string;
  leaseInstanceId: string;
}): void {
  assertCredentialStartupLease(input.domain, input.provider, input.leaseInstanceId);
  unlinkIfExists(probeCachePath(input.domain, input.provider, input.model));
}

function ownedLease(
  path: string,
  initial: LeaseRecord,
  heartbeatMs: number,
  now: () => number,
): CredentialStartupLease {
  let current = initial;
  let stopped = false;
  let heartbeatError: unknown = null;
  const heartbeat = (): void => {
    if (stopped) throw new CredentialStartupError("credential_lock_stale");
    const observed = readLease(path, current.provider, current.credentialDomainId);
    if (observed.instanceId !== current.instanceId || observed.pid !== current.pid) {
      throw new CredentialStartupError("credential_lock_stale");
    }
    current = { ...current, heartbeat: new Date(now()).toISOString() };
    writeAtomic(path, current);
  };
  let timer: unknown = null;
  const scheduleHeartbeat = (): void => {
    timer = setTimeout(() => {
      try {
        heartbeat();
      } catch (error) {
        heartbeatError = error;
      }
      if (!stopped) scheduleHeartbeat();
    }, heartbeatMs);
  };
  scheduleHeartbeat();
  return {
    instanceId: current.instanceId,
    path,
    heartbeat,
    stop() {
      if (stopped) return;
      clearTimeout(timer);
      stopped = true;
      if (heartbeatError) throw new CredentialStartupError("credential_lock_stale");
      let observed: LeaseRecord;
      try {
        observed = readLease(path, current.provider, current.credentialDomainId);
      } catch {
        throw new CredentialStartupError("credential_lock_stale");
      }
      if (observed.instanceId !== current.instanceId || observed.pid !== current.pid) {
        throw new CredentialStartupError("credential_lock_stale");
      }
      try {
        unlinkSync(path);
        syncDirectory(dirname(path));
      } catch {
        throw new CredentialStartupError("credential_lock_stale");
      }
    },
  };
}

function probeCachePath(domain: CredentialDomain, provider: string, model: string): string {
  validateSelector(provider);
  validateSelector(model);
  prepareCoordinationDirectory(domain.coordinationDir);
  return join(domain.coordinationDir, `probe-${sha256(`${provider}\0${model}\0${domain.credentialDomainId}`)}.json`);
}

function validProbeCache(
  value: Partial<ProbeCacheRecord>,
  input: { domain: CredentialDomain; provider: string; model: string; authRevisionId: string },
): value is ProbeCacheRecord {
  return value.version === 1
    && value.provider === input.provider
    && value.model === input.model
    && value.credentialDomainId === input.domain.credentialDomainId
    && value.authRevisionId === input.authRevisionId
    && typeof value.succeededAt === "string" && Number.isFinite(Date.parse(value.succeededAt))
    && typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt));
}

function prepareCoordinationDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw new CredentialStartupError("credential_lock_stale");
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("unsafe");
  } catch {
    throw new CredentialStartupError("credential_lock_stale");
  }
}

function readLease(path: string, provider: string, credentialDomainId: string): LeaseRecord {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LeaseRecord>;
  if (Object.keys(value).sort().join(",") !== "acquiredAt,credentialDomainId,heartbeat,instanceId,pid,provider,version"
    || value.version !== 1
    || value.provider !== provider
    || value.credentialDomainId !== credentialDomainId
    || typeof value.instanceId !== "string" || !value.instanceId
    || !Number.isInteger(value.pid) || (value.pid ?? 0) < 1
    || typeof value.acquiredAt !== "string" || !Number.isFinite(Date.parse(value.acquiredAt))
    || typeof value.heartbeat !== "string" || !Number.isFinite(Date.parse(value.heartbeat))) {
    throw new Error("invalid credential lease");
  }
  return value as LeaseRecord;
}

function replaceStaleLeaseUnderNativeLock(
  leasePath: string,
  provider: string,
  credentialDomainId: string,
  observed: LeaseRecord,
  replacement: LeaseRecord,
  staleAfterMs: number,
  timeoutMs: number,
): boolean {
  const payload = JSON.stringify({
    version: 1,
    leasePath,
    provider,
    credentialDomainId,
    observedInstanceId: observed.instanceId,
    observedHeartbeat: observed.heartbeat,
    replacement,
    staleAfterMs,
  });
  const lockPath = `${leasePath}.reclaim.lock`;
  const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1_000)));
  const entry = resolve(import.meta.dirname, "credential-startup.js");
  const command = existsSync("/usr/bin/lockf")
    ? { executable: "/usr/bin/lockf", args: ["-t", seconds, lockPath, process.execPath, entry, "--reclaim", payload] }
    : existsSync("/usr/bin/flock")
      ? { executable: "/usr/bin/flock", args: ["-w", seconds, lockPath, process.execPath, entry, "--reclaim", payload] }
      : existsSync("/bin/flock")
        ? { executable: "/bin/flock", args: ["-w", seconds, lockPath, process.execPath, entry, "--reclaim", payload] }
        : null;
  if (!command) throw new CredentialStartupError("credential_lock_stale");
  const result = spawnSync(command.executable, command.args, {
    encoding: "utf8",
    timeout: timeoutMs + 1_000,
  });
  if (result.error || result.status !== 0) throw new CredentialStartupError("credential_lock_stale");
  if (result.stdout.trim() === "reclaimed") return true;
  if (result.stdout.trim() === "changed") return false;
  throw new CredentialStartupError("credential_lock_stale");
}

function replaceStaleLease(payloadText: string): void {
  const payload = JSON.parse(payloadText) as {
    version?: unknown;
    leasePath?: unknown;
    provider?: unknown;
    credentialDomainId?: unknown;
    observedInstanceId?: unknown;
    observedHeartbeat?: unknown;
    replacement?: unknown;
    staleAfterMs?: unknown;
  };
  if (payload.version !== 1
    || typeof payload.leasePath !== "string" || !isAbsolute(payload.leasePath)
    || typeof payload.provider !== "string"
    || typeof payload.credentialDomainId !== "string" || !/^[0-9a-f]{64}$/.test(payload.credentialDomainId)
    || typeof payload.observedInstanceId !== "string" || !payload.observedInstanceId
    || typeof payload.observedHeartbeat !== "string" || !Number.isFinite(Date.parse(payload.observedHeartbeat))
    || !Number.isInteger(payload.staleAfterMs) || Number(payload.staleAfterMs) < 1) {
    throw new CredentialStartupError("credential_lock_stale");
  }
  const replacement = payload.replacement as Partial<LeaseRecord>;
  const observed = readLease(payload.leasePath, payload.provider, payload.credentialDomainId);
  if (observed.instanceId !== payload.observedInstanceId
    || observed.heartbeat !== payload.observedHeartbeat
    || processIsAlive(observed.pid)
    || Date.now() - Date.parse(observed.heartbeat) < Number(payload.staleAfterMs)) {
    process.stdout.write("changed\n");
    return;
  }
  if (!replacement || replacement.version !== 1
    || replacement.provider !== payload.provider
    || replacement.credentialDomainId !== payload.credentialDomainId
    || typeof replacement.instanceId !== "string" || !replacement.instanceId
    || !Number.isInteger(replacement.pid) || Number(replacement.pid) < 1
    || typeof replacement.acquiredAt !== "string" || !Number.isFinite(Date.parse(replacement.acquiredAt))
    || typeof replacement.heartbeat !== "string" || !Number.isFinite(Date.parse(replacement.heartbeat))) {
    throw new CredentialStartupError("credential_lock_stale");
  }
  writeAtomic(payload.leasePath, replacement as LeaseRecord);
  process.stdout.write("reclaimed\n");
}

function writeExclusive(path: string, value: LeaseRecord): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}

function writeAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    unlinkIfExists(temporary);
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function asLockError(error: unknown): CredentialStartupError {
  return error instanceof CredentialStartupError ? error : new CredentialStartupError("credential_lock_stale");
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function validateSelector(value: string): void {
  if (!value || value.length > 200 || /[\0\r\n]/.test(value)) throw new CredentialStartupError("credential_lock_stale");
}

function sha256(value: string): string {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function launchCredentialBoundChild(argv: string[]): Promise<number> {
  const separator = argv.indexOf("--");
  if (separator < 0) throw new CredentialStartupError("credential_lock_stale");
  const hostArgs = argv.slice(0, separator);
  const read = (name: string): string => {
    const indexes = hostArgs.flatMap((value, index) => value === name ? [index] : []);
    if (indexes.length !== 1) throw new CredentialStartupError("credential_lock_stale");
    const value = hostArgs[indexes[0]! + 1];
    if (!value || value.startsWith("--")) throw new CredentialStartupError("credential_lock_stale");
    return value;
  };
  const allowed = new Set([
    "--provider", "--model", "--credential-agent-dir", "--credential-domain-id",
    "--pi-executable", "--expected-version",
  ]);
  for (let index = 0; index < hostArgs.length; index += 2) {
    if (!allowed.has(hostArgs[index]!)) throw new CredentialStartupError("credential_lock_stale");
  }
  const provider = read("--provider");
  const model = read("--model");
  const credentialAgentDir = read("--credential-agent-dir");
  const executable = realpathSync(read("--pi-executable"));
  const expectedVersion = read("--expected-version");
  const inspected = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (inspected.error || inspected.status !== 0 || inspected.stdout.trim() !== expectedVersion) {
    throw new CredentialStartupError("oauth_probe_failed");
  }
  const domain = resolveCredentialDomain(join(resolve(credentialAgentDir), "auth.json"), read("--credential-domain-id"));
  const lease = await acquireCredentialStartupLease(domain, provider, { timeoutMs: 120_000 });
  let activeLease: CredentialStartupLease | null = lease;
  const releaseAtAuthenticatedReady = expectedVersion === QUALIFIED_PI_AUTHENTICATED_READY_VERSION;
  const child = spawn(executable, argv.slice(separator + 1), {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const release = (): void => {
    if (!activeLease) return;
    activeLease.stop();
    activeLease = null;
  };
  let providerFailed = false;
  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_CHILD_EVENT_BYTES && !stdoutBuffer.includes("\n")) {
      providerFailed = true;
      stdoutBuffer = "";
      process.stdout.write(`${JSON.stringify({ type: "harness_malformed_output" })}\n`);
      child.kill("SIGTERM");
      return;
    }
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_CHILD_EVENT_BYTES) {
        providerFailed = true;
        process.stdout.write(`${JSON.stringify({ type: "harness_malformed_output" })}\n`);
        child.kill("SIGTERM");
        continue;
      }
      try {
        const projected = projectCredentialChildEvent(JSON.parse(line));
        if (releaseAtAuthenticatedReady && projected.authenticatedReady) {
          // Qualified Pi 0.84.2 emits this only after prepareRequest/getAuth has opened the Provider stream.
          release();
        }
        providerFailed ||= projected.providerFailed;
        process.stdout.write(`${JSON.stringify(projected.event)}\n`);
      } catch {
        process.stdout.write(`${JSON.stringify({ type: "harness_malformed_output" })}\n`);
      }
    }
  });
  child.stdout.on("end", () => {
    if (stdoutBuffer) process.stdout.write(`${JSON.stringify({ type: "harness_malformed_output" })}\n`);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => { /* Drain without recording raw Provider responses. */ });
  const forward = (): void => { child.kill("SIGTERM"); };
  const onTerm = (): void => forward();
  const onInt = (): void => forward();
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInt);
  const invalidateCache = async (): Promise<void> => {
    const invalidationLease = activeLease ?? await acquireCredentialStartupLease(domain, provider);
    try {
      invalidateProbeSuccess({
        domain,
        provider,
        model,
        leaseInstanceId: invalidationLease.instanceId,
      });
    } finally {
      if (invalidationLease !== activeLease) invalidationLease.stop();
    }
  };
  try {
    let exit: { code: number | null; signal: string | null };
    try {
      exit = await new Promise<{ code: number | null; signal: string | null }>((resolveExit, reject) => {
        child.on("error", reject);
        child.on("exit", (code: number | null, signal: string | null) => resolveExit({ code, signal }));
      });
    } catch (error) {
      await invalidateCache();
      throw error;
    }
    if (exit.code !== 0 || exit.signal !== null || providerFailed) await invalidateCache();
    return exit.code ?? 1;
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reclaimPayload = process.argv[2] === "--reclaim" ? process.argv[3] : undefined;
  const operation = reclaimPayload === undefined
    ? launchCredentialBoundChild(process.argv.slice(2))
    : Promise.resolve().then(() => { replaceStaleLease(reclaimPayload); return 0; });
  operation.then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${credentialStartupErrorCode(error) ?? "oauth_probe_failed"}\n`);
      process.exitCode = 1;
    },
  );
}
