import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { digest, type EvidenceItem, type EvidenceRequest, type Job } from "../model.js";
import type { EvidencePort } from "../ports.js";
import { type CommandRunner, SyncCommandRunner } from "./command.js";

const MAX_ITEM = 16_000;

/** Read-only, bounded evidence collector. It never executes Analyst-supplied shell. */
export class LocalEvidence implements EvidencePort {
  constructor(private readonly runner: CommandRunner = new SyncCommandRunner()) {}

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
    if (job.ciFailure) items.push(item("ci-checks", "github.required-checks", JSON.stringify(job.ciFailure)));
    if (job.activeAttempt) items.push(item("active-attempt", "ledger.activeAttempt", JSON.stringify(job.activeAttempt)));
    const lastReview = [...job.attempts].reverse().find((attempt) => attempt.lane === "reviewer" && attempt.result);
    if (lastReview) items.push(item("last-review", "ledger.attempts", JSON.stringify(lastReview.result)));

    const missing: string[] = [];
    if (!job.worktree) missing.push("worktree");
    else {
      const status = this.runGit(job.worktree.path, ["status", "--short", "--branch"]);
      if (status === null) missing.push("git_status");
      else items.push(item("git-status", "git status --short --branch", status));
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
          JSON.stringify(job.activeAttempt?.result ?? job.activeAttempt ?? null),
        );
      case "git_status": {
        if (!job.worktree) return null;
        const output = this.runGit(job.worktree.path, ["status", "--short", "--branch"]);
        return output === null ? null : item("git-status-expanded", "git status --short --branch", output);
      }
      case "git_diff": {
        if (!job.worktree) return null;
        const head = job.headSha ?? "HEAD";
        const output = this.runGit(job.worktree.path, ["diff", "--stat", `${job.baseSha}...${head}`]);
        return output === null ? null : item("git-diff-stat", `git diff --stat ${job.baseSha}...${head}`, output);
      }
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
