import { existsSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { selectNextTask } from "./eligibility.js";
import {
  assertJobInvariant,
  digest,
  evolveJob,
  isRetryAction,
  taskFromSelection,
  type AnalystAdvice,
  type Attempt,
  type AttemptResult,
  type EvidenceItem,
  type HarnessState,
  type Incident,
  type Job,
  type ReviewerResult,
  type WorkerResult,
} from "./model.js";
import { allowedActionsFor, buildEvidencePack, makeIncident, validateAttemptResult } from "./policy.js";
import type {
  AnalystPort,
  Clock,
  EvidencePort,
  GitHubPort,
  GitPort,
  HarnessConfig,
  HerdrPort,
  IdGenerator,
  StateStore,
} from "./ports.js";
import { reviewerPrompt, workerPrompt } from "./prompts.js";
import { pathIsWithin, pathsOverlap } from "./path-safety.js";

const BUNDLED_CODE_REVIEW_SKILL = resolve(import.meta.dirname, "../../pi/skills/code-review");
const BUNDLED_REVIEWER_TOOLS_EXTENSION = resolve(import.meta.dirname, "../../pi/extensions/reviewer-tools.js");
const REVIEW_DESCRIPTOR_ENV = "HERDR_HARNESS_REVIEW_DESCRIPTOR";
const REVIEW_SUBAGENT_CEILING_ENV = "PI_SUBAGENT_CAPABILITY_CEILING_V1";
const REVIEW_SUBAGENT_CEILING = Buffer.from(JSON.stringify({
  version: 1,
  allowedTools: ["find", "grep", "ls", "read"],
  allowedAgents: ["herdr-harness-review-axis"],
  denyExtensions: true,
  sources: ["herdr-harness-lite"],
}), "utf8").toString("base64url");

export type TickAction =
  | "idle"
  | "selected"
  | "claimed"
  | "worktree_created"
  | "attempt_prepared"
  | "attempt_pane_ready"
  | "attempt_agent_ready"
  | "attempt_dispatched"
  | "attempt_completed"
  | "analysis_recorded"
  | "waiting_for_approval"
  | "recovery_applied"
  | "published"
  | "publish_retry"
  | "waiting_for_merge"
  | "merged"
  | "archived"
  | "blocked";

export type TickResult = {
  ok: boolean;
  action: TickAction;
  jobId: string | null;
  message: string;
};

type Dependencies = {
  config: HarnessConfig;
  store: StateStore;
  github: GitHubPort;
  git: GitPort;
  herdr: HerdrPort;
  analyst: AnalystPort;
  evidence: EvidencePort;
  clock: Clock;
  ids: IdGenerator;
};

/**
 * One controller owns all writes. Each tick performs at most one durable state
 * transition, so restarts resume from the ledger instead of replaying a whole
 * orchestration script.
 */
export class HarnessController {
  constructor(private readonly deps: Dependencies) {
    validateConfig(deps.config);
  }

  async tick(): Promise<TickResult> {
    const state = await this.deps.store.load();
    const job = state.activeJob;
    if (!job) return this.selectJob(state);
    assertJobInvariant(job);

    switch (job.state) {
      case "claimed":
        return this.advanceClaim(state, job);
      case "worker_ready":
        return this.prepareAttempt(state, job, "worker");
      case "worker_running":
        return this.driveAttempt(state, job, "worker");
      case "reviewer_ready":
        return this.prepareAttempt(state, job, "reviewer");
      case "reviewer_running":
        return this.driveAttempt(state, job, "reviewer");
      case "publish_ready":
        return this.publish(state, job);
      case "awaiting_merge":
        return this.observeMerge(state, job);
      case "blocked":
        return this.diagnoseOrWait(state, job);
      case "recovery_approved":
        return this.applyRecovery(state, job);
      case "done":
      case "cancelled":
        return this.archive(state, job);
    }
  }

  private async selectJob(state: HarnessState): Promise<TickResult> {
    const graph = await this.deps.github.listIssueGraph(this.deps.config.repo, this.deps.config.readyLabel);
    const claimed = new Set(state.terminalJobs.map((terminal) => terminal.issueNumber));
    const selected = selectNextTask(graph, {
      readyLabel: this.deps.config.readyLabel,
      claimedIssueNumbers: claimed,
    }).selected;
    if (!selected) return result(true, "idle", null, "no executable ready-for-agent issue");

    const baseSha = await this.deps.git.refreshBase(this.deps.config.localPath, this.deps.config.baseRef);
    const now = this.deps.clock.now();
    const jobId = this.deps.ids.next("job");
    const suffix = safeToken(jobId).slice(-10);
    const task = taskFromSelection(this.deps.config.repo, selected);
    const job: Job = {
      id: jobId,
      revision: 0,
      state: "claimed",
      task,
      baseSha,
      claimConfirmed: false,
      headSha: null,
      branch: `agent/issue-${task.issueNumber}-${suffix}`,
      worktree: null,
      analyst: null,
      activeAttempt: null,
      attempts: [],
      reviewRound: 0,
      maxReviewRounds: this.deps.config.maxReviewRounds,
      pendingBrief: null,
      incident: null,
      analysis: null,
      approval: null,
      reassessments: [],
      pullRequest: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    assertJobInvariant(job);
    await this.deps.store.save({ ...state, activeJob: job }, null);
    return result(true, "selected", job.id, `selected ${task.repo}#${task.issueNumber}; claim intent is durable`);
  }

  private async advanceClaim(state: HarnessState, job: Job): Promise<TickResult> {
    if (!job.claimConfirmed) {
      const currentIssue = await this.deps.github.getIssue(this.deps.config.repo, job.task.issueNumber);
      const alreadyClaimed = currentIssue.labels.includes(this.deps.config.claimLabel);
      let selected: ReturnType<typeof selectNextTask>["selected"] = {
        issue: currentIssue,
        mapNumber: job.task.mapNumber,
        selectionKey: job.task.mapNumber ?? job.task.issueNumber,
      };

      if (!alreadyClaimed) {
        const graph = await this.deps.github.listIssueGraph(this.deps.config.repo, this.deps.config.readyLabel);
        selected = selectNextTask(graph, {
          readyLabel: this.deps.config.readyLabel,
          claimedIssueNumbers: new Set(state.terminalJobs.map((terminal) => terminal.issueNumber)),
        }).selected;
        if (!selected || selected.issue.number !== job.task.issueNumber || selected.mapNumber !== job.task.mapNumber) {
          return this.block(state, job, {
            class: "stale_task",
            lane: "controller",
            summary: "GitHub frontier changed before the claim could be confirmed",
            attemptResult: null,
          });
        }
      }

      if (!selected) throw new Error("internal: selected claim disappeared");
      const freshTask = taskFromSelection(this.deps.config.repo, selected);
      if (freshTask.digest !== job.task.digest || currentIssue.state !== "OPEN") {
        return this.block(state, job, {
          class: "stale_task",
          lane: "controller",
          summary: "issue objective or state changed after selection; a new claim is required",
          attemptResult: null,
        });
      }

      if (!alreadyClaimed) {
        try {
          await this.deps.github.claimIssue({
            repo: this.deps.config.repo,
            task: selected,
            jobId: job.id,
            claimLabel: this.deps.config.claimLabel,
            readyLabel: this.deps.config.readyLabel,
          });
        } catch (error) {
          return result(false, "claimed", job.id, `GitHub claim not confirmed: ${message(error)}`);
        }
      }

      let analyst;
      try {
        analyst = await this.deps.analyst.start({ jobId: job.id, task: job.task });
      } catch (error) {
        return this.block(state, job, {
          class: "analyst_unavailable",
          lane: "controller",
          summary: `task-bound Codex Analyst could not start: ${message(error)}`,
          attemptResult: null,
        });
      }
      const next = evolveJob(job, this.deps.clock.now(), {
        claimConfirmed: true,
        analyst,
        lastError: null,
      });
      await this.saveJob(state, job, next);
      return result(true, "claimed", job.id, "GitHub claim and task-bound Analyst are confirmed");
    }

    if (!job.analyst) {
      return this.block(state, job, {
        class: "analyst_unavailable",
        lane: "controller",
        summary: "claim is confirmed but no Analyst is bound to the task digest",
        attemptResult: null,
      });
    }
    if (job.worktree) {
      const next = evolveJob(job, this.deps.clock.now(), { state: "worker_ready" });
      await this.saveJob(state, job, next);
      return result(true, "worktree_created", job.id, "existing worktree accepted; worker lane is ready");
    }

    const path = `${trimSlash(this.deps.config.worktreeRoot)}/${safeToken(this.deps.config.repo)}/issue-${job.task.issueNumber}-${safeToken(job.id).slice(-10)}`;
    let worktree;
    try {
      worktree = await this.deps.herdr.createWorktree({
        sourcePath: this.deps.config.localPath,
        branch: job.branch,
        baseRef: job.baseSha,
        path,
        label: `issue #${job.task.issueNumber}`,
      });
    } catch (error) {
      return result(false, "claimed", job.id, `Herdr worktree not ready: ${message(error)}`);
    }
    if (worktree.branch !== job.branch || worktree.path !== path) {
      return this.block(state, job, {
        class: "integrity_violation",
        lane: "controller",
        summary: "Herdr returned a different worktree identity than requested",
        attemptResult: null,
      });
    }
    const next = evolveJob(job, this.deps.clock.now(), {
      state: "worker_ready",
      worktree,
      lastError: null,
    });
    await this.saveJob(state, job, next);
    return result(true, "worktree_created", job.id, `Herdr worktree created at ${worktree.path}`);
  }

  private async prepareAttempt(state: HarnessState, job: Job, lane: Attempt["lane"]): Promise<TickResult> {
    if (!job.worktree) {
      return this.block(state, job, {
        class: "integrity_violation",
        lane: "controller",
        summary: `${lane} lane has no worktree`,
        attemptResult: null,
      });
    }
    if (lane === "reviewer" && !job.headSha) {
      return this.block(state, job, {
        class: "integrity_violation",
        lane: "controller",
        summary: "reviewer lane has no implementation HEAD",
        attemptResult: null,
      });
    }

    const attemptId = this.deps.ids.next(lane);
    const now = this.deps.clock.now();
    const reviewerRoot = resolve(
      this.deps.config.stateDir,
      "reviewer-attempts",
      safeToken(job.id),
      safeToken(attemptId),
    );
    let attempt: Attempt = {
      id: attemptId,
      lane,
      phase: "prepared",
      round: job.reviewRound + 1,
      baseSha: lane === "worker" ? (job.headSha ?? job.baseSha) : job.baseSha,
      expectedHeadSha: lane === "reviewer" ? job.headSha : null,
      resultPath: lane === "reviewer"
        ? resolve(reviewerRoot, "result.json")
        : `${trimSlash(job.worktree.path)}/.harness/attempt-${safeToken(attemptId)}.json`,
      ...(lane === "reviewer" ? { reviewerValidationArgv: [...this.deps.config.reviewerValidationArgv] } : {}),
      promptDigest: "",
      handle: null,
      result: null,
      startedAt: now,
      completedAt: null,
    };
    const prompt = lane === "worker" ? workerPrompt(job, attempt) : reviewerPrompt(job, attempt);
    attempt = { ...attempt, promptDigest: digest(prompt) };
    const next = evolveJob(job, now, {
      state: lane === "worker" ? "worker_running" : "reviewer_running",
      activeAttempt: attempt,
      lastError: null,
    });
    await this.saveJob(state, job, next);
    return result(true, "attempt_prepared", job.id, `${lane} attempt ${attempt.id} is durably prepared`);
  }

  private async driveAttempt(state: HarnessState, job: Job, lane: Attempt["lane"]): Promise<TickResult> {
    const attempt = job.activeAttempt;
    if (!attempt || attempt.lane !== lane || !job.worktree) {
      return this.block(state, job, {
        class: "integrity_violation",
        lane: "controller",
        summary: `${lane} state has incomplete attempt provenance`,
        attemptResult: null,
      });
    }

    if (attempt.phase === "prepared") {
      if (lane === "reviewer") {
        const integrityBlock = await this.verifyReviewerIntegrity(
          state,
          job,
          attempt,
          attempt.expectedHeadSha,
          null,
        );
        if (integrityBlock) return integrityBlock;
      }
      let handle;
      try {
        let cwd = job.worktree.path;
        let env: Record<string, string> = {};
        if (lane === "reviewer") {
          if (!attempt.expectedHeadSha) throw new Error("Reviewer attempt has no expected HEAD");
          if (!validReviewerValidationArgv(attempt.reviewerValidationArgv)) {
            return this.block(state, job, {
              class: "integrity_violation",
              lane,
              summary: "Reviewer attempt has no durably bound validation command",
              attemptResult: null,
            });
          }
          const workspace = await this.deps.git.prepareReviewer({
            worktree: job.worktree,
            rootPath: dirname(attempt.resultPath),
            resultPath: attempt.resultPath,
            jobId: job.id,
            attemptId: attempt.id,
            baseSha: attempt.baseSha,
            expectedHeadSha: attempt.expectedHeadSha,
            validationArgv: attempt.reviewerValidationArgv,
          });
          cwd = workspace.reviewPath;
          env = {
            [REVIEW_DESCRIPTOR_ENV]: workspace.descriptorPath,
            [REVIEW_SUBAGENT_CEILING_ENV]: REVIEW_SUBAGENT_CEILING,
          };
        }
        handle = await this.deps.herdr.createAttemptPane({
          worktree: job.worktree,
          attempt,
          cwd,
          env,
        });
      } catch (error) {
        return this.block(state, job, {
          class: "infrastructure_exhausted",
          lane,
          summary: `Herdr ${lane} pane creation failed: ${message(error)}`,
          attemptResult: null,
        });
      }
      const ready: Attempt = { ...attempt, phase: "pane_ready", handle };
      const next = evolveJob(job, this.deps.clock.now(), { activeAttempt: ready });
      await this.saveJob(state, job, next);
      return result(true, "attempt_pane_ready", job.id, `${lane} attempt ${attempt.id} has a durable owned pane`);
    }

    if (attempt.phase === "pane_ready" && attempt.handle) {
      try {
        await this.deps.herdr.startAgent({
          handle: attempt.handle,
          argv: lane === "worker" ? this.deps.config.workerArgv : this.deps.config.reviewerArgv,
        });
      } catch (error) {
        return this.block(state, job, {
          class: "infrastructure_exhausted",
          lane,
          summary: `Herdr ${lane} start failed: ${message(error)}`,
          attemptResult: null,
        });
      }
      const ready: Attempt = { ...attempt, phase: "agent_ready" };
      const next = evolveJob(job, this.deps.clock.now(), { activeAttempt: ready });
      await this.saveJob(state, job, next);
      return result(true, "attempt_agent_ready", job.id, `${lane} attempt ${attempt.id} has a durable fresh Pi agent`);
    }

    if (attempt.phase === "agent_ready" && attempt.handle) {
      const prompt = lane === "worker" ? workerPrompt(job, attempt) : reviewerPrompt(job, attempt);
      if (digest(prompt) !== attempt.promptDigest) {
        return this.block(state, job, {
          class: "integrity_violation",
          lane,
          summary: "prompt changed after attempt preparation",
          attemptResult: null,
        });
      }
      const running: Attempt = { ...attempt, phase: "running" };
      const next = evolveJob(job, this.deps.clock.now(), { activeAttempt: running });
      await this.saveJob(state, job, next);
      try {
        await this.deps.herdr.prompt({
          handle: attempt.handle,
          dispatchId: attempt.id,
          skill: lane === "worker" ? "implement" : "code-review",
          text: prompt,
        });
      } catch (error) {
        return result(
          false,
          "attempt_dispatched",
          job.id,
          `Herdr ${lane} dispatch outcome is uncertain and will only be observed: ${message(error)}`,
        );
      }
      return result(true, "attempt_dispatched", job.id, `${lane} attempt ${attempt.id} dispatched exactly once`);
    }

    if (attempt.phase !== "running" || !attempt.handle) {
      return this.block(state, job, {
        class: "integrity_violation",
        lane: "controller",
        summary: `${lane} attempt has an invalid lifecycle phase`,
        attemptResult: null,
      });
    }

    let observation;
    try {
      observation = await this.deps.herdr.wait({
        handle: attempt.handle,
        resultPath: attempt.resultPath,
        expectedJobId: job.id,
        expectedAttemptId: attempt.id,
        expectedLane: lane,
      });
    } catch (error) {
      if (lane === "reviewer") {
        const integrityBlock = await this.verifyReviewerIntegrity(state, job, attempt, null, null);
        if (integrityBlock) return integrityBlock;
      }
      return this.block(state, job, {
        class: "infrastructure_exhausted",
        lane,
        summary: `Herdr ${lane} wait failed: ${message(error)}`,
        attemptResult: null,
      });
    }

    if (lane === "reviewer") {
      const reportedHeadSha = observation.result?.lane === "reviewer"
        ? (observation.result.reviewedHeadSha ?? null)
        : null;
      const integrityBlock = await this.verifyReviewerIntegrity(state, job, attempt, reportedHeadSha, observation.result);
      if (integrityBlock) return integrityBlock;
    }

    const validated = validateAttemptResult(job.id, attempt, observation.result);
    if (!validated.ok) {
      return this.block(state, job, {
        class: observation.agentStatus === "blocked"
          ? "agent_blocked"
          : observation.result === null
            ? "infrastructure_exhausted"
            : "integrity_violation",
        lane,
        summary: withHerdrDiagnostic(validated.reason, observation.diagnostic),
        attemptResult: observation.result,
      });
    }
    if (lane === "worker") return this.finishWorker(state, job, attempt, validated.result as WorkerResult, observation.diagnostic);
    return this.finishReviewer(state, job, attempt, validated.result as ReviewerResult, observation.diagnostic);
  }

  private async verifyReviewerIntegrity(
    state: HarnessState,
    job: Job,
    attempt: Attempt,
    reportedHeadSha: string | null,
    attemptResult: AttemptResult | null,
  ): Promise<TickResult | null> {
    if (!job.worktree || !job.headSha) {
      return this.block(state, job, {
        class: "integrity_violation",
        lane: "reviewer",
        summary: "reviewer lane lost its expected worktree or implementation HEAD",
        attemptResult,
      });
    }
    const verification = await this.deps.git.verifyReviewer({
      worktree: job.worktree,
      expectedHeadSha: job.headSha,
      reportedHeadSha,
      allowedResultPaths: [...job.attempts.map((settled) => settled.resultPath), attempt.resultPath]
        .filter((path) => pathIsWithin(job.worktree!.path, path)),
    });
    if (verification.ok) return null;
    return this.block(state, job, {
      class: verification.class,
      lane: "reviewer",
      summary: verification.reason,
      attemptResult,
    });
  }

  private async finishWorker(
    state: HarnessState,
    job: Job,
    attempt: Attempt,
    worker: WorkerResult,
    diagnostic: string | null,
  ): Promise<TickResult> {
    if (worker.status === "blocked") {
      return this.block(state, job, {
        class: "agent_decision",
        lane: "worker",
        summary: withHerdrDiagnostic(worker.summary, diagnostic),
        attemptResult: worker,
      });
    }
    if (worker.status === "failed") {
      return this.block(state, job, {
        class: "agent_blocked",
        lane: "worker",
        summary: withHerdrDiagnostic(worker.summary, diagnostic),
        attemptResult: worker,
      });
    }
    if (!worker.headSha || !job.worktree) {
      return this.block(state, job, {
        class: "integrity_violation",
        lane: "worker",
        summary: "worker completion lacks verifiable Git provenance",
        attemptResult: worker,
      });
    }

    const verification = await this.deps.git.verifyWorker({
      worktree: job.worktree,
      branch: job.branch,
      baseSha: attempt.baseSha,
      reportedHeadSha: worker.headSha,
    });
    if (!verification.ok) {
      return this.block(state, job, {
        class: verification.class,
        lane: "worker",
        summary: verification.reason,
        attemptResult: worker,
      });
    }

    const cleanup = await this.closeCompletedAttempt(job, attempt);
    if (cleanup) return cleanup;

    const settled = settleAttempt(attempt, worker, this.deps.clock.now());
    const next = evolveJob(job, this.deps.clock.now(), {
      state: "reviewer_ready",
      headSha: verification.headSha,
      activeAttempt: null,
      attempts: [...job.attempts, settled],
      pendingBrief: null,
      lastError: null,
    });
    await this.saveJob(state, job, next);
    return result(true, "attempt_completed", job.id, `worker completed at ${verification.headSha}; fresh review required`);
  }

  private async finishReviewer(
    state: HarnessState,
    job: Job,
    attempt: Attempt,
    review: ReviewerResult,
    diagnostic: string | null,
  ): Promise<TickResult> {
    if (review.status === "blocked" || review.status === "failed") {
      return this.block(state, job, {
        class: "review_uncertain",
        lane: "reviewer",
        summary: withHerdrDiagnostic(review.summary, diagnostic),
        attemptResult: review,
      });
    }
    if (!job.worktree || !job.headSha || !review.reviewedHeadSha) {
      return this.block(state, job, {
        class: "integrity_violation",
        lane: "reviewer",
        summary: "review result lacks a bound implementation HEAD",
        attemptResult: review,
      });
    }
    const settled = settleAttempt(attempt, review, this.deps.clock.now());
    if (review.status === "pass") {
      const cleanup = await this.closeCompletedAttempt(job, attempt);
      if (cleanup) return cleanup;
      const next = evolveJob(job, this.deps.clock.now(), {
        state: "publish_ready",
        activeAttempt: null,
        attempts: [...job.attempts, settled],
        reviewRound: attempt.round,
        lastError: null,
      });
      await this.saveJob(state, job, next);
      return result(true, "attempt_completed", job.id, `independent review passed at round ${attempt.round}`);
    }

    if (review.findings.length === 0) {
      return this.block(state, job, {
        class: "review_uncertain",
        lane: "reviewer",
        summary: "review requested changes without actionable findings",
        attemptResult: review,
      });
    }
    if (attempt.round >= job.maxReviewRounds) {
      return this.block(state, job, {
        class: "review_uncertain",
        lane: "reviewer",
        summary: `review rounds exhausted at ${attempt.round}: ${review.summary}`,
        attemptResult: review,
      });
    }

    const cleanup = await this.closeCompletedAttempt(job, attempt);
    if (cleanup) return cleanup;

    const brief = review.findings
      .map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.summary} — ${finding.evidence}`)
      .join("\n");
    const next = evolveJob(job, this.deps.clock.now(), {
      state: "worker_ready",
      activeAttempt: null,
      attempts: [...job.attempts, settled],
      reviewRound: attempt.round,
      pendingBrief: `Independent reviewer requested changes:\n${brief}`,
      lastError: review.summary,
    });
    await this.saveJob(state, job, next);
    return result(true, "attempt_completed", job.id, "review findings routed to a fresh worker attempt");
  }

  private async closeCompletedAttempt(job: Job, attempt: Attempt): Promise<TickResult | null> {
    if (!attempt.handle) {
      return result(false, "attempt_completed", job.id, `${attempt.lane} pane identity is missing; completion was not recorded`);
    }
    try {
      await this.deps.herdr.close(attempt.handle);
      return null;
    } catch (error) {
      return result(false, "attempt_completed", job.id, `${attempt.lane} pane close is not confirmed: ${message(error)}`);
    }
  }

  private async publish(state: HarnessState, job: Job): Promise<TickResult> {
    if (!job.headSha) {
      return this.block(state, job, {
        class: "integrity_violation",
        lane: "controller",
        summary: "publish lane has no reviewed HEAD",
        attemptResult: null,
      });
    }
    let pullRequest;
    try {
      pullRequest = await this.deps.github.publish({
        repo: job.task.repo,
        issueNumber: job.task.issueNumber,
        branch: job.branch,
        baseRef: this.deps.config.baseRef,
        headSha: job.headSha,
        title: job.task.title,
        worktreePath: job.worktree?.path ?? this.deps.config.localPath,
      });
    } catch (error) {
      return result(false, "publish_retry", job.id, `publish is retryable and not yet confirmed: ${message(error)}`);
    }
    if (pullRequest.headSha !== job.headSha) {
      return this.block(state, job, {
        class: "integrity_violation",
        lane: "controller",
        summary: `PR head ${pullRequest.headSha} differs from reviewed head ${job.headSha}`,
        attemptResult: null,
      });
    }
    const next = evolveJob(job, this.deps.clock.now(), {
      state: "awaiting_merge",
      pullRequest,
      lastError: null,
    });
    await this.saveJob(state, job, next);
    return result(
      true,
      "published",
      job.id,
      this.deps.config.autoMerge
        ? `PR #${pullRequest.number} published with native auto-merge requested`
        : `PR #${pullRequest.number} published; merge remains external`,
    );
  }

  private async observeMerge(state: HarnessState, job: Job): Promise<TickResult> {
    if (!job.pullRequest) {
      return this.block(state, job, {
        class: "integrity_violation",
        lane: "controller",
        summary: "awaiting_merge has no pull request identity",
        attemptResult: null,
      });
    }
    const status = await this.deps.github.observePullRequest(job.task.repo, job.pullRequest);
    if (status === "open") return result(true, "waiting_for_merge", job.id, `PR #${job.pullRequest.number} is still open`);
    if (status === "closed_unmerged") {
      return this.block(state, job, {
        class: "integrity_violation",
        lane: "controller",
        summary: `PR #${job.pullRequest.number} closed without merge`,
        attemptResult: null,
      });
    }
    const next = evolveJob(job, this.deps.clock.now(), { state: "done", lastError: null });
    await this.saveJob(state, job, next);
    return result(true, "merged", job.id, `PR #${job.pullRequest.number} merged`);
  }

  private async diagnoseOrWait(state: HarnessState, job: Job): Promise<TickResult> {
    if (!job.incident) throw new Error("blocked job has no incident");
    if (job.analysis) {
      return result(true, "waiting_for_approval", job.id, `analysis ${job.analysis.id} is ready; human approval is required`);
    }
    if (!job.analyst) {
      return result(true, "waiting_for_approval", job.id, "Analyst is unavailable; incident can only be held or cancelled");
    }

    let advice: AnalystAdvice;
    try {
      advice = await this.runDiagnosis(job, job.incident);
    } catch (error) {
      advice = {
        id: this.deps.ids.next("analysis"),
        incidentId: job.incident.id,
        evidenceDigest: job.incident.evidenceDigest,
        action: "hold",
        summary: `Analyst diagnosis failed closed: ${message(error)}`,
        resolutionBrief: "",
        evidenceRefs: [],
        unknowns: [message(error)],
        createdAt: this.deps.clock.now(),
      };
    }
    const next = evolveJob(job, this.deps.clock.now(), { analysis: advice });
    await this.saveJob(state, job, next);
    return result(true, "analysis_recorded", job.id, `Analyst advice ${advice.id} recorded with action=${advice.action}`);
  }

  private async runDiagnosis(job: Job, incident: Incident): Promise<AnalystAdvice> {
    const initial = await this.deps.evidence.initial(job);
    let items = dedupeEvidence(initial.items);
    let missing = [...initial.missing];
    let pack = buildEvidencePack({
      incident,
      jobId: job.id,
      jobRevision: job.revision,
      taskDigest: job.task.digest,
      items,
      missing,
    });

    for (let turn = 1; turn <= this.deps.config.maxAnalystTurns; turn += 1) {
      const output = await this.deps.analyst.turn({ session: job.analyst!, job, evidence: pack, turn });
      if (output.kind === "need_evidence") {
        if (output.requests.length === 0 || output.requests.length > 4) {
          throw new Error("Analyst requested an invalid number of evidence items");
        }
        const collected = await this.deps.evidence.collect(job, output.requests);
        items = dedupeEvidence([...items, ...collected]);
        missing = missing.filter((entry) => !collected.some((item) => item.source === entry));
        pack = buildEvidencePack({
          incident,
          jobId: job.id,
          jobRevision: job.revision,
          taskDigest: job.task.digest,
          items,
          missing,
        });
        continue;
      }

      let action = output.action;
      const unknowns = [...output.unknowns];
      if (!incident.allowedActions.includes(action)) {
        unknowns.push(`action ${action} is forbidden for incident class ${incident.class}`);
        action = "hold";
      }
      if (action !== "hold" && !output.resolutionBrief.trim()) {
        unknowns.push("retry recommendation has no bounded resolution brief");
        action = "hold";
      }
      const knownRefs = new Set(pack.items.map((item) => item.ref));
      if (output.evidenceRefs.some((ref) => !knownRefs.has(ref))) {
        unknowns.push("Analyst cited evidence outside the bounded pack");
        action = "hold";
      }
      const createdAt = this.deps.clock.now();
      return {
        id: this.deps.ids.next("analysis"),
        incidentId: incident.id,
        evidenceDigest: pack.digest,
        action,
        summary: output.summary,
        resolutionBrief: action === "hold" ? "" : output.resolutionBrief,
        evidenceRefs: output.evidenceRefs.filter((ref) => knownRefs.has(ref)),
        unknowns,
        createdAt,
      };
    }

    return {
      id: this.deps.ids.next("analysis"),
      incidentId: incident.id,
      evidenceDigest: pack.digest,
      action: "hold",
      summary: "Analyst evidence-gathering turns were exhausted",
      resolutionBrief: "",
      evidenceRefs: pack.items.map((item) => item.ref),
      unknowns: ["more evidence is required than the Harness policy allows"],
      createdAt: this.deps.clock.now(),
    };
  }

  private async applyRecovery(state: HarnessState, job: Job): Promise<TickResult> {
    const approval = job.approval;
    const analysis = job.analysis;
    const incident = job.incident;
    if (!approval || !analysis || !incident) {
      return this.block(state, job, {
        class: "integrity_violation",
        lane: "controller",
        summary: "approved recovery lost its incident or analysis binding",
        attemptResult: null,
      });
    }
    if (
      approval.jobRevision >= job.revision ||
      approval.incidentId !== incident.id ||
      approval.analysisId !== analysis.id ||
      !isRetryAction(approval.action) ||
      approval.action !== analysis.action ||
      !incident.allowedActions.includes(approval.action) ||
      !allowedActionsFor(incident.class, incident.lane).includes(approval.action)
    ) {
      return this.block(state, job, {
        class: "integrity_violation",
        lane: "controller",
        summary: "approval binding is stale or inconsistent",
        attemptResult: null,
      });
    }

    if (approval.action === "retry_fresh_reviewer") {
      if (
        incident.class !== "infrastructure_exhausted" ||
        incident.lane !== "reviewer" ||
        job.activeAttempt?.lane !== "reviewer" ||
        incident.attemptId !== job.activeAttempt.id
      ) {
        return this.block(state, job, {
          class: "integrity_violation",
          lane: "controller",
          summary: "fresh Reviewer recovery lost its exact incident or Git binding",
          attemptResult: job.activeAttempt?.result ?? null,
        });
      }
      const integrityBlock = await this.verifyReviewerIntegrity(
        state,
        job,
        job.activeAttempt,
        job.headSha,
        job.activeAttempt.result,
      );
      if (integrityBlock) return integrityBlock;
    }

    if (job.activeAttempt?.handle) {
      try {
        await this.deps.herdr.close(job.activeAttempt.handle);
      } catch (error) {
        return result(false, "recovery_applied", job.id, `old agent could not be closed safely: ${message(error)}`);
      }
    }
    const now = this.deps.clock.now();
    const attempts = job.activeAttempt
      ? [...job.attempts, settleAttempt(job.activeAttempt, job.activeAttempt.result, now)]
      : job.attempts;
    const consumed = { ...approval, consumedAt: now };
    const next = evolveJob(job, now, {
      state: approval.action === "retry_fresh_reviewer" ? "reviewer_ready" : "worker_ready",
      activeAttempt: null,
      attempts,
      pendingBrief: approval.action === "retry_fresh_worker" ? analysis.resolutionBrief : null,
      incident: null,
      analysis: null,
      approval: consumed,
      lastError: null,
    });
    await this.saveJob(state, job, next);
    const lane = approval.action === "retry_fresh_reviewer" ? "Reviewer" : "Worker";
    return result(true, "recovery_applied", job.id, `approval consumed; a fresh ${lane} attempt is now required`);
  }

  private async archive(state: HarnessState, job: Job): Promise<TickResult> {
    try {
      await this.deps.analyst.close({ jobId: job.id, taskDigest: job.task.digest, session: job.analyst });
    } catch (error) {
      return result(false, "archived", job.id, `Codex Analyst could not be closed safely: ${message(error)}`);
    }
    const terminal = {
      id: job.id,
      repo: job.task.repo,
      issueNumber: job.task.issueNumber,
      state: job.state as "done" | "cancelled",
      finishedAt: job.updatedAt,
      reassessments: job.reassessments ?? [],
    } as const;
    const terminalJobs = state.terminalJobs.some((entry) => entry.id === job.id)
      ? state.terminalJobs
      : [...state.terminalJobs, terminal];
    await this.deps.store.save({ version: 1, activeJob: null, terminalJobs }, job.revision);
    return result(true, "archived", job.id, `${job.state} job archived; the slot is free`);
  }

  private async block(
    state: HarnessState,
    job: Job,
    input: {
      class: Incident["class"];
      lane: Incident["lane"];
      summary: string;
      attemptResult: AttemptResult | null;
    },
  ): Promise<TickResult> {
    const now = this.deps.clock.now();
    const activeAttempt = job.activeAttempt
      ? {
          ...job.activeAttempt,
          phase: "settled" as const,
          result: input.attemptResult,
          completedAt: now,
        }
      : null;
    const incident = makeIncident({
      jobId: job.id,
      jobRevision: job.revision + 1,
      lane: input.lane,
      attemptId: activeAttempt?.id ?? null,
      blockClass: input.class,
      summary: input.summary,
      clock: this.deps.clock,
      ids: this.deps.ids,
    });
    const next = evolveJob(job, now, {
      state: "blocked",
      activeAttempt,
      incident,
      analysis: null,
      approval: null,
      lastError: input.summary,
    });
    await this.saveJob(state, job, next);
    return result(false, "blocked", job.id, `${input.class}: ${input.summary}`);
  }

  private async saveJob(state: HarnessState, current: Job, next: Job): Promise<void> {
    assertJobInvariant(next);
    await this.deps.store.save({ ...state, activeJob: next }, current.revision);
  }
}

function settleAttempt(attempt: Attempt, resultValue: AttemptResult | null, now: string): Attempt {
  return {
    ...attempt,
    phase: "settled",
    result: resultValue,
    completedAt: attempt.completedAt ?? now,
  };
}

function dedupeEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const result: EvidenceItem[] = [];
  for (const item of items) {
    if (!item.ref.trim() || seen.has(item.ref)) continue;
    seen.add(item.ref);
    result.push(item);
  }
  return result.slice(0, 32);
}

function validateConfig(config: HarnessConfig): void {
  for (const [name, value] of [
    ["repo", config.repo],
    ["localPath", config.localPath],
    ["stateDir", config.stateDir],
    ["baseRef", config.baseRef],
    ["readyLabel", config.readyLabel],
    ["claimLabel", config.claimLabel],
    ["worktreeRoot", config.worktreeRoot],
  ] as const) {
    if (!value.trim()) throw new Error(`${name} must not be empty`);
  }
  for (const [name, path] of [["localPath", config.localPath], ["stateDir", config.stateDir], ["worktreeRoot", config.worktreeRoot]] as const) {
    if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
  }
  if (pathsOverlap(config.localPath, config.stateDir)) throw new Error("localPath and stateDir must not overlap");
  if (pathsOverlap(config.stateDir, config.worktreeRoot)) throw new Error("stateDir and worktreeRoot must not overlap");
  if (!Number.isInteger(config.maxReviewRounds) || config.maxReviewRounds < 1) {
    throw new Error("maxReviewRounds must be a positive integer");
  }
  if (!Number.isInteger(config.maxAnalystTurns) || config.maxAnalystTurns < 1 || config.maxAnalystTurns > 5) {
    throw new Error("maxAnalystTurns must be between 1 and 5");
  }
  for (const [name, value] of [
    ["workerArgv", config.workerArgv],
    ["reviewerArgv", config.reviewerArgv],
    ["reviewerValidationArgv", config.reviewerValidationArgv],
  ] as const) {
    if (!Array.isArray(value) || value.some((argument) => typeof argument !== "string")) {
      throw new Error(`${name} must be an array of strings`);
    }
  }
  if (!validReviewerValidationArgv(config.reviewerValidationArgv)) {
    throw new Error("reviewerValidationArgv must contain 1 to 32 non-empty arguments");
  }
  validatePiRoleArgv(
    "workerArgv",
    config.workerArgv,
    ["implement", "tdd", "code-review"],
    ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent"],
    ["high", "xhigh", "max"],
  );
  validatePiRoleArgv(
    "reviewerArgv",
    config.reviewerArgv,
    ["code-review"],
    ["read", "grep", "find", "ls", "subagent", "review_validate", "review_submit"],
    ["max"],
  );
}

function validatePiRoleArgv(
  name: "workerArgv" | "reviewerArgv",
  argv: string[],
  skills: string[],
  tools: string[],
  allowedThinking: readonly ("high" | "xhigh" | "max")[],
): void {
  const fail = (reason: string): never => {
    throw new Error(`${name} must enforce the Pi role contract: ${reason}`);
  };
  validateAllowedPiArgv(argv, fail);
  if (!argv.includes("--no-approve")) fail("--no-approve is required");
  if (!argv.includes("--no-skills")) fail("--no-skills is required");
  if (name === "reviewerArgv") {
    validateReviewerExtensions(argv, fail);
  } else if (argv.includes("--no-extensions") || flagValues(argv, "--extension").length > 0) {
    fail("Worker extensions are not allowed");
  }
  const skillPaths = flagValues(argv, "--skill");
  if (skillPaths.some((path) => !isAbsolute(path))) fail("skill paths must be absolute");
  let loadedSkillIdentities: PiSkillIdentity[] = [];
  try {
    loadedSkillIdentities = skillPaths.map(readPiSkillIdentity);
  } catch (error) {
    fail(`skill metadata cannot be verified: ${message(error)}`);
  }
  const loadedSkills = new Set(loadedSkillIdentities.map((skill) => skill.name));
  if (skills.some((skill) => !loadedSkills.has(skill))) fail(`required skills: ${skills.join(",")}`);
  const reviewSkills = loadedSkillIdentities.filter((skill) => skill.name === "code-review");
  if (reviewSkills.length !== 1 || reviewSkills[0]!.directory !== BUNDLED_CODE_REVIEW_SKILL) {
    fail("code-review must resolve to the bundled Harness skill");
  }
  for (const skillName of ["implement", "tdd"]) {
    if (!skills.includes(skillName)) continue;
    const matches = loadedSkillIdentities.filter((skill) => skill.name === skillName);
    if (matches.length !== 1 || !hasMattPocockProvenance(matches[0]!)) {
      fail(`${skillName} must come from the installed mattpocock/skills package`);
    }
  }
  const toolValues = flagValues(argv, "--tools");
  if (toolValues.length !== 1 || !sameSet(toolValues[0]!.split(",").map((tool) => tool.trim()), tools)) {
    fail(`tools must be exactly: ${tools.join(",")}`);
  }
  const thinking = flagValues(argv, "--thinking");
  if (thinking.length !== 1 || !allowedThinking.includes(thinking[0] as "high" | "xhigh" | "max")) {
    fail(`--thinking ${allowedThinking.join(" or ")} is required`);
  }
}

function flagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((value, index) => value === flag && argv[index + 1] ? [argv[index + 1]!] : []);
}

function validateAllowedPiArgv(argv: string[], fail: (reason: string) => never): void {
  const valueFlags = new Set(["--skill", "--tools", "--thinking", "--provider", "--model", "--extension"]);
  const booleanFlags = new Set(["--no-approve", "--no-skills", "--no-session", "--no-extensions"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (booleanFlags.has(argument)) continue;
    if (!valueFlags.has(argument)) fail(`unsupported Pi argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) fail(`${argument} requires a separate value`);
    index += 1;
  }
}

function validateReviewerExtensions(argv: string[], fail: (reason: string) => never): void {
  if (argv.filter((argument) => argument === "--no-extensions").length !== 1) {
    fail("exactly one --no-extensions is required");
  }
  const extensions = flagValues(argv, "--extension");
  if (extensions.length !== 2 || extensions.some((path) => !isAbsolute(path))) {
    fail("exactly two absolute --extension paths are required");
  }
  if (extensions.filter((path) => resolve(path) === BUNDLED_REVIEWER_TOOLS_EXTENSION).length !== 1) {
    fail("reviewer-tools must resolve to the bundled Harness extension");
  }
  const subagents = extensions.filter((path) => resolve(path) !== BUNDLED_REVIEWER_TOOLS_EXTENSION);
  if (subagents.length !== 1 || !isPiSubagentsExtension(subagents[0]!)) {
    fail("the other Reviewer extension must be the declared pi-subagents package entrypoint");
  }
}

function isPiSubagentsExtension(path: string): boolean {
  const extensionPath = resolve(path);
  const packageRoot = dirname(extensionPath);
  try {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
      name?: unknown;
      pi?: { extensions?: unknown };
      exports?: Record<string, unknown>;
    };
    const capabilityEntrypoint = manifest.exports?.["./capability-ceiling"];
    return manifest.name === "pi-subagents"
      && existsSync(extensionPath)
      && Array.isArray(manifest.pi?.extensions)
      && manifest.pi.extensions.some((entry) => typeof entry === "string" && resolve(packageRoot, entry) === extensionPath)
      && typeof capabilityEntrypoint === "string"
      && existsSync(resolve(packageRoot, capabilityEntrypoint));
  } catch {
    return false;
  }
}

function piSkillDirectory(path: string): string {
  const absolute = resolve(path);
  return basename(absolute) === "SKILL.md" ? dirname(absolute) : absolute;
}

type PiSkillIdentity = { name: string; directory: string };

function readPiSkillIdentity(path: string): PiSkillIdentity {
  const directory = piSkillDirectory(path);
  const frontmatter = readFileSync(resolve(directory, "SKILL.md"), "utf8")
    .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const name = frontmatter?.match(/^name:\s*["']?([a-zA-Z0-9._-]+)["']?\s*$/m)?.[1];
  if (!name) throw new Error(`${directory}/SKILL.md has no valid name frontmatter`);
  return { name, directory };
}

function hasMattPocockProvenance(skill: PiSkillIdentity): boolean {
  const installRoot = resolve(skill.directory, "../..");
  if (skill.directory !== resolve(installRoot, "skills", skill.name)) return false;
  try {
    const lock = JSON.parse(readFileSync(resolve(installRoot, ".skill-lock.json"), "utf8")) as {
      version?: unknown;
      skills?: Record<string, Record<string, unknown>>;
    };
    const entry = lock.skills?.[skill.name];
    return lock.version === 3
      && entry?.source === "mattpocock/skills"
      && entry.sourceType === "github"
      && entry.sourceUrl === "https://github.com/mattpocock/skills.git"
      && entry.skillPath === `skills/engineering/${skill.name}/SKILL.md`
      && entry.pluginName === "mattpocock-skills"
      && typeof entry.skillFolderHash === "string"
      && entry.skillFolderHash.length > 0;
  } catch {
    return false;
  }
}

function sameSet(actual: string[], expected: string[]): boolean {
  const values = new Set(actual);
  return values.size === expected.length && expected.every((value) => values.has(value));
}

function result(ok: boolean, action: TickAction, jobId: string | null, messageValue: string): TickResult {
  return { ok, action, jobId, message: messageValue };
}

function safeToken(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "job";
}

function validReviewerValidationArgv(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 32
    && value.every((argument) => typeof argument === "string" && argument.length > 0 && argument.length <= 8192);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function withHerdrDiagnostic(summary: string, diagnostic: string | null): string {
  return diagnostic ? `${summary}\nHerdr diagnostics (untrusted):\n${diagnostic}` : summary;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
