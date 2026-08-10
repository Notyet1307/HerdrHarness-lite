import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { digest, type AgentHandle, type ExecutionSnapshot } from "./model.js";

export type PiRpcPlan = {
  version: 1;
  attemptId: string;
  generation: string;
  planDigest: string;
  promptDigest: string;
  handle: AgentHandle;
  cwd: string;
  resultPath: string;
  runtimeRoot: string;
  snapshot: ExecutionSnapshot & { adapter: "pi-rpc" };
};

export function rpcRuntimeRoot(snapshot: ExecutionSnapshot): string {
  if (!snapshot.context) throw new Error("Pi RPC requires an explicit context bundle");
  return resolve(dirname(snapshot.context.bundlePath), "runtime");
}

export function rpcGeneration(attemptId: string, planDigest: string, handle: AgentHandle): string {
  return digest({ attemptId, planDigest, handle }).slice(0, 32);
}

export function spoolPath(root: string, name: string): string {
  return join(root, name);
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function preparePiRpcAgentDir(snapshot: ExecutionSnapshot): string {
  const runtimeRoot = rpcRuntimeRoot(snapshot);
  if (!snapshot.context) throw new Error("Pi RPC requires an explicit context bundle");
  return preparePiRpcAgentDirAt(join(runtimeRoot, "pi-agent"));
}

export function piRpcAgentDir(snapshot: ExecutionSnapshot): string {
  return join(rpcRuntimeRoot(snapshot), "pi-agent");
}

export function preparePiRpcAgentDirAt(isolated: string): string {
  ensurePrivateDirectory(dirname(isolated));
  ensurePrivateDirectory(isolated);
  if (pathExists(join(isolated, "settings.json"))) throw new Error("Pi RPC uses in-memory settings and must not persist settings.json");
  if (pathExists(join(isolated, "auth.json"))) throw new Error("Pi RPC private agent directory must not contain auth.json");
  if (pathExists(join(isolated, "models.json"))) throw new Error("Pi RPC canary must not mount or create models.json");
  return isolated;
}

export function writeExclusiveJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600, flush: true });
    linkSync(temporary, path);
    unlinkSync(temporary);
    syncDirectory(dirname(path));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function writeAtomicJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600, flush: true });
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readJsonIfExists<T>(path: string): T | null {
  return existsSync(path) ? readJson<T>(path) : null;
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
