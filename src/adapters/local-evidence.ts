import { Buffer } from "node:buffer";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isWorkerControlledCompactionPolicy } from "../compatibility.js";
import { digest, type Attempt, type EvidenceItem, type EvidenceRequest, type Job } from "../model.js";
import { isControlledCompactionFailureCode } from "../pi-rpc-compaction-compat.js";
import type { EvidencePort } from "../ports.js";
import { type CommandRunner, SyncCommandRunner } from "./command.js";

const MAX_ITEM = 16_000;

/** Read-only, bounded evidence collector. It never executes Analyst-supplied shell. */
export class LocalEvidence implements EvidencePort {
  constructor(
    private readonly runner: CommandRunner = new SyncCommandRunner(),
    private readonly stateDir: string | null = null,
  ) {}

  async initial(job: Job): Promise<{ items: EvidenceItem[]; missing: string[] }> {
    const items: EvidenceItem[] = [
      item("task", "ledger.task", JSON.stringify(job.task)),
      item(
        "job",
        "ledger.job",
        JSON.stringify({
          id: job.id,
          revision: job.revision,
          state: job.state,
          baseSha: job.baseSha,
          headSha: job.headSha,
          branch: job.branch,
          reviewRound: job.reviewRound,
          ciReworkCount: job.ciReworkCount ?? 0,
          lastError: job.lastError,
        }),
      ),
    ];
    if (job.incident) items.push(item("incident", "ledger.incident", JSON.stringify(job.incident)));
    if (job.incident?.runtimeDiagnostic) {
      items.push(item("runtime-diagnostic", "ledger.incident.runtimeDiagnostic", JSON.stringify(job.incident.runtimeDiagnostic)));
    }
    if (job.ciFailure) items.push(item("ci-checks", "github.required-checks", JSON.stringify(job.ciFailure)));
    if (job.activeAttempt) items.push(item("active-attempt", "ledger.activeAttempt", JSON.stringify(attemptSummary(job.activeAttempt))));
    const lastReview = [...job.attempts].reverse().find((attempt) => attempt.lane === "reviewer" && attempt.result);
    if (lastReview) items.push(item("last-review", "ledger.attempts", JSON.stringify(lastReview.result)));

    const missing: string[] = [];
    if (!job.worktree) missing.push("worktree");
    else {
      const status = this.runGit(job.worktree.path, ["status", "--short", "--branch"]);
      if (status === null) missing.push("git_status");
      else {
        items.push(item("git-status", "git status --short --branch", status));
        const progress = this.worktreeProgress(job);
        if (progress) items.push(progress);
      }
    }
    return { items, missing };
  }

  async collect(job: Job, requests: EvidenceRequest[]): Promise<EvidenceItem[]> {
    const results: EvidenceItem[] = [];
    for (const request of requests) {
      const evidence = this.collectOne(job, request);
      if (evidence) results.push(evidence);
    }
    return results;
  }

  private collectOne(job: Job, request: EvidenceRequest): EvidenceItem | null {
    switch (request.kind) {
      case "issue_context":
        return item("issue-context", "ledger.task", JSON.stringify(job.task));
      case "attempt_result":
        return item(
          `attempt-${job.activeAttempt?.id ?? "none"}`,
          "ledger.activeAttempt",
          JSON.stringify(job.activeAttempt?.result ?? (job.activeAttempt ? attemptSummary(job.activeAttempt) : null)),
        );
      case "attempt_runtime":
        return this.attemptRuntime(job);
      case "attempt_history":
        return this.attemptHistory(job);
      case "controller_health":
        return this.controllerHealth(job);
      case "git_status": {
        if (!job.worktree) return null;
        const output = this.runGit(job.worktree.path, ["status", "--short", "--branch"]);
        return output === null ? null : item("git-status-expanded", "git status --short --branch", output);
      }
      case "git_diff": {
        const progress = this.worktreeProgress(job);
        return progress === null ? null : item("git-diff-stat", progress.source, progress.summary);
      }
      case "worktree_progress":
        return this.worktreeProgress(job);
      case "test_output": {
        if (!job.worktree) return null;
        const path = resolve(job.worktree.path, ".harness", "last-test.log");
        return existsSync(path) ? item("test-output", path, readBounded(path)) : null;
      }
      case "file_excerpt": {
        if (!job.worktree || !request.path) return null;
        const root = resolve(job.worktree.path);
        const path = resolve(root, request.path);
        if (path !== root && !path.startsWith(`${root}/`)) return null;
        return existsSync(path) ? item(`file:${request.path}`, path, readBounded(path)) : null;
      }
    }
  }

  private runGit(path: string, args: string[]): string | null {
    const result = this.runner.run("git", ["-C", path, ...args], { timeoutMs: 15_000 });
    return result.ok ? bounded(result.stdout) : null;
  }

  private worktreeProgress(job: Job): EvidenceItem | null {
    if (!job.worktree) return null;
    const commands = {
      status: ["status", "--short", "--branch"],
      committed: ["diff", "--stat", `${job.baseSha}...HEAD`],
      stagedStat: ["diff", "--cached", "--stat"],
      stagedNames: ["diff", "--cached", "--name-status"],
      unstagedStat: ["diff", "--stat"],
      unstagedNames: ["diff", "--name-status"],
      untracked: ["ls-files", "--others", "--exclude-standard"],
    } satisfies Record<string, string[]>;
    const output: Record<string, string | null> = {};
    for (const [name, args] of Object.entries(commands)) output[name] = this.runGit(job.worktree.path, args);
    return item("worktree-progress", "bounded git worktree progress", JSON.stringify(output));
  }

  private attemptRuntime(job: Job): EvidenceItem | null {
    const attempt = job.activeAttempt;
    if (!attempt) return null;
    const runtime = this.runtimeDirectory(job.id, attempt.lane, attempt.id);
    return item("attempt-runtime", "ledger attempt plus bounded runtime receipts", JSON.stringify({
      attempt: attemptSummary(attempt),
      receipts: runtime === null ? null : receiptSummary(runtime),
    }));
  }

  private attemptHistory(job: Job): EvidenceItem {
    const attempts = [...job.attempts];
    if (job.activeAttempt && !attempts.some((entry) => entry.id === job.activeAttempt!.id)) attempts.push(job.activeAttempt);
    const history = attempts.slice(-5).map((attempt) => {
      const runtime = this.runtimeDirectory(job.id, attempt.lane, attempt.id);
      return {
        attempt: attemptSummary(attempt),
        terminal: runtime === null ? null : readSelectedJson(join(runtime, "terminal.json")),
      };
    });
    return item("attempt-history", "ledger attempts plus bounded terminal receipts", JSON.stringify(history));
  }

  private controllerHealth(job: Job): EvidenceItem | null {
    if (this.stateDir === null) return null;
    const heartbeat = readSelectedJson(join(this.stateDir, "controller-heartbeat.json"));
    const log = readTail(join(this.stateDir, "controller.log"), 64 * 1024)
      ?.split("\n")
      .filter((line) => line.includes(job.id) || (job.activeAttempt !== null && line.includes(job.activeAttempt.id)))
      .slice(-20);
    return item("controller-health", "bounded heartbeat and task controller log", JSON.stringify({ heartbeat, log: log ?? null }));
  }

  private runtimeDirectory(jobId: string, lane: Attempt["lane"], attemptId: string): string | null {
    if (this.stateDir === null) return null;
    return join(this.stateDir, `${lane}-attempts`, jobId, attemptId, "runtime");
  }
}

function attemptSummary(attempt: Attempt): unknown {
  return {
    id: attempt.id,
    lane: attempt.lane,
    phase: attempt.phase,
    round: attempt.round,
    baseSha: attempt.baseSha,
    expectedHeadSha: attempt.expectedHeadSha,
    result: attempt.result,
    reviewerValidationReceipt: attempt.reviewerValidationReceipt ?? null,
    reconciliationAttempts: attempt.reconciliationAttempts ?? 0,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    runtime: attempt.executionSnapshot
      ? {
          adapter: attempt.executionSnapshot.adapter,
          runtimeVersion: attempt.executionSnapshot.runtimeVersion,
          provider: attempt.executionSnapshot.provider,
          model: attempt.executionSnapshot.model,
          thinking: attempt.executionSnapshot.thinking,
          compactionMode: attempt.executionSnapshot.compactionMode,
          ...(attempt.executionSnapshot.compactionPolicy
            ? { compactionPolicy: attempt.executionSnapshot.compactionPolicy }
            : {}),
          credentialMode: attempt.executionSnapshot.credentialMode,
          runtimeTimeouts: attempt.executionSnapshot.runtimeTimeouts ?? null,
          runtimeDeadlineAt: attempt.executionSnapshot.runtimeDeadlineAt ?? null,
          validationTimeoutMs: attempt.executionSnapshot.validationTimeoutMs ?? null,
        }
      : null,
  };
}

function receiptSummary(runtime: string): Record<string, unknown> {
  return Object.fromEntries(
    [
      "owner", "ready", "accepted", "runtime-progress", "terminating", "terminal", "terminated",
      "validation-progress", "validation-terminate", "validation-terminating", "validation-terminated",
    ].map((name) => [
      name,
      readSelectedJson(join(runtime, `${name}.json`)),
    ]),
  );
}

function readSelectedJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const allowed = [
      "version", "attemptId", "generation", "planDigest", "ok", "dispatchId", "credentialMode", "compactionMode",
      "autoRetryDisableAccepted", "autoCompactionEnabled", "domain", "code", "stage", "failureStage", "failureDomain",
      "failureCode", "retryable", "providerApi", "phase", "turnCount", "assistantMessageCount",
      "toolExecutionCount", "toolErrorCount", "transcriptSizeBucket", "diagnosticFingerprint", "childExit",
      "assistantContentObserved", "toolCallObserved", "toolExecutionStarted", "durableResultPresent",
      "worktreeChanged", "commitCreated",
      "agentSettled", "reason", "updatedAt", "parentPid", "lastProgressAt", "lastProgressType", "eventCount",
      "elapsedMs", "resultPresent", "runnerPid", "childPid", "digest", "exitCode", "signal", "timeout",
    ];
    const controlledCompaction = safeCompactionReceipt(value.controlledCompaction);
    return {
      ...Object.fromEntries(allowed.filter((key) => key in value).map((key) => [key, value[key]])),
      ...(isWorkerControlledCompactionPolicy(value.compactionPolicy)
        ? { compactionPolicy: value.compactionPolicy }
        : {}),
      ...(controlledCompaction
        ? { controlledCompaction }
        : {}),
    };
  } catch {
    return { unreadable: true };
  }
}

export function safeCompactionReceipt(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  const allowed = [
    "count", "reason", "triggerPercent", "contextTokens", "contextWindow", "payloadByteEstimate", "attemptCount",
    "summaryRequestDurationMs", "usedRetry", "outcome", "tokensBefore", "estimatedTokensAfter", "summaryDigest",
    "failureDomain", "failureCode", "willRetry",
  ];
  if (Object.keys(receipt).some((key) => !allowed.includes(key))
    || receipt.count !== 1 || receipt.reason !== "threshold" || receipt.triggerPercent !== 75 || receipt.willRetry !== false
    || !Number.isSafeInteger(receipt.contextTokens) || Number(receipt.contextTokens) <= 0
    || !Number.isSafeInteger(receipt.contextWindow) || Number(receipt.contextWindow) <= 0
    || !Number.isSafeInteger(receipt.payloadByteEstimate) || Number(receipt.payloadByteEstimate) < 0
    || !Number.isSafeInteger(receipt.attemptCount) || Number(receipt.attemptCount) < 0 || Number(receipt.attemptCount) > 2
    || !Number.isSafeInteger(receipt.summaryRequestDurationMs) || Number(receipt.summaryRequestDurationMs) < 0
    || receipt.usedRetry !== (receipt.attemptCount === 2)
    || Number(receipt.contextTokens) * 100 < Number(receipt.contextWindow) * 75) return null;
  if (receipt.outcome === "failed") {
    const failureKeys = [
      "count", "reason", "triggerPercent", "contextTokens", "contextWindow", "payloadByteEstimate", "attemptCount",
      "summaryRequestDurationMs", "usedRetry", "outcome", "failureDomain", "failureCode", "willRetry",
    ];
    return Object.keys(receipt).length === failureKeys.length
      && receipt.failureDomain === "compaction"
      && isControlledCompactionFailureCode(receipt.failureCode)
      ? Object.fromEntries(failureKeys.map((key) => [key, receipt[key]]))
      : null;
  }
  if (receipt.outcome !== "completed"
    || Number(receipt.attemptCount) < 1
    || receipt.failureDomain !== undefined || receipt.failureCode !== undefined
    || !Number.isSafeInteger(receipt.tokensBefore) || Number(receipt.tokensBefore) < 0
    || !Number.isSafeInteger(receipt.estimatedTokensAfter) || Number(receipt.estimatedTokensAfter) < 0
    || typeof receipt.summaryDigest !== "string" || !/^[0-9a-f]{64}$/.test(receipt.summaryDigest)) return null;
  return Object.fromEntries(allowed.filter((key) => receipt[key] !== undefined).map((key) => [key, receipt[key]]));
}

function readTail(path: string, maxBytes: number): string | null {
  if (!existsSync(path)) return null;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    const size = statSync(path).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function item(ref: string, source: string, summary: string): EvidenceItem {
  const boundedSummary = bounded(summary);
  return {
    ref,
    source,
    summary: boundedSummary,
    digest: digest({ ref, source, summary: boundedSummary }),
    trust: "untrusted",
  };
}

function readBounded(path: string): string {
  return bounded(readFileSync(path, "utf8"));
}

function bounded(value: string): string {
  return value.length <= MAX_ITEM ? value : `${value.slice(0, MAX_ITEM)}\n...[truncated]`;
}
