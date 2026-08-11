import test from "node:test";
import assert from "node:assert/strict";
import { classifyProviderFailure, isSafePiRpcDiagnostic, } from "../src/pi-rpc-diagnostics.js";
const context = {
    providerApi: "anthropic-messages",
    phase: "tool_continuation",
    turnCount: 2,
    assistantMessageCount: 3,
    toolExecutionCount: 1,
    toolErrorCount: 0,
    transcriptBytes: 70_000,
};
test("Provider failures are classified into safe, bounded diagnostics", () => {
    const cases = [
        ["HTTP 429 rate limit", "provider_rate_limited", true, 429],
        ["status=401 authentication failed", "provider_authentication", false, 401],
        ["HTTP 403 forbidden", "provider_permission_denied", false, 403],
        ["request_too_large", "provider_request_too_large", false, undefined],
        ["HTTP 413 payload too large", "provider_request_too_large", false, 413],
        ["maximum context window exceeded", "provider_context_limit", false, undefined],
        ["HTTP 504 gateway timeout", "provider_timeout", true, 504],
        ["overloaded_error", "provider_overloaded", true, undefined],
        ["HTTP 529 overloaded", "provider_overloaded", true, 529],
        ["HTTP 503 service unavailable", "provider_upstream_5xx", true, 503],
        ["ECONNRESET during fetch", "provider_network", true, undefined],
        ["invalid_request_error", "provider_request_invalid", false, undefined],
        ["unrecognized Provider failure", "provider_unknown", false, undefined],
    ];
    for (const [message, failureCode, retryable, httpStatus] of cases) {
        const diagnostic = classifyProviderFailure("error", message, context);
        assert.equal(diagnostic.failureDomain, "provider", message);
        assert.equal(diagnostic.failureCode, failureCode, message);
        assert.equal(diagnostic.retryable, retryable, message);
        assert.equal(diagnostic.httpStatus, httpStatus, message);
        assert.equal(diagnostic.providerApi, "anthropic-messages");
        assert.equal(diagnostic.phase, "tool_continuation");
        assert.equal(diagnostic.transcriptSizeBucket, "64k_256k");
        assert.match(diagnostic.diagnosticFingerprint, /^[0-9a-f]{64}$/);
        assert.equal(isSafePiRpcDiagnostic(diagnostic), true);
    }
});
test("Provider diagnostic fingerprints never depend on secret error text", () => {
    const first = classifyProviderFailure("error", "HTTP 429 token=FIRST_SECRET", context);
    const second = classifyProviderFailure("error", "HTTP 429 token=SECOND_SECRET", context);
    assert.equal(first.diagnosticFingerprint, second.diagnosticFingerprint);
    assert.equal(JSON.stringify(first).includes("FIRST_SECRET"), false);
    assert.equal(JSON.stringify(second).includes("SECOND_SECRET"), false);
});
test("assistant aborts and malformed diagnostics fail closed", () => {
    const aborted = classifyProviderFailure("aborted", "access_token_SECRET", {
        ...context,
        providerApi: "unknown",
        phase: "initial_generation",
        toolExecutionCount: 0,
    });
    assert.equal(aborted.failureDomain, "runner_internal");
    assert.equal(aborted.failureCode, "assistant_aborted");
    assert.equal(aborted.retryable, false);
    assert.equal(isSafePiRpcDiagnostic(aborted), true);
    assert.equal(isSafePiRpcDiagnostic({ ...aborted, httpStatus: 200 }), false);
    assert.equal(isSafePiRpcDiagnostic({ ...aborted, toolExecutionCount: -1 }), false);
    assert.equal(isSafePiRpcDiagnostic({ ...aborted, failureDomain: "provider" }), false);
});
//# sourceMappingURL=pi-rpc-diagnostics.test.js.map