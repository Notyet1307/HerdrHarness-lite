import { createHash } from "node:crypto";

export const PI_RPC_FAILURE_DOMAINS = [
  "provider",
  "rpc_protocol",
  "rpc_transport",
  "child_process",
  "credential",
  "runner_internal",
] as const;

export const PI_RPC_FAILURE_CODES = [
  "provider_rate_limited",
  "provider_authentication",
  "provider_permission_denied",
  "provider_request_invalid",
  "provider_request_too_large",
  "provider_context_limit",
  "provider_timeout",
  "provider_overloaded",
  "provider_upstream_5xx",
  "provider_network",
  "provider_unknown",
  "assistant_aborted",
  "rpc_line_too_large",
  "rpc_invalid_json",
  "rpc_incomplete_jsonl",
  "rpc_record_not_object",
  "rpc_event_missing_type",
  "rpc_response_missing_identity",
  "rpc_unknown_response_id",
  "rpc_command_mismatch",
  "rpc_command_failed",
  "rpc_command_timeout",
  "rpc_transport_closed",
  "rpc_stdout_end_timeout",
  "child_spawn_failed",
  "child_exit_before_settled",
  "child_exit_after_settled",
  "child_shutdown_unconfirmed",
  "credential_postflight_failed",
  "runner_unclassified",
] as const;

export type PiRpcFailureDomain = typeof PI_RPC_FAILURE_DOMAINS[number];
export type PiRpcFailureCode = typeof PI_RPC_FAILURE_CODES[number];

export type PiRpcFailureDiagnostic = {
  failureDomain: PiRpcFailureDomain;
  failureCode: PiRpcFailureCode;
  retryable: boolean;
};

export const PI_RPC_PROVIDER_APIS = [
  "anthropic-messages",
  "openai-responses",
  "openai-completions",
  "unknown",
] as const;
export const PI_RPC_FAILURE_PHASES = [
  "initial_generation",
  "tool_continuation",
  "tool_error_recovery",
] as const;
export const PI_RPC_TRANSCRIPT_SIZE_BUCKETS = [
  "lt64k",
  "64k_256k",
  "256k_1m",
  "gte1m",
] as const;

export type PiRpcProviderApi = typeof PI_RPC_PROVIDER_APIS[number];
export type PiRpcFailurePhase = typeof PI_RPC_FAILURE_PHASES[number];
export type PiRpcTranscriptSizeBucket = typeof PI_RPC_TRANSCRIPT_SIZE_BUCKETS[number];

export type SafePiRpcDiagnostic = PiRpcFailureDiagnostic & {
  diagnosticFingerprint: string;
  httpStatus?: number;
  providerApi?: PiRpcProviderApi;
  phase?: PiRpcFailurePhase;
  turnCount?: number;
  assistantMessageCount?: number;
  toolExecutionCount?: number;
  toolErrorCount?: number;
  transcriptSizeBucket?: PiRpcTranscriptSizeBucket;
};

export type ProviderFailureContext = {
  providerApi: PiRpcProviderApi;
  phase: PiRpcFailurePhase;
  turnCount: number;
  assistantMessageCount: number;
  toolExecutionCount: number;
  toolErrorCount: number;
  transcriptBytes: number;
};

const FAILURE_DOMAINS = new Set<string>(PI_RPC_FAILURE_DOMAINS);
const FAILURE_CODES = new Set<string>(PI_RPC_FAILURE_CODES);
const PROVIDER_APIS = new Set<string>(PI_RPC_PROVIDER_APIS);
const FAILURE_PHASES = new Set<string>(PI_RPC_FAILURE_PHASES);
const TRANSCRIPT_SIZE_BUCKETS = new Set<string>(PI_RPC_TRANSCRIPT_SIZE_BUCKETS);

export class PiRpcRunnerError extends Error {
  constructor(
    readonly failureDomain: PiRpcFailureDomain,
    readonly failureCode: PiRpcFailureCode,
    readonly retryable: boolean,
  ) {
    super(failureCode);
    this.name = "PiRpcRunnerError";
  }
}

export function piRpcRunnerError(
  failureDomain: PiRpcFailureDomain,
  failureCode: PiRpcFailureCode,
  retryable: boolean,
): PiRpcRunnerError {
  return new PiRpcRunnerError(failureDomain, failureCode, retryable);
}

export function classifyPiRpcRunnerFailure(error: unknown, failureStage: string): PiRpcFailureDiagnostic {
  if (error instanceof PiRpcRunnerError) {
    return {
      failureDomain: error.failureDomain,
      failureCode: error.failureCode,
      retryable: error.retryable,
    };
  }

  const systemCode = systemErrorCode(error);
  if (systemCode === "EPIPE" || systemCode === "ECONNRESET") {
    return { failureDomain: "rpc_transport", failureCode: "rpc_transport_closed", retryable: true };
  }
  if (systemCode === "ENOENT" || systemCode === "EACCES") {
    return { failureDomain: "child_process", failureCode: "child_spawn_failed", retryable: false };
  }
  if (failureStage === "credential-postflight") {
    return { failureDomain: "credential", failureCode: "credential_postflight_failed", retryable: false };
  }
  return { failureDomain: "runner_internal", failureCode: "runner_unclassified", retryable: false };
}

export function isPiRpcFailureDomain(value: unknown): value is PiRpcFailureDomain {
  return typeof value === "string" && FAILURE_DOMAINS.has(value);
}

export function isPiRpcFailureCode(value: unknown): value is PiRpcFailureCode {
  return typeof value === "string" && FAILURE_CODES.has(value);
}

/**
 * Converts untrusted Provider text into a bounded, content-free diagnostic.
 * The input must never be logged, persisted, or included in the fingerprint.
 */
export function classifyProviderFailure(
  stopReason: "error" | "aborted",
  errorMessage: unknown,
  context: ProviderFailureContext,
): SafePiRpcDiagnostic {
  const message = typeof errorMessage === "string" ? errorMessage.toLowerCase() : "";
  const httpStatus = extractHttpStatus(message);
  const classified = stopReason === "aborted"
    ? { failureDomain: "runner_internal" as const, failureCode: "assistant_aborted" as const, retryable: false }
    : classifyProviderError(message, httpStatus);
  const diagnostic = {
    ...classified,
    ...(httpStatus === null ? {} : { httpStatus }),
    providerApi: context.providerApi,
    phase: context.phase,
    turnCount: boundedCount(context.turnCount),
    assistantMessageCount: boundedCount(context.assistantMessageCount),
    toolExecutionCount: boundedCount(context.toolExecutionCount),
    toolErrorCount: boundedCount(context.toolErrorCount),
    transcriptSizeBucket: transcriptSizeBucket(context.transcriptBytes),
  };
  return {
    ...diagnostic,
    diagnosticFingerprint: safeFingerprint(diagnostic),
  };
}

export function isSafePiRpcDiagnostic(value: unknown): value is SafePiRpcDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const diagnostic = value as Partial<SafePiRpcDiagnostic>;
  if (
    !isPiRpcFailureDomain(diagnostic.failureDomain)
    || !isPiRpcFailureCode(diagnostic.failureCode)
    || typeof diagnostic.retryable !== "boolean"
    || typeof diagnostic.diagnosticFingerprint !== "string"
    || !/^[0-9a-f]{64}$/.test(diagnostic.diagnosticFingerprint)
  ) return false;
  if (diagnostic.failureDomain === "provider" && !diagnostic.failureCode.startsWith("provider_")) return false;
  if (diagnostic.failureDomain !== "provider" && diagnostic.failureCode.startsWith("provider_")) return false;
  if (diagnostic.httpStatus !== undefined && !validHttpStatus(diagnostic.httpStatus)) return false;
  if (diagnostic.providerApi !== undefined && !PROVIDER_APIS.has(diagnostic.providerApi)) return false;
  if (diagnostic.phase !== undefined && !FAILURE_PHASES.has(diagnostic.phase)) return false;
  if (diagnostic.transcriptSizeBucket !== undefined && !TRANSCRIPT_SIZE_BUCKETS.has(diagnostic.transcriptSizeBucket)) return false;
  return [
    diagnostic.turnCount,
    diagnostic.assistantMessageCount,
    diagnostic.toolExecutionCount,
    diagnostic.toolErrorCount,
  ].every((count) => count === undefined || validCount(count));
}

export function providerApi(value: unknown): PiRpcProviderApi {
  return typeof value === "string" && PROVIDER_APIS.has(value) ? value as PiRpcProviderApi : "unknown";
}

export function failurePhase(toolExecutionCount: number, toolErrorCount: number): PiRpcFailurePhase {
  if (toolErrorCount > 0) return "tool_error_recovery";
  return toolExecutionCount > 0 ? "tool_continuation" : "initial_generation";
}

function classifyProviderError(message: string, httpStatus: number | null): PiRpcFailureDiagnostic {
  if (httpStatus === 401 || /unauthori[sz]ed|authentication|invalid api key|token expired/.test(message)) {
    return { failureDomain: "provider", failureCode: "provider_authentication", retryable: false };
  }
  if (httpStatus === 403 || /permission denied|forbidden/.test(message)) {
    return { failureDomain: "provider", failureCode: "provider_permission_denied", retryable: false };
  }
  if (httpStatus === 413 || /request[_ -]?too[_ -]?large|payload too large|body too large/.test(message)) {
    return { failureDomain: "provider", failureCode: "provider_request_too_large", retryable: false };
  }
  if (httpStatus === 429 || /rate[ -]?limit|too many requests/.test(message)) {
    return { failureDomain: "provider", failureCode: "provider_rate_limited", retryable: true };
  }
  if (/context (?:length|window)|maximum context|token limit|too many input tokens/.test(message)) {
    return { failureDomain: "provider", failureCode: "provider_context_limit", retryable: false };
  }
  if (httpStatus === 408 || httpStatus === 504 || /timed? out|timeout/.test(message)) {
    return { failureDomain: "provider", failureCode: "provider_timeout", retryable: true };
  }
  if (httpStatus === 529 || /overloaded[_ -]?error|server overloaded|over capacity/.test(message)) {
    return { failureDomain: "provider", failureCode: "provider_overloaded", retryable: true };
  }
  if ((httpStatus !== null && httpStatus >= 500) || /bad gateway|service unavailable|upstream failed/.test(message)) {
    return { failureDomain: "provider", failureCode: "provider_upstream_5xx", retryable: true };
  }
  if (/econn|enotfound|socket hang up|fetch failed|network|connection reset|\beof\b/.test(message)) {
    return { failureDomain: "provider", failureCode: "provider_network", retryable: true };
  }
  if (httpStatus === 400 || httpStatus === 422 || /invalid[_ -]?request[_ -]?error|malformed request/.test(message)) {
    return { failureDomain: "provider", failureCode: "provider_request_invalid", retryable: false };
  }
  return { failureDomain: "provider", failureCode: "provider_unknown", retryable: false };
}

function extractHttpStatus(message: string): number | null {
  const match = /(?:http|status(?:code)?|code)?[\s:=\"']*\b([45]\d\d)\b/.exec(message);
  if (!match) return null;
  const status = Number(match[1]!);
  return validHttpStatus(status) ? status : null;
}

function transcriptSizeBucket(bytes: number): PiRpcTranscriptSizeBucket {
  if (!Number.isFinite(bytes) || bytes < 64 * 1024) return "lt64k";
  if (bytes < 256 * 1024) return "64k_256k";
  if (bytes < 1024 * 1024) return "256k_1m";
  return "gte1m";
}

function safeFingerprint(value: object): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(value));
  return hash.digest("hex");
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), 1_000_000);
}

function validCount(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;
}

function validHttpStatus(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 400 && Number(value) <= 599;
}

function systemErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
