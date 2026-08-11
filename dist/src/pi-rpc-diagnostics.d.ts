export declare const PI_RPC_FAILURE_DOMAINS: readonly ["provider", "rpc_protocol", "rpc_transport", "child_process", "credential", "runner_internal"];
export declare const PI_RPC_FAILURE_CODES: readonly ["provider_rate_limited", "provider_authentication", "provider_permission_denied", "provider_request_invalid", "provider_request_too_large", "provider_context_limit", "provider_timeout", "provider_overloaded", "provider_upstream_5xx", "provider_network", "provider_unknown", "assistant_aborted", "rpc_line_too_large", "rpc_invalid_json", "rpc_incomplete_jsonl", "rpc_record_not_object", "rpc_event_missing_type", "rpc_response_missing_identity", "rpc_unknown_response_id", "rpc_command_mismatch", "rpc_command_failed", "rpc_command_timeout", "rpc_transport_closed", "rpc_stdout_end_timeout", "child_spawn_failed", "child_exit_before_settled", "child_exit_after_settled", "child_shutdown_unconfirmed", "credential_postflight_failed", "runner_unclassified"];
export type PiRpcFailureDomain = typeof PI_RPC_FAILURE_DOMAINS[number];
export type PiRpcFailureCode = typeof PI_RPC_FAILURE_CODES[number];
export type PiRpcFailureDiagnostic = {
    failureDomain: PiRpcFailureDomain;
    failureCode: PiRpcFailureCode;
    retryable: boolean;
};
export declare const PI_RPC_PROVIDER_APIS: readonly ["anthropic-messages", "openai-responses", "openai-completions", "unknown"];
export declare const PI_RPC_FAILURE_PHASES: readonly ["initial_generation", "tool_continuation", "tool_error_recovery"];
export declare const PI_RPC_TRANSCRIPT_SIZE_BUCKETS: readonly ["lt64k", "64k_256k", "256k_1m", "gte1m"];
export declare const PI_RPC_FAILURE_STAGES: readonly ["startup", "handshake", "await-dispatch", "dispatch", "agent-run", "child-shutdown", "rpc-output", "credential-postflight", "child-exit"];
export type PiRpcProviderApi = typeof PI_RPC_PROVIDER_APIS[number];
export type PiRpcFailurePhase = typeof PI_RPC_FAILURE_PHASES[number];
export type PiRpcTranscriptSizeBucket = typeof PI_RPC_TRANSCRIPT_SIZE_BUCKETS[number];
export type PiRpcFailureStage = typeof PI_RPC_FAILURE_STAGES[number];
export type SafeChildExit = {
    code: number | null;
    signal: string | null;
} | null;
export type SafeRuntimeDiagnostic = PiRpcFailureDiagnostic & {
    diagnosticFingerprint: string;
    httpStatus?: number;
    providerApi?: PiRpcProviderApi;
    phase?: PiRpcFailurePhase;
    turnCount?: number;
    assistantMessageCount?: number;
    toolExecutionCount?: number;
    toolErrorCount?: number;
    transcriptSizeBucket?: PiRpcTranscriptSizeBucket;
    failureStage?: PiRpcFailureStage;
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
export declare class PiRpcRunnerError extends Error {
    readonly failureDomain: PiRpcFailureDomain;
    readonly failureCode: PiRpcFailureCode;
    readonly retryable: boolean;
    constructor(failureDomain: PiRpcFailureDomain, failureCode: PiRpcFailureCode, retryable: boolean);
}
export declare class PiRpcRuntimeFailure extends Error {
    readonly diagnostic: SafeRuntimeDiagnostic;
    constructor(message: string, diagnostic: SafeRuntimeDiagnostic);
}
export declare function piRpcRunnerError(failureDomain: PiRpcFailureDomain, failureCode: PiRpcFailureCode, retryable: boolean): PiRpcRunnerError;
export declare function classifyPiRpcRunnerFailure(error: unknown, failureStage: string): PiRpcFailureDiagnostic;
export declare function isPiRpcFailureDomain(value: unknown): value is PiRpcFailureDomain;
export declare function isPiRpcFailureCode(value: unknown): value is PiRpcFailureCode;
/**
 * Converts untrusted Provider text into a bounded, content-free diagnostic.
 * The input must never be logged, persisted, or included in the fingerprint.
 */
export declare function classifyProviderFailure(stopReason: "error" | "aborted", errorMessage: unknown, context: ProviderFailureContext): SafeRuntimeDiagnostic;
export declare function isSafePiRpcDiagnostic(value: unknown): value is SafeRuntimeDiagnostic;
/** Returns null for legacy receipts and rejects partially structured diagnostics. */
export declare function safePiRpcDiagnosticFrom(value: unknown): SafeRuntimeDiagnostic | null;
export declare function safePiRpcDiagnosticFromError(error: unknown): SafeRuntimeDiagnostic | null;
export declare function formatSafePiRpcDiagnostic(diagnostic: SafeRuntimeDiagnostic): string;
export declare function providerApi(value: unknown): PiRpcProviderApi;
export declare function failurePhase(toolExecutionCount: number, toolErrorCount: number): PiRpcFailurePhase;
