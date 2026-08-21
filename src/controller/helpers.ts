import type { Attempt, AttemptResult, EvidenceItem, PullRequestCheck, CiFailure } from "../model.js";
import { digest } from "../model.js";
import type { TickAction, TickResult } from "./types.js";

export function result(ok: boolean, action: TickAction, jobId: string | null, messageValue: string): TickResult {
  return { ok, action, jobId, message: messageValue };
}

export function safeToken(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "job";
}

export function validReviewerValidationArgv(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 32
    && value.every((argument) => typeof argument === "string" && argument.length > 0 && argument.length <= 8192);
}

export function trimSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

export function withHerdrDiagnostic(summary: string, diagnostic: string | null): string {
  return diagnostic ? `${summary}\nHerdr diagnostics (untrusted):\n${diagnostic}` : summary;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function settleAttempt(attempt: Attempt, resultValue: AttemptResult | null, now: string): Attempt {
  return {
    ...attempt,
    phase: "settled",
    result: resultValue,
    completedAt: attempt.completedAt ?? now,
  };
}

export function dedupeEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const result: EvidenceItem[] = [];
  for (const item of items) {
    if (!item.ref.trim() || seen.has(item.ref)) continue;
    seen.add(item.ref);
    result.push(item);
  }
  return result.slice(0, 32);
}

export function isFailedCheck(check: PullRequestCheck): boolean {
  return check.bucket === "fail" || check.bucket === "cancel";
}

export function ciChecksDigest(checks: PullRequestCheck[]): string {
  return digest([...checks].sort((left, right) => (
    `${left.workflow}\0${left.name}\0${left.link}`.localeCompare(`${right.workflow}\0${right.name}\0${right.link}`)
  )));
}

export function summarizeCiFailure(number: number, failure: CiFailure): string {
  const checks = failure.checks.slice(0, 8).map((check) => (
    `- ${check.name}: ${check.state} (${check.bucket})${check.link ? ` ${check.link}` : ""}`
  ));
  if (failure.checks.length > checks.length) checks.push(`- ... ${failure.checks.length - checks.length} more failed checks`);
  return [`PR #${number} required CI failed at ${failure.headSha}:`, ...checks].join("\n");
}
