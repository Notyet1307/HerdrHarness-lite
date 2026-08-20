export const QUALIFIED_PI_RPC_VERSIONS = ["0.84.0", "0.84.1", "0.84.2"] as const;
export const SUPPORTED_PI_SUBAGENTS_VERSION = "0.42.1";

const qualifiedPiRpcVersions = new Set<string>(QUALIFIED_PI_RPC_VERSIONS);

export function isQualifiedPiRpcVersion(version: string): boolean {
  return qualifiedPiRpcVersions.has(version);
}

export function assertQualifiedPiRpcVersion(version: string): void {
  if (!isQualifiedPiRpcVersion(version)) {
    throw new Error(`Pi RPC version ${version} is not qualified; qualified exact versions: ${QUALIFIED_PI_RPC_VERSIONS.join(", ")}`);
  }
}
