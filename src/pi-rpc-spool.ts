import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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
  pinnedTaskData?: {
    version: 1;
    digest: string;
    content: string;
  };
  snapshot: ExecutionSnapshot & { adapter: "pi-rpc" };
};

export type RuntimeSideEffectBaseline =
  | { kind: "git"; headSha: string; statusDigest: string }
  | { kind: "tree"; treeDigest: string };

export function captureRuntimeSideEffectBaseline(
  cwd: string,
  excludedPaths: string[],
): RuntimeSideEffectBaseline {
  const root = resolve(cwd);
  if (existsSync(join(root, ".git"))) {
    const head = git(root, ["rev-parse", "HEAD"]).trim();
    if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error("runtime worktree has an invalid Git HEAD");
    return {
      kind: "git",
      headSha: head,
      statusDigest: digest(filteredGitStatus(root, excludedPaths)),
    };
  }
  return { kind: "tree", treeDigest: treeDigest(root, excludedPaths) };
}

export function observeRuntimeSideEffects(
  cwd: string,
  excludedPaths: string[],
  baseline: RuntimeSideEffectBaseline,
): { worktreeChanged: boolean; commitCreated: boolean } {
  try {
    const current = captureRuntimeSideEffectBaseline(cwd, excludedPaths);
    if (baseline.kind !== current.kind) return { worktreeChanged: true, commitCreated: true };
    return baseline.kind === "git" && current.kind === "git"
      ? {
          worktreeChanged: baseline.statusDigest !== current.statusDigest,
          commitCreated: baseline.headSha !== current.headSha,
        }
      : {
          worktreeChanged: baseline.kind === "tree" && current.kind === "tree"
            ? baseline.treeDigest !== current.treeDigest
            : true,
          commitCreated: false,
        };
  } catch {
    return { worktreeChanged: true, commitCreated: true };
  }
}

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
  const identity = lstatSync(path);
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error("Pi RPC private directory must not be a symlink");
  chmodSync(path, 0o700);
  if ((lstatSync(path).mode & 0o777) !== 0o700) throw new Error("Pi RPC private directory must have mode 0700");
}

export function preparePiRpcAgentDir(snapshot: ExecutionSnapshot): string {
  const runtimeRoot = rpcRuntimeRoot(snapshot);
  if (!snapshot.context) throw new Error("Pi RPC requires an explicit context bundle");
  return preparePiRpcAgentDirAt(join(runtimeRoot, "pi-agent"));
}

export function piRpcAgentDir(snapshot: ExecutionSnapshot): string {
  return join(rpcRuntimeRoot(snapshot), "pi-agent");
}

export function preparePiRpcToolAgentDir(snapshot: ExecutionSnapshot): string {
  return preparePiRpcToolAgentDirAt(join(rpcRuntimeRoot(snapshot), "tool-agent"));
}

export function preparePiRpcAgentDirAt(isolated: string): string {
  ensurePrivateDirectory(dirname(isolated));
  ensurePrivateDirectory(isolated);
  if (pathExists(join(isolated, "settings.json"))) throw new Error("Pi RPC uses in-memory settings and must not persist settings.json");
  if (pathExists(join(isolated, "auth.json"))) throw new Error("Pi RPC private agent directory must not contain auth.json");
  if (pathExists(join(isolated, "models.json"))) throw new Error("Pi RPC canary must not mount or create models.json");
  return isolated;
}

export function preparePiRpcToolAgentDirAt(isolated: string): string {
  ensurePrivateDirectory(dirname(isolated));
  ensurePrivateDirectory(isolated);
  if (pathExists(join(isolated, "settings.json")) || pathExists(join(isolated, "models.json"))) {
    throw new Error("Pi RPC tool agent directory must not contain settings.json or models.json");
  }
  assertEmptyPrivateStore(join(isolated, "auth.json"), "auth.json");
  assertEmptyPrivateStore(join(isolated, "models-store.json"), "models-store.json");
  return isolated;
}

function assertEmptyPrivateStore(path: string, name: string): void {
  if (!pathExists(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
    || readFileSync(path, "utf8") !== "{}") {
    throw new Error(`Pi RPC tool agent ${name} must be one empty private store`);
  }
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

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0] ?? "command"} failed`);
  return result.stdout;
}

function filteredGitStatus(cwd: string, excludedPaths: string[]): string {
  const excluded = new Set(excludedPaths.flatMap((path) => {
    const value = relative(cwd, resolve(path)).replace(/\\/g, "/");
    return value.startsWith("../") || value === ".." ? [] : [value];
  }));
  return git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])
    .split(/\r?\n/)
    .filter((line) => line && (!line.startsWith("?? ") || !excluded.has(line.slice(3))))
    .join("\n");
}

function treeDigest(root: string, excludedPaths: string[]): string {
  const excluded = excludedPaths.map((path) => resolve(path));
  const hash = createHash("sha256");
  const visit = (path: string): void => {
    const resolved = resolve(path);
    if (excluded.some((entry) => resolved === entry || resolved.startsWith(`${entry}${sep}`))) return;
    const stat = lstatSync(resolved);
    const name = relative(root, resolved).replace(/\\/g, "/") || ".";
    hash.update(`${name}\0${stat.mode & 0o777}\0`);
    if (stat.isDirectory()) {
      hash.update("directory\0");
      for (const entry of readdirSync(resolved).sort()) visit(join(resolved, entry));
      return;
    }
    if (stat.isSymbolicLink()) {
      hash.update(`symlink\0${realpathSync(resolved)}\0`);
      return;
    }
    if (!stat.isFile()) throw new Error(`runtime worktree contains an unsupported entry: ${name}`);
    hash.update("file\0");
    hash.update(readFileSync(resolved));
    hash.update("\0");
  };
  visit(root);
  return hash.digest("hex");
}
