import type { Attempt, ExecutionSnapshot } from "../model.js";
import type { HarnessConfig, PiRpcCredentialMode } from "../ports.js";
import { isSupportedPonytailExtension } from "../compatibility.js";
import { resolveReviewerProviderProfile } from "../reviewer-provider-profile.js";

export function rpcEnabled(config: HarnessConfig, lane: Attempt["lane"]): boolean {
  return (lane === "worker" ? config.workerRuntime : config.reviewerRuntime) === "pi-rpc";
}

export function workerCompactionMode(config: HarnessConfig): "disabled" | "controlled-threshold" {
  return config.workerCompaction?.mode ?? "disabled";
}

export function runtimeRole(config: HarnessConfig, lane: Attempt["lane"]): {
  argv: string[];
  credentialMode: PiRpcCredentialMode;
  provider: string | null;
} {
  if (lane === "worker") return {
    argv: [...config.workerArgv],
    credentialMode: "canonical-oauth",
    provider: selector(config.workerArgv, "--provider") ?? "openai-codex",
  };
  const selected = resolveReviewerProviderProfile(config.reviewerArgv, config.reviewerProviderProfiles);
  return {
    argv: selected.argv,
    credentialMode: selected.credentialMode,
    provider: selector(selected.argv, "--provider"),
  };
}

export function snapshotCredentialMode(snapshot: ExecutionSnapshot): PiRpcCredentialMode {
  if (snapshot.credentialMode === "canonical-oauth" || snapshot.credentialMode === "canonical-model-config") {
    return snapshot.credentialMode;
  }
  throw new Error("Pi RPC snapshot has an invalid credential mode");
}

export function ponytailEnvironment(snapshot: ExecutionSnapshot): Record<string, string> {
  if (snapshot.context?.lane !== "worker" || !snapshot.resources.some((resource) => (
    resource.kind === "extension" && isSupportedPonytailExtension(resource.path)
  ))) return {};
  return {
    PONYTAIL_DEFAULT_MODE: "full",
    PONYTAIL_HIDE_STATUS: "1",
    PONYTAIL_QUIET_STARTUP: "1",
  };
}

function selector(argv: readonly string[], flag: string): string | null {
  const values = argv.flatMap((value, index) => value === flag && argv[index + 1] ? [argv[index + 1]!] : []);
  if (values.length > 1) throw new Error(`${flag} must appear at most once`);
  return values[0] ?? null;
}
