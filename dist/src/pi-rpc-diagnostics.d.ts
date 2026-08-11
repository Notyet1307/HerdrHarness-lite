export declare const PI_RPC_FAILURE_DOMAINS: readonly ["rpc_protocol", "rpc_transport", "child_process", "credential", "runner_internal"];
export declare const PI_RPC_FAILURE_CODES: readonly ["rpc_line_too_large", "rpc_invalid_json", "rpc_incomplete_jsonl", "rpc_record_not_object", "rpc_event_missing_type", "rpc_response_missing_identity", "rpc_unknown_response_id", "rpc_command_mismatch", "rpc_command_failed", "rpc_command_timeout", "rpc_transport_closed", "rpc_stdout_end_timeout", "child_spawn_failed", "child_exit_before_settled", "child_exit_after_settled", "child_shutdown_unconfirmed", "credential_postflight_failed", "runner_unclassified"];
export type PiRpcFailureDomain = typeof PI_RPC_FAILURE_DOMAINS[number];
export type PiRpcFailureCode = typeof PI_RPC_FAILURE_CODES[number];
export type PiRpcFailureDiagnostic = {
    failureDomain: PiRpcFailureDomain;
    failureCode: PiRpcFailureCode;
    retryable: boolean;
};
export declare class PiRpcRunnerError extends Error {
    readonly failureDomain: PiRpcFailureDomain;
    readonly failureCode: PiRpcFailureCode;
    readonly retryable: boolean;
    constructor(failureDomain: PiRpcFailureDomain, failureCode: PiRpcFailureCode, retryable: boolean);
}
export declare function piRpcRunnerError(failureDomain: PiRpcFailureDomain, failureCode: PiRpcFailureCode, retryable: boolean): PiRpcRunnerError;
export declare function classifyPiRpcRunnerFailure(error: unknown, failureStage: string): PiRpcFailureDiagnostic;
export declare function isPiRpcFailureDomain(value: unknown): value is PiRpcFailureDomain;
export declare function isPiRpcFailureCode(value: unknown): value is PiRpcFailureCode;
