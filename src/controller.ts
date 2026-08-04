import { selectNextTask } from "./eligibility.js";
import {
  assertJobInvariant,
  digest,
  evolveJob,
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
import { buildEvidencePack, makeIncident, validateAttemptResult } from "./policy.js";
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
    let attempt: Attempt = {
      id: attemptId,
      lane,
      phase: "prepared",
      round: job.reviewRound + 1,
      baseSha: lane === "worker" ? (job.headSha ?? job.baseSha) : job.baseSha,
      expectedHeadSha: lane === "reviewer" ? job.headSha : null,
      resultPath: `${trimSlash(job.worktree.path)}/.harness/attempt-${safeToken(attemptId)}.json`,
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
      let handle;
      try {
        handle = await this.deps.herdr.createAttemptPane({
          worktree: job.worktree,
          attempt,
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
        await this.deps.herdr.prompt({ handle: attempt.handle, dispatchId: attempt.id, text: prompt });
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
      return this.block(state, job, {
        class: "infrastructure_exhausted",
        lane,
        summary: `Herdr ${lane} wait failed: ${message(error)}`,
        attemptResult: null,
      });
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
    const verification = await this.deps.git.verifyReviewer({
      worktree: job.worktree,
      expectedHeadSha: job.headSha,
      reportedHeadSha: review.reviewedHeadSha,
    });
    if (!verification.ok) {
      return this.block(state, job, {
        class: verification.class,
        lane: "reviewer",
        summary: verification.reason,
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
    return result(true, "published", job.id, `PR #${pullRequest.number} published; merge remains external`);
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
      if (action === "retry_fresh_worker" && !output.resolutionBrief.trim()) {
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
        resolutionBrief: action === "retry_fresh_worker" ? output.resolutionBrief : "",
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
      approval.action !== "retry_fresh_worker" ||
      analysis.action !== "retry_fresh_worker"
    ) {
      return this.block(state, job, {
        class: "integrity_violation",
        lane: "controller",
        summary: "approval binding is stale or inconsistent",
        attemptResult: null,
      });
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
      state: "worker_ready",
      activeAttempt: null,
      attempts,
      pendingBrief: analysis.resolutionBrief,
      incident: null,
      analysis: null,
      approval: consumed,
      lastError: null,
    });
    await this.saveJob(state, job, next);
    return result(true, "recovery_applied", job.id, "approval consumed; a fresh worker attempt is now required");
  }

  private async archive(state: HarnessState, job: Job): Promise<TickResult> {
    const terminal = {
      id: job.id,
      repo: job.task.repo,
      issueNumber: job.task.issueNumber,
      state: job.state as "done" | "cancelled",
      finishedAt: job.updatedAt,
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
    ["baseRef", config.baseRef],
    ["readyLabel", config.readyLabel],
    ["claimLabel", config.claimLabel],
    ["worktreeRoot", config.worktreeRoot],
  ] as const) {
    if (!value.trim()) throw new Error(`${name} must not be empty`);
  }
  if (!Number.isInteger(config.maxReviewRounds) || config.maxReviewRounds < 1) {
    throw new Error("maxReviewRounds must be a positive integer");
  }
  if (!Number.isInteger(config.maxAnalystTurns) || config.maxAnalystTurns < 1 || config.maxAnalystTurns > 5) {
    throw new Error("maxAnalystTurns must be between 1 and 5");
  }
  if (config.workerArgv.length === 0 || config.reviewerArgv.length === 0) {
    throw new Error("workerArgv and reviewerArgv must not be empty");
  }
}

function result(ok: boolean, action: TickAction, jobId: string | null, messageValue: string): TickResult {
  return { ok, action, jobId, message: messageValue };
}

function safeToken(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "job";
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
