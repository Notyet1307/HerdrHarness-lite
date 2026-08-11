export const PI_RPC_FAILURE_DOMAINS = [
  "rpc_protocol",
  "rpc_transport",
  "child_process",
  "credential",
  "runner_internal",
] as const;

export const PI_RPC_FAILURE_CODES = [
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

const FAILURE_DOMAINS = new Set<string>(PI_RPC_FAILURE_DOMAINS);
const FAILURE_CODES = new Set<string>(PI_RPC_FAILURE_CODES);

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

function systemErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
