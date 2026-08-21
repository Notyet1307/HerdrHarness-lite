import { createHash } from "node:crypto";

export const PI_RPC_FAILURE_DOMAINS = [
  "provider",
  "rpc_protocol",
  "rpc_transport",
  "child_process",
  "credential",
  "runner_internal",
  "runtime",
  "tool",
  "result",
  "git",
  "policy",
  "compaction",
  "validation",
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
  "provider_continuation_lost",
  "rpc_event_oversize",
  "rpc_terminal_missing",
  "runtime_stall",
  "attempt_deadline",
  "runtime_terminated",
  "tool_contract",
  "result_missing",
  "result_identity",
  "git_integrity",
  "policy_violation",
  "compaction_failure",
  "validation_infrastructure",
  "validation_failed",
] as const;

export type PiRpcFailureDomain = typeof PI_RPC_FAILURE_DOMAINS[number];
export type PiRpcFailureCode = typeof PI_RPC_FAILURE_CODES[number];

export const FAILURE_DOMAINS = [
  "execution",
  "observation",
  "acceptance",
  "deterministic",
] as const;

export const FAILURE_CODES = [
  "provider_auth",
  "provider_rate_limit",
  "provider_network",
  "provider_timeout",
  "provider_continuation_lost",
  "provider_rejected",
  "provider_unavailable",
  "provider_unknown",
  "assistant_aborted",
  "rpc_protocol",
  "rpc_event_oversize",
  "rpc_terminal_missing",
  "rpc_transport",
  "runtime_stall",
  "attempt_deadline",
  "runtime_terminated",
  "runtime_internal",
  "child_exit",
  "credential_integrity",
  "tool_contract",
  "result_missing",
  "result_identity",
  "git_integrity",
  "policy_violation",
  "compaction_failure",
  "validation_infrastructure",
  "validation_failed",
] as const;

export type FailureDomain = typeof FAILURE_DOMAINS[number];
export type FailureCode = typeof FAILURE_CODES[number];

export type PiRpcFailureDiagnostic = {
  failureDomain: PiRpcFailureDomain;
  failureCode: PiRpcFailureCode;
  retryable: boolean;
};

export const PI_RPC_PROVIDER_APIS = [
  "anthropic-messages",
  "openai-codex-responses",
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
export const PI_RPC_FAILURE_STAGES = [
  "startup",
  "handshake",
  "await-dispatch",
  "dispatch",
  "agent-run",
  "child-shutdown",
  "rpc-output",
  "credential-postflight",
  "child-exit",
] as const;

export const FAILURE_STAGES = [
  ...PI_RPC_FAILURE_STAGES,
  "terminal-observation",
  "result-validation",
  "git-verification",
  "review-preflight",
  "review-axis",
  "review-validation",
  "compaction",
] as const;

export type PiRpcProviderApi = typeof PI_RPC_PROVIDER_APIS[number];
export type PiRpcFailurePhase = typeof PI_RPC_FAILURE_PHASES[number];
export type PiRpcTranscriptSizeBucket = typeof PI_RPC_TRANSCRIPT_SIZE_BUCKETS[number];
export type PiRpcFailureStage = typeof PI_RPC_FAILURE_STAGES[number];
export type FailureStage = typeof FAILURE_STAGES[number];
export type FailureClassification = {
  domain: FailureDomain;
  code: FailureCode;
  stage: FailureStage;
  retryable: boolean;
};
type ClassifiedRunnerFailure = PiRpcFailureDiagnostic & FailureClassification & { failureStage: FailureStage };
export type SafeChildExit = { code: number | null; signal: string | null } | null;

export type SafeRuntimeDiagnostic = PiRpcFailureDiagnostic & {
  /** Missing only on diagnostics persisted before the stable cross-layer taxonomy. */
  domain?: FailureDomain;
  code?: FailureCode;
  stage?: FailureStage;
  diagnosticFingerprint: string;
  httpStatus?: number;
  providerApi?: PiRpcProviderApi;
  phase?: PiRpcFailurePhase;
  turnCount?: number;
  assistantMessageCount?: number;
  toolExecutionCount?: number;
  toolErrorCount?: number;
  transcriptSizeBucket?: PiRpcTranscriptSizeBucket;
  failureStage?: FailureStage;
  childExit?: SafeChildExit;
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

const STRUCTURED_DIAGNOSTIC_FIELDS = [
  "domain",
  "code",
  "stage",
  "failureDomain",
  "failureCode",
  "diagnosticFingerprint",
  "httpStatus",
  "providerApi",
  "phase",
  "turnCount",
  "assistantMessageCount",
  "toolExecutionCount",
  "toolErrorCount",
  "transcriptSizeBucket",
  "failureStage",
  "childExit",
] as const;
const STRUCTURED_DIAGNOSTIC_MARKERS = ["failureDomain", "failureCode", "diagnosticFingerprint"] as const;
const SAFE_DIAGNOSTIC_FIELD_SET = new Set<string>([...STRUCTURED_DIAGNOSTIC_FIELDS, "retryable"]);

const PI_RPC_FAILURE_DOMAIN_SET = new Set<string>(PI_RPC_FAILURE_DOMAINS);
const PI_RPC_FAILURE_CODE_SET = new Set<string>(PI_RPC_FAILURE_CODES);
const FAILURE_DOMAIN_SET = new Set<string>(FAILURE_DOMAINS);
const FAILURE_CODE_SET = new Set<string>(FAILURE_CODES);
const FAILURE_STAGE_SET = new Set<string>(FAILURE_STAGES);
const PROVIDER_APIS = new Set<string>(PI_RPC_PROVIDER_APIS);
const FAILURE_PHASES = new Set<string>(PI_RPC_FAILURE_PHASES);
const TRANSCRIPT_SIZE_BUCKETS = new Set<string>(PI_RPC_TRANSCRIPT_SIZE_BUCKETS);
const RETRYABLE_FAILURE_CODES = new Set<FailureCode>([
  "provider_rate_limit",
  "provider_network",
  "provider_timeout",
  "provider_unavailable",
  "validation_infrastructure",
]);

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

export class PiRpcRuntimeFailure extends Error {
  constructor(message: string, readonly diagnostic: SafeRuntimeDiagnostic) {
    super(message);
    this.name = "PiRpcRuntimeFailure";
  }
}

export function piRpcRunnerError(
  failureDomain: PiRpcFailureDomain,
  failureCode: PiRpcFailureCode,
  retryable: boolean,
): PiRpcRunnerError {
  return new PiRpcRunnerError(failureDomain, failureCode, retryable);
}

export function classifyPiRpcRunnerFailure(error: unknown, failureStage: string): ClassifiedRunnerFailure {
  const stage = normalizedFailureStage(failureStage);
  if (error instanceof PiRpcRunnerError) {
    return {
      failureDomain: error.failureDomain,
      failureCode: error.failureCode,
      retryable: error.retryable,
      ...stableRunnerFailure(error.failureDomain, error.failureCode, stage),
      failureStage: stage,
    };
  }

  const systemCode = systemErrorCode(error);
  if (systemCode === "EPIPE" || systemCode === "ECONNRESET") {
    return withStableRunnerFailure("rpc_transport", "rpc_transport_closed", true, stage);
  }
  if (systemCode === "ENOENT" || systemCode === "EACCES") {
    return withStableRunnerFailure("child_process", "child_spawn_failed", false, stage);
  }
  if (failureStage === "credential-postflight") {
    return withStableRunnerFailure("credential", "credential_postflight_failed", false, stage);
  }
  return withStableRunnerFailure("runner_internal", "runner_unclassified", false, stage);
}

export function isPiRpcFailureDomain(value: unknown): value is PiRpcFailureDomain {
  return typeof value === "string" && PI_RPC_FAILURE_DOMAIN_SET.has(value);
}

export function isPiRpcFailureCode(value: unknown): value is PiRpcFailureCode {
  return typeof value === "string" && PI_RPC_FAILURE_CODE_SET.has(value);
}

export function makeSafeRuntimeDiagnostic(
  input: Omit<SafeRuntimeDiagnostic, "diagnosticFingerprint"> & FailureClassification,
): SafeRuntimeDiagnostic & FailureClassification {
  if (input.failureStage !== undefined && input.failureStage !== input.stage) {
    throw new Error("runtime failure stage aliases differ");
  }
  const diagnostic = { ...input, failureStage: input.stage };
  const result = { ...diagnostic, diagnosticFingerprint: safeFingerprint(diagnostic) } as SafeRuntimeDiagnostic & FailureClassification;
  if (!isSafePiRpcDiagnostic(result)) throw new Error("invalid safe runtime diagnostic");
  return result;
}

/**
 * Converts untrusted Provider text into a bounded, content-free diagnostic.
 * The input must never be logged, persisted, or included in the fingerprint.
 */
export function classifyProviderFailure(
  stopReason: "error" | "aborted",
  errorMessage: unknown,
  context: ProviderFailureContext,
): SafeRuntimeDiagnostic {
  const message = typeof errorMessage === "string" ? errorMessage.toLowerCase() : "";
  const httpStatus = extractHttpStatus(message);
  const classified = stopReason === "aborted"
    ? { failureDomain: "runner_internal" as const, failureCode: "assistant_aborted" as const, retryable: false }
    : classifyProviderError(message, httpStatus);
  const stable = stopReason === "aborted"
    ? { domain: "execution" as const, code: "assistant_aborted" as const, stage: "agent-run" as const }
    : stableProviderFailure(classified.failureCode);
  return makeSafeRuntimeDiagnostic({
    ...classified,
    ...stable,
    ...(httpStatus === null ? {} : { httpStatus }),
    providerApi: context.providerApi,
    phase: context.phase,
    turnCount: boundedCount(context.turnCount),
    assistantMessageCount: boundedCount(context.assistantMessageCount),
    toolExecutionCount: boundedCount(context.toolExecutionCount),
    toolErrorCount: boundedCount(context.toolErrorCount),
    transcriptSizeBucket: transcriptSizeBucket(context.transcriptBytes),
  });
}

export function classifyProviderContinuationLost(
  context: ProviderFailureContext,
  childExit: SafeChildExit,
): SafeRuntimeDiagnostic & FailureClassification {
  return makeSafeRuntimeDiagnostic({
    domain: "observation",
    code: "provider_continuation_lost",
    stage: "agent-run",
    failureDomain: "provider",
    failureCode: "provider_continuation_lost",
    retryable: false,
    providerApi: context.providerApi,
    phase: context.phase,
    turnCount: boundedCount(context.turnCount),
    assistantMessageCount: boundedCount(context.assistantMessageCount),
    toolExecutionCount: boundedCount(context.toolExecutionCount),
    toolErrorCount: boundedCount(context.toolErrorCount),
    transcriptSizeBucket: transcriptSizeBucket(context.transcriptBytes),
    childExit,
  });
}

export function isSafePiRpcDiagnostic(value: unknown): value is SafeRuntimeDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((field) => !SAFE_DIAGNOSTIC_FIELD_SET.has(field))) return false;
  const diagnostic = value as Partial<SafeRuntimeDiagnostic>;
  if (
    !isPiRpcFailureDomain(diagnostic.failureDomain)
    || !isPiRpcFailureCode(diagnostic.failureCode)
    || typeof diagnostic.retryable !== "boolean"
    || typeof diagnostic.diagnosticFingerprint !== "string"
    || !/^[0-9a-f]{64}$/.test(diagnostic.diagnosticFingerprint)
  ) return false;
  if (diagnostic.failureDomain === "provider" && !diagnostic.failureCode.startsWith("provider_")) return false;
  if (diagnostic.failureDomain !== "provider" && diagnostic.failureCode.startsWith("provider_")) return false;
  if (diagnostic.failureCode === "assistant_aborted" && (diagnostic.failureDomain !== "runner_internal" || diagnostic.retryable)) return false;
  if (diagnostic.failureCode.startsWith("provider_") && providerRetryable(diagnostic.failureCode) !== diagnostic.retryable) return false;
  const stableFields = [diagnostic.domain, diagnostic.code, diagnostic.stage];
  const stableCount = stableFields.filter((value) => value !== undefined).length;
  if (stableCount !== 0 && stableCount !== stableFields.length) return false;
  if (stableCount > 0 && (
    !FAILURE_DOMAIN_SET.has(diagnostic.domain!)
    || !FAILURE_CODE_SET.has(diagnostic.code!)
    || !FAILURE_STAGE_SET.has(diagnostic.stage!)
    || diagnostic.failureStage !== diagnostic.stage
    || !stableIdentityMatches(diagnostic as SafeRuntimeDiagnostic & FailureClassification)
    || !stableRetryableMatches(diagnostic as SafeRuntimeDiagnostic & FailureClassification)
    || diagnostic.diagnosticFingerprint !== safeFingerprint(withoutFingerprint(diagnostic as SafeRuntimeDiagnostic))
  )) return false;
  if (diagnostic.httpStatus !== undefined && !validHttpStatus(diagnostic.httpStatus)) return false;
  if (diagnostic.providerApi !== undefined && !PROVIDER_APIS.has(diagnostic.providerApi)) return false;
  if (diagnostic.phase !== undefined && !FAILURE_PHASES.has(diagnostic.phase)) return false;
  if (diagnostic.transcriptSizeBucket !== undefined && !TRANSCRIPT_SIZE_BUCKETS.has(diagnostic.transcriptSizeBucket)) return false;
  if (diagnostic.failureStage !== undefined && !FAILURE_STAGE_SET.has(diagnostic.failureStage)) return false;
  if (diagnostic.childExit !== undefined && !validChildExit(diagnostic.childExit)) return false;
  const countsValid = [
    diagnostic.turnCount,
    diagnostic.assistantMessageCount,
    diagnostic.toolExecutionCount,
    diagnostic.toolErrorCount,
  ].every((count) => count === undefined || validCount(count));
  if (!countsValid) return false;
  if (diagnostic.toolErrorCount !== undefined && diagnostic.toolExecutionCount !== undefined
    && diagnostic.toolErrorCount > diagnostic.toolExecutionCount) return false;
  if (diagnostic.failureDomain === "provider" || diagnostic.failureCode === "assistant_aborted") {
    if (
      diagnostic.providerApi === undefined
      || diagnostic.phase === undefined
      || diagnostic.turnCount === undefined
      || diagnostic.assistantMessageCount === undefined
      || diagnostic.toolExecutionCount === undefined
      || diagnostic.toolErrorCount === undefined
      || diagnostic.transcriptSizeBucket === undefined
      || failurePhase(diagnostic.toolExecutionCount, diagnostic.toolErrorCount) !== diagnostic.phase
    ) return false;
  }
  return true;
}

/** Returns null for legacy receipts and rejects partially structured diagnostics. */
export function safePiRpcDiagnosticFrom(value: unknown): SafeRuntimeDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!STRUCTURED_DIAGNOSTIC_MARKERS.some((field) => record[field] !== undefined)) return null;
  const candidate = Object.fromEntries(
    [...STRUCTURED_DIAGNOSTIC_FIELDS, "retryable"]
      .filter((field) => record[field] !== undefined)
      .map((field) => [field, record[field]]),
  );
  if (!isSafePiRpcDiagnostic(candidate)) throw new Error("invalid safe Pi RPC diagnostic");
  return candidate;
}

export function safePiRpcDiagnosticFromError(error: unknown): SafeRuntimeDiagnostic | null {
  return error instanceof PiRpcRuntimeFailure ? error.diagnostic : null;
}

export function formatSafePiRpcDiagnostic(diagnostic: SafeRuntimeDiagnostic): string {
  const parts = [
    diagnostic.domain && diagnostic.code
      ? `${diagnostic.domain}/${diagnostic.code}`
      : `${diagnostic.failureDomain}/${diagnostic.failureCode}`,
    `retryable=${diagnostic.retryable ? "yes" : "no"}`,
  ];
  if (diagnostic.domain) parts.push(`detail=${diagnostic.failureDomain}/${diagnostic.failureCode}`);
  if (diagnostic.providerApi) parts.push(`api=${diagnostic.providerApi}`);
  if (diagnostic.phase) parts.push(`phase=${diagnostic.phase}`);
  if (diagnostic.httpStatus) parts.push(`status=${diagnostic.httpStatus}`);
  if (diagnostic.toolExecutionCount !== undefined) parts.push(`tools=${diagnostic.toolExecutionCount}`);
  if (diagnostic.toolErrorCount !== undefined) parts.push(`toolErrors=${diagnostic.toolErrorCount}`);
  if (diagnostic.transcriptSizeBucket) parts.push(`size=${diagnostic.transcriptSizeBucket}`);
  if (diagnostic.stage ?? diagnostic.failureStage) parts.push(`stage=${diagnostic.stage ?? diagnostic.failureStage}`);
  if (diagnostic.childExit !== undefined) parts.push(`child=${childExitLabel(diagnostic.childExit)}`);
  parts.push(`fingerprint=${diagnostic.diagnosticFingerprint.slice(0, 12)}`);
  return parts.join(", ");
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
  hash.update(stableStringify(value));
  return hash.digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

function withoutFingerprint(diagnostic: SafeRuntimeDiagnostic): object {
  return Object.fromEntries(Object.entries(diagnostic).filter(([key]) => key !== "diagnosticFingerprint"));
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

function validChildExit(value: unknown): value is SafeChildExit {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const exit = value as { code?: unknown; signal?: unknown };
  const validCode = exit.code === null || (Number.isInteger(exit.code) && Number(exit.code) >= 0 && Number(exit.code) <= 255);
  const validSignal = exit.signal === null || (typeof exit.signal === "string" && /^SIG[A-Z0-9]+$/.test(exit.signal));
  if (exit.code === null && exit.signal === null) return true;
  return validCode && validSignal && !((exit.code !== null) === (exit.signal !== null));
}

function childExitLabel(value: SafeChildExit): string {
  if (!value || (value.code === null && value.signal === null)) return "unknown";
  return value.code === null ? `signal:${value.signal}` : `exit:${value.code}`;
}

function providerRetryable(code: PiRpcFailureCode): boolean {
  return code === "provider_rate_limited"
    || code === "provider_timeout"
    || code === "provider_overloaded"
    || code === "provider_upstream_5xx"
    || code === "provider_network";
}

function normalizedFailureStage(value: string): FailureStage {
  return FAILURE_STAGE_SET.has(value) ? value as FailureStage : "startup";
}

function stableProviderFailure(code: PiRpcFailureCode): Omit<FailureClassification, "retryable"> {
  if (code === "provider_authentication" || code === "provider_permission_denied") {
    return { domain: "execution", code: "provider_auth", stage: "agent-run" };
  }
  if (code === "provider_rate_limited") return { domain: "execution", code: "provider_rate_limit", stage: "agent-run" };
  if (code === "provider_timeout") return { domain: "execution", code: "provider_timeout", stage: "agent-run" };
  if (code === "provider_network") return { domain: "execution", code: "provider_network", stage: "agent-run" };
  if (code === "provider_overloaded" || code === "provider_upstream_5xx") {
    return { domain: "execution", code: "provider_unavailable", stage: "agent-run" };
  }
  if (code === "provider_unknown") return { domain: "execution", code: "provider_unknown", stage: "agent-run" };
  return { domain: "execution", code: "provider_rejected", stage: "agent-run" };
}

function withStableRunnerFailure(
  failureDomain: PiRpcFailureDomain,
  failureCode: PiRpcFailureCode,
  retryable: boolean,
  failureStage: FailureStage,
): ClassifiedRunnerFailure {
  return {
    failureDomain,
    failureCode,
    retryable,
    ...stableRunnerFailure(failureDomain, failureCode, failureStage),
    failureStage,
  };
}

function stableRunnerFailure(
  failureDomain: PiRpcFailureDomain,
  failureCode: PiRpcFailureCode,
  stage: FailureStage,
): Omit<FailureClassification, "retryable"> {
  if (failureCode === "rpc_event_oversize" || failureCode === "rpc_line_too_large") {
    return { domain: "observation", code: "rpc_event_oversize", stage };
  }
  if (failureDomain === "rpc_protocol") return { domain: "observation", code: "rpc_protocol", stage };
  if (failureDomain === "rpc_transport") return { domain: "observation", code: "rpc_transport", stage };
  if (failureDomain === "child_process") return { domain: "execution", code: "child_exit", stage };
  if (failureDomain === "credential") return { domain: "execution", code: "credential_integrity", stage };
  if (failureDomain === "runtime") {
    if (failureCode === "runtime_stall") return { domain: "observation", code: "runtime_stall", stage };
    if (failureCode === "attempt_deadline") return { domain: "execution", code: "attempt_deadline", stage };
    if (failureCode === "rpc_terminal_missing") return { domain: "observation", code: "rpc_terminal_missing", stage };
    if (failureCode === "runtime_terminated") return { domain: "execution", code: "runtime_terminated", stage };
  }
  return { domain: "execution", code: "runtime_internal", stage };
}

function stableRetryableMatches(diagnostic: SafeRuntimeDiagnostic & FailureClassification): boolean {
  if (diagnostic.failureDomain === "child_process") {
    return diagnostic.retryable === (diagnostic.failureCode === "child_exit_before_settled");
  }
  if (diagnostic.failureDomain === "rpc_transport") {
    return diagnostic.retryable === (
      diagnostic.failureCode === "rpc_command_timeout" || diagnostic.failureCode === "rpc_transport_closed"
    );
  }
  return RETRYABLE_FAILURE_CODES.has(diagnostic.code) === diagnostic.retryable;
}

function stableIdentityMatches(diagnostic: SafeRuntimeDiagnostic & FailureClassification): boolean {
  const same = (domain: FailureDomain, code: FailureCode): boolean => (
    diagnostic.domain === domain && diagnostic.code === code
  );
  if (diagnostic.failureDomain === "provider") {
    if (diagnostic.failureCode === "provider_continuation_lost") return same("observation", "provider_continuation_lost");
    const stable = stableProviderFailure(diagnostic.failureCode);
    return same(stable.domain, stable.code);
  }
  if (diagnostic.failureDomain === "rpc_protocol") {
    return same("observation", diagnostic.failureCode === "rpc_event_oversize" || diagnostic.failureCode === "rpc_line_too_large"
      ? "rpc_event_oversize"
      : "rpc_protocol");
  }
  if (diagnostic.failureDomain === "rpc_transport") {
    return diagnostic.failureCode === "rpc_stdout_end_timeout"
      ? same("observation", "rpc_terminal_missing")
      : same("observation", "rpc_transport");
  }
  if (diagnostic.failureDomain === "child_process") {
    if (!["child_spawn_failed", "child_exit_before_settled", "child_exit_after_settled", "child_shutdown_unconfirmed"].includes(diagnostic.failureCode)) return false;
    return diagnostic.failureCode === "child_shutdown_unconfirmed"
      ? same("observation", "rpc_terminal_missing")
      : same("execution", "child_exit");
  }
  if (diagnostic.failureDomain === "credential") {
    return diagnostic.failureCode === "credential_postflight_failed" && same("execution", "credential_integrity");
  }
  if (diagnostic.failureDomain === "runner_internal") {
    return diagnostic.failureCode === "assistant_aborted"
      ? same("execution", "assistant_aborted")
      : diagnostic.failureCode === "runner_unclassified" && same("execution", "runtime_internal");
  }
  if (diagnostic.failureDomain === "runtime") {
    return diagnostic.failureCode === "runtime_stall"
      ? same("observation", "runtime_stall")
      : diagnostic.failureCode === "attempt_deadline"
        ? same("execution", "attempt_deadline")
      : diagnostic.failureCode === "rpc_terminal_missing"
        ? same("observation", "rpc_terminal_missing")
        : diagnostic.failureCode === "runtime_terminated" && same("execution", "runtime_terminated");
  }
  if (diagnostic.failureDomain === "result") {
    return diagnostic.failureCode === "result_missing"
      ? same("acceptance", "result_missing")
      : diagnostic.failureCode === "result_identity" && same("acceptance", "result_identity");
  }
  if (diagnostic.failureDomain === "git") return diagnostic.failureCode === "git_integrity" && same("acceptance", "git_integrity");
  if (diagnostic.failureDomain === "policy") return diagnostic.failureCode === "policy_violation" && same("execution", "policy_violation");
  if (diagnostic.failureDomain === "compaction") return diagnostic.failureCode === "compaction_failure" && same("execution", "compaction_failure");
  if (diagnostic.failureDomain === "tool") return diagnostic.failureCode === "tool_contract" && same("execution", "tool_contract");
  if (diagnostic.failureDomain === "validation") {
    return diagnostic.failureCode === "validation_failed"
      ? same("deterministic", "validation_failed")
      : diagnostic.failureCode === "validation_infrastructure" && same("acceptance", "validation_infrastructure");
  }
  return false;
}

function systemErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
