import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyPiRpcRunnerFailure,
  classifyProviderFailure,
  FAILURE_CODES,
  FAILURE_DOMAINS,
  FAILURE_STAGES,
  isSafePiRpcDiagnostic,
  makeSafeRuntimeDiagnostic,
  providerApi,
  safePiRpcDiagnosticFromError,
  type PiRpcFailureCode,
  type ProviderFailureContext,
} from "../src/pi-rpc-diagnostics.js";
import { CredentialStartupError } from "../src/credential-startup.js";

const context: ProviderFailureContext = {
  providerApi: "anthropic-messages",
  phase: "tool_continuation",
  turnCount: 2,
  assistantMessageCount: 3,
  toolExecutionCount: 1,
  toolErrorCount: 0,
  transcriptBytes: 70_000,
};

test("Provider failures are classified into safe, bounded diagnostics", () => {
  const cases: Array<[string, PiRpcFailureCode, boolean, number | undefined]> = [
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
    assert.equal(diagnostic.domain, "execution", message);
    assert.equal(diagnostic.stage, "agent-run", message);
    assert.equal(diagnostic.retryable, retryable, message);
    assert.equal(diagnostic.httpStatus, httpStatus, message);
    assert.equal(diagnostic.providerApi, "anthropic-messages");
    assert.equal(diagnostic.phase, "tool_continuation");
    assert.equal(diagnostic.transcriptSizeBucket, "64k_256k");
    assert.match(diagnostic.diagnosticFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(isSafePiRpcDiagnostic(diagnostic), true);
  }
});

test("runtime failure taxonomy exposes the stable cross-layer baseline", () => {
  assert.deepEqual(FAILURE_DOMAINS, ["execution", "observation", "acceptance", "deterministic"]);
  for (const code of [
    "provider_auth",
    "provider_rate_limit",
    "provider_network",
    "provider_timeout",
    "provider_continuation_lost",
    "credential_lock_timeout",
    "credential_lock_stale",
    "oauth_refresh_timeout",
    "oauth_missing",
    "oauth_probe_failed",
    "rpc_protocol",
    "rpc_event_oversize",
    "rpc_terminal_missing",
    "runtime_stall",
    "attempt_deadline",
    "child_exit",
    "tool_contract",
    "result_missing",
    "result_identity",
    "git_integrity",
    "policy_violation",
    "compaction_failure",
    "validation_infrastructure",
    "validation_failed",
  ]) assert.equal(FAILURE_CODES.includes(code as never), true, code);
  for (const stage of ["agent-run", "terminal-observation", "result-validation", "git-verification", "review-validation"]) {
    assert.equal(FAILURE_STAGES.includes(stage as never), true, stage);
  }

  const missing = makeSafeRuntimeDiagnostic({
    domain: "acceptance",
    code: "result_missing",
    stage: "result-validation",
    failureDomain: "result",
    failureCode: "result_missing",
    retryable: false,
  });
  assert.equal(isSafePiRpcDiagnostic(missing), true);
  assert.equal(isSafePiRpcDiagnostic({ ...missing, code: undefined }), false);
  assert.equal(isSafePiRpcDiagnostic({ ...missing, retryable: true }), false);
  assert.equal(isSafePiRpcDiagnostic({ ...missing, accessToken: "MUST_NOT_LEAK" }), false);

  const childExit = makeSafeRuntimeDiagnostic({
    domain: "execution",
    code: "child_exit",
    stage: "agent-run",
    failureDomain: "child_process",
    failureCode: "child_exit_before_settled",
    retryable: true,
    childExit: { code: 23, signal: null },
  });
  assert.equal(isSafePiRpcDiagnostic(childExit), true);
  assert.equal(isSafePiRpcDiagnostic({ ...childExit, retryable: false }), false);
  assert.equal(isSafePiRpcDiagnostic({ ...childExit, childExit: { code: 24, signal: null } }), false);

  const terminalMissing = makeSafeRuntimeDiagnostic({
    domain: "observation",
    code: "rpc_terminal_missing",
    stage: "child-shutdown",
    failureDomain: "child_process",
    failureCode: "child_shutdown_unconfirmed",
    retryable: false,
  });
  assert.equal(isSafePiRpcDiagnostic(terminalMissing), true);
  assert.equal(isSafePiRpcDiagnostic({ ...terminalMissing, failureCode: "child_exit_after_settled" }), false);

  const deadline = makeSafeRuntimeDiagnostic({
    domain: "execution",
    code: "attempt_deadline",
    stage: "agent-run",
    failureDomain: "runtime",
    failureCode: "attempt_deadline",
    retryable: false,
  });
  assert.equal(isSafePiRpcDiagnostic(deadline), true);
  assert.equal(isSafePiRpcDiagnostic({ ...deadline, code: "provider_timeout" }), false);
});

test("credential startup failures keep the five stable content-free codes", () => {
  for (const code of [
    "credential_lock_timeout",
    "credential_lock_stale",
    "oauth_refresh_timeout",
    "oauth_missing",
    "oauth_probe_failed",
  ] as const) {
    const classified = classifyPiRpcRunnerFailure(new CredentialStartupError(code), "handshake");
    assert.equal(classified.failureDomain, "credential");
    assert.equal(classified.failureCode, code);
    assert.equal(classified.code, code);
    assert.equal(classified.retryable, code === "credential_lock_timeout" || code === "oauth_refresh_timeout");
    assert.equal(JSON.stringify(classified).includes("token"), false);
    const runtime = safePiRpcDiagnosticFromError(new CredentialStartupError(code));
    assert.equal(runtime?.code, code);
    assert.equal(runtime?.stage, "startup");
  }
});

test("canonical Codex Responses API remains identifiable in safe diagnostics", () => {
  assert.equal(providerApi("openai-codex-responses"), "openai-codex-responses");
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
  const overloaded = classifyProviderFailure("error", "HTTP 529 overloaded_error", context);
  assert.equal(isSafePiRpcDiagnostic({ ...overloaded, retryable: false }), false);
  assert.equal(isSafePiRpcDiagnostic({ ...overloaded, code: "result_missing" }), false);
  assert.equal(isSafePiRpcDiagnostic({ ...overloaded, phase: "initial_generation" }), false);
  assert.equal(isSafePiRpcDiagnostic({ ...overloaded, toolErrorCount: 2 }), false);
  assert.equal(isSafePiRpcDiagnostic({ ...overloaded, failureStage: "unknown-stage" }), false);
  assert.equal(isSafePiRpcDiagnostic({ ...overloaded, childExit: { code: 23, signal: "SIGTERM" } }), false);
});
