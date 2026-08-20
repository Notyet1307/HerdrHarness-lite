import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ControlledCompactionPolicy } from "./model.js";

export const QUALIFIED_PI_RPC_VERSIONS = ["0.84.0", "0.84.1", "0.84.2"] as const;
export const QUALIFIED_CONTROLLED_COMPACTION_PI_VERSION = "0.84.2";
export const SUPPORTED_PI_SUBAGENTS_VERSION = "0.42.1";
export const SUPPORTED_PONYTAIL_VERSION = "4.9.0";
export const WORKER_CONTROLLED_COMPACTION_POLICY = Object.freeze({
  triggerPercent: 75,
  maxCompactions: 1,
  keepRecentTokens: 20_000,
  overflowContinuation: false,
}) satisfies ControlledCompactionPolicy;

const qualifiedPiRpcVersions = new Set<string>(QUALIFIED_PI_RPC_VERSIONS);

export function isQualifiedPiRpcVersion(version: string): boolean {
  return qualifiedPiRpcVersions.has(version);
}

export function assertQualifiedPiRpcVersion(version: string): void {
  if (!isQualifiedPiRpcVersion(version)) {
    throw new Error(`Pi RPC version ${version} is not qualified; qualified exact versions: ${QUALIFIED_PI_RPC_VERSIONS.join(", ")}`);
  }
}

export function isWorkerControlledCompactionPolicy(value: unknown): value is ControlledCompactionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return Object.keys(policy).length === 4
    && policy.triggerPercent === WORKER_CONTROLLED_COMPACTION_POLICY.triggerPercent
    && policy.maxCompactions === WORKER_CONTROLLED_COMPACTION_POLICY.maxCompactions
    && policy.keepRecentTokens === WORKER_CONTROLLED_COMPACTION_POLICY.keepRecentTokens
    && policy.overflowContinuation === WORKER_CONTROLLED_COMPACTION_POLICY.overflowContinuation;
}

export function isSupportedPonytailExtension(path: string): boolean {
  const extensionPath = resolve(path);
  const packageRoot = dirname(dirname(extensionPath));
  try {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
      pi?: { extensions?: unknown };
    };
    return manifest.name === "@dietrichgebert/ponytail"
      && manifest.version === SUPPORTED_PONYTAIL_VERSION
      && existsSync(extensionPath)
      && Array.isArray(manifest.pi?.extensions)
      && manifest.pi.extensions.some((entry) => typeof entry === "string" && resolve(packageRoot, entry) === extensionPath);
  } catch {
    return false;
  }
}
