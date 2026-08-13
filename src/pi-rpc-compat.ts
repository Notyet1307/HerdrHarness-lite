const QUALIFIED_PI_RPC_VERSIONS = new Set(["0.84.0", "0.84.1"]);

export function isQualifiedPiRpcVersion(version: string): boolean {
  return QUALIFIED_PI_RPC_VERSIONS.has(version);
}

export function assertQualifiedPiRpcVersion(version: string): void {
  if (!isQualifiedPiRpcVersion(version)) {
    throw new Error(`Pi RPC version ${version} is not qualified; qualified exact versions: ${[...QUALIFIED_PI_RPC_VERSIONS].join(", ")}`);
  }
}
