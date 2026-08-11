import { createHash } from "node:crypto";
export const PI_RPC_FAILURE_DOMAINS = [
    "provider",
    "rpc_protocol",
    "rpc_transport",
    "child_process",
    "credential",
    "runner_internal",
];
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
];
export const PI_RPC_PROVIDER_APIS = [
    "anthropic-messages",
    "openai-responses",
    "openai-completions",
    "unknown",
];
export const PI_RPC_FAILURE_PHASES = [
    "initial_generation",
    "tool_continuation",
    "tool_error_recovery",
];
export const PI_RPC_TRANSCRIPT_SIZE_BUCKETS = [
    "lt64k",
    "64k_256k",
    "256k_1m",
    "gte1m",
];
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
];
const STRUCTURED_DIAGNOSTIC_FIELDS = [
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
];
const STRUCTURED_DIAGNOSTIC_MARKERS = ["failureDomain", "failureCode", "diagnosticFingerprint"];
const FAILURE_DOMAINS = new Set(PI_RPC_FAILURE_DOMAINS);
const FAILURE_CODES = new Set(PI_RPC_FAILURE_CODES);
const PROVIDER_APIS = new Set(PI_RPC_PROVIDER_APIS);
const FAILURE_PHASES = new Set(PI_RPC_FAILURE_PHASES);
const TRANSCRIPT_SIZE_BUCKETS = new Set(PI_RPC_TRANSCRIPT_SIZE_BUCKETS);
const FAILURE_STAGES = new Set(PI_RPC_FAILURE_STAGES);
export class PiRpcRunnerError extends Error {
    failureDomain;
    failureCode;
    retryable;
    constructor(failureDomain, failureCode, retryable) {
        super(failureCode);
        this.failureDomain = failureDomain;
        this.failureCode = failureCode;
        this.retryable = retryable;
        this.name = "PiRpcRunnerError";
    }
}
export class PiRpcRuntimeFailure extends Error {
    diagnostic;
    constructor(message, diagnostic) {
        super(message);
        this.diagnostic = diagnostic;
        this.name = "PiRpcRuntimeFailure";
    }
}
export function piRpcRunnerError(failureDomain, failureCode, retryable) {
    return new PiRpcRunnerError(failureDomain, failureCode, retryable);
}
export function classifyPiRpcRunnerFailure(error, failureStage) {
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
export function isPiRpcFailureDomain(value) {
    return typeof value === "string" && FAILURE_DOMAINS.has(value);
}
export function isPiRpcFailureCode(value) {
    return typeof value === "string" && FAILURE_CODES.has(value);
}
/**
 * Converts untrusted Provider text into a bounded, content-free diagnostic.
 * The input must never be logged, persisted, or included in the fingerprint.
 */
export function classifyProviderFailure(stopReason, errorMessage, context) {
    const message = typeof errorMessage === "string" ? errorMessage.toLowerCase() : "";
    const httpStatus = extractHttpStatus(message);
    const classified = stopReason === "aborted"
        ? { failureDomain: "runner_internal", failureCode: "assistant_aborted", retryable: false }
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
export function isSafePiRpcDiagnostic(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const diagnostic = value;
    if (!isPiRpcFailureDomain(diagnostic.failureDomain)
        || !isPiRpcFailureCode(diagnostic.failureCode)
        || typeof diagnostic.retryable !== "boolean"
        || typeof diagnostic.diagnosticFingerprint !== "string"
        || !/^[0-9a-f]{64}$/.test(diagnostic.diagnosticFingerprint))
        return false;
    if (diagnostic.failureDomain === "provider" && !diagnostic.failureCode.startsWith("provider_"))
        return false;
    if (diagnostic.failureDomain !== "provider" && diagnostic.failureCode.startsWith("provider_"))
        return false;
    if (diagnostic.failureCode === "assistant_aborted" && (diagnostic.failureDomain !== "runner_internal" || diagnostic.retryable))
        return false;
    if (diagnostic.failureCode.startsWith("provider_") && providerRetryable(diagnostic.failureCode) !== diagnostic.retryable)
        return false;
    if (diagnostic.httpStatus !== undefined && !validHttpStatus(diagnostic.httpStatus))
        return false;
    if (diagnostic.providerApi !== undefined && !PROVIDER_APIS.has(diagnostic.providerApi))
        return false;
    if (diagnostic.phase !== undefined && !FAILURE_PHASES.has(diagnostic.phase))
        return false;
    if (diagnostic.transcriptSizeBucket !== undefined && !TRANSCRIPT_SIZE_BUCKETS.has(diagnostic.transcriptSizeBucket))
        return false;
    if (diagnostic.failureStage !== undefined && !FAILURE_STAGES.has(diagnostic.failureStage))
        return false;
    if (diagnostic.childExit !== undefined && !validChildExit(diagnostic.childExit))
        return false;
    const countsValid = [
        diagnostic.turnCount,
        diagnostic.assistantMessageCount,
        diagnostic.toolExecutionCount,
        diagnostic.toolErrorCount,
    ].every((count) => count === undefined || validCount(count));
    if (!countsValid)
        return false;
    if (diagnostic.toolErrorCount !== undefined && diagnostic.toolExecutionCount !== undefined
        && diagnostic.toolErrorCount > diagnostic.toolExecutionCount)
        return false;
    if (diagnostic.failureDomain === "provider" || diagnostic.failureCode === "assistant_aborted") {
        if (diagnostic.providerApi === undefined
            || diagnostic.phase === undefined
            || diagnostic.turnCount === undefined
            || diagnostic.assistantMessageCount === undefined
            || diagnostic.toolExecutionCount === undefined
            || diagnostic.toolErrorCount === undefined
            || diagnostic.transcriptSizeBucket === undefined
            || failurePhase(diagnostic.toolExecutionCount, diagnostic.toolErrorCount) !== diagnostic.phase)
            return false;
    }
    return true;
}
/** Returns null for legacy receipts and rejects partially structured diagnostics. */
export function safePiRpcDiagnosticFrom(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const record = value;
    if (!STRUCTURED_DIAGNOSTIC_MARKERS.some((field) => record[field] !== undefined))
        return null;
    const candidate = Object.fromEntries([...STRUCTURED_DIAGNOSTIC_FIELDS, "retryable"]
        .filter((field) => record[field] !== undefined)
        .map((field) => [field, record[field]]));
    if (!isSafePiRpcDiagnostic(candidate))
        throw new Error("invalid safe Pi RPC diagnostic");
    return candidate;
}
export function safePiRpcDiagnosticFromError(error) {
    return error instanceof PiRpcRuntimeFailure ? error.diagnostic : null;
}
export function formatSafePiRpcDiagnostic(diagnostic) {
    const parts = [
        `${diagnostic.failureDomain}/${diagnostic.failureCode}`,
        `retryable=${diagnostic.retryable ? "yes" : "no"}`,
    ];
    if (diagnostic.providerApi)
        parts.push(`api=${diagnostic.providerApi}`);
    if (diagnostic.phase)
        parts.push(`phase=${diagnostic.phase}`);
    if (diagnostic.httpStatus)
        parts.push(`status=${diagnostic.httpStatus}`);
    if (diagnostic.toolExecutionCount !== undefined)
        parts.push(`tools=${diagnostic.toolExecutionCount}`);
    if (diagnostic.toolErrorCount !== undefined)
        parts.push(`toolErrors=${diagnostic.toolErrorCount}`);
    if (diagnostic.transcriptSizeBucket)
        parts.push(`size=${diagnostic.transcriptSizeBucket}`);
    if (diagnostic.failureStage)
        parts.push(`stage=${diagnostic.failureStage}`);
    if (diagnostic.childExit !== undefined)
        parts.push(`child=${childExitLabel(diagnostic.childExit)}`);
    parts.push(`fingerprint=${diagnostic.diagnosticFingerprint.slice(0, 12)}`);
    return parts.join(", ");
}
export function providerApi(value) {
    return typeof value === "string" && PROVIDER_APIS.has(value) ? value : "unknown";
}
export function failurePhase(toolExecutionCount, toolErrorCount) {
    if (toolErrorCount > 0)
        return "tool_error_recovery";
    return toolExecutionCount > 0 ? "tool_continuation" : "initial_generation";
}
function classifyProviderError(message, httpStatus) {
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
function extractHttpStatus(message) {
    const match = /(?:http|status(?:code)?|code)?[\s:=\"']*\b([45]\d\d)\b/.exec(message);
    if (!match)
        return null;
    const status = Number(match[1]);
    return validHttpStatus(status) ? status : null;
}
function transcriptSizeBucket(bytes) {
    if (!Number.isFinite(bytes) || bytes < 64 * 1024)
        return "lt64k";
    if (bytes < 256 * 1024)
        return "64k_256k";
    if (bytes < 1024 * 1024)
        return "256k_1m";
    return "gte1m";
}
function safeFingerprint(value) {
    const hash = createHash("sha256");
    hash.update(JSON.stringify(value));
    return hash.digest("hex");
}
function boundedCount(value) {
    if (!Number.isFinite(value) || value <= 0)
        return 0;
    return Math.min(Math.floor(value), 1_000_000);
}
function validCount(value) {
    return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;
}
function validHttpStatus(value) {
    return Number.isInteger(value) && Number(value) >= 400 && Number(value) <= 599;
}
function validChildExit(value) {
    if (value === null)
        return true;
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const exit = value;
    const validCode = exit.code === null || (Number.isInteger(exit.code) && Number(exit.code) >= 0 && Number(exit.code) <= 255);
    const validSignal = exit.signal === null || (typeof exit.signal === "string" && /^SIG[A-Z0-9]+$/.test(exit.signal));
    if (exit.code === null && exit.signal === null)
        return true;
    return validCode && validSignal && !((exit.code !== null) === (exit.signal !== null));
}
function childExitLabel(value) {
    if (!value || (value.code === null && value.signal === null))
        return "unknown";
    return value.code === null ? `signal:${value.signal}` : `exit:${value.code}`;
}
function providerRetryable(code) {
    return code === "provider_rate_limited"
        || code === "provider_timeout"
        || code === "provider_overloaded"
        || code === "provider_upstream_5xx"
        || code === "provider_network";
}
function systemErrorCode(error) {
    if (!error || typeof error !== "object" || !("code" in error))
        return null;
    const code = error.code;
    return typeof code === "string" ? code : null;
}
//# sourceMappingURL=pi-rpc-diagnostics.js.map