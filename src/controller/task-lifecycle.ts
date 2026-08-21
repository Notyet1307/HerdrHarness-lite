import { assertJobInvariant, evolveJob, taskFromSelection, type HarnessState, type Job } from "../model.js";
import { selectNextTask } from "../eligibility.js";
import type { ControllerContext } from "./context.js";
import { message, result, safeToken, trimSlash } from "./helpers.js";
import { runRuntimePreflight } from "./runtime-preflight.js";
import type { TickResult } from "./types.js";

export async function selectJob(ctx: ControllerContext, state: HarnessState): Promise<TickResult> {
  const graph = await ctx.deps.github.listIssueGraph(ctx.deps.config.repo, ctx.deps.config.readyLabel);
  const claimed = new Set(state.terminalJobs.filter((terminal) => terminal.state === "done").map((terminal) => terminal.issueNumber));
  const selected = selectNextTask(graph, {
    readyLabel: ctx.deps.config.readyLabel,
    claimedIssueNumbers: claimed,
  }).selected;
  if (!selected) return result(true, "idle", null, "no executable ready-for-agent issue");

  const preflight = await runRuntimePreflight(ctx, ["worker", "reviewer"], null);
  if (preflight.ok === false) return preflight.result;

  const baseSha = await ctx.deps.git.refreshBase(ctx.deps.config.localPath, ctx.deps.config.baseRef);
  const now = ctx.deps.clock.now();
  const jobId = ctx.deps.ids.next("job");
  const suffix = safeToken(jobId).slice(-10);
  const task = taskFromSelection(ctx.deps.config.repo, selected);
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
    maxReviewRounds: ctx.deps.config.maxReviewRounds,
    pendingHandoff: null,
    incident: null,
    analysis: null,
    approval: null,
    reassessments: [],
    pullRequest: null,
    ciFailure: null,
    ciReworkCount: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  assertJobInvariant(job);
  await ctx.deps.store.save({ ...state, activeJob: job }, null);
  return result(true, "selected", job.id, `selected ${task.repo}#${task.issueNumber}; claim intent is durable`);
}

export async function advanceClaim(ctx: ControllerContext, state: HarnessState, job: Job): Promise<TickResult> {
  if (!job.claimConfirmed) {
    const currentIssue = await ctx.deps.github.getIssue(ctx.deps.config.repo, job.task.issueNumber);
    const alreadyClaimed = currentIssue.labels.includes(ctx.deps.config.claimLabel);
    let selected: ReturnType<typeof selectNextTask>["selected"] = {
      issue: currentIssue,
      mapNumber: job.task.mapNumber,
      selectionKey: job.task.mapNumber ?? job.task.issueNumber,
    };

    if (!alreadyClaimed) {
      const graph = await ctx.deps.github.listIssueGraph(ctx.deps.config.repo, ctx.deps.config.readyLabel);
      selected = selectNextTask(graph, {
        readyLabel: ctx.deps.config.readyLabel,
        claimedIssueNumbers: new Set(state.terminalJobs.filter((terminal) => terminal.state === "done").map((terminal) => terminal.issueNumber)),
      }).selected;
      if (!selected || selected.issue.number !== job.task.issueNumber || selected.mapNumber !== job.task.mapNumber) {
        return ctx.block(state, job, {
          class: "stale_task",
          lane: "controller",
          summary: "GitHub frontier changed before the claim could be confirmed",
          attemptResult: null,
        });
      }
    }

    if (!selected) throw new Error("internal: selected claim disappeared");
    const freshTask = taskFromSelection(ctx.deps.config.repo, selected);
    if (freshTask.digest !== job.task.digest || currentIssue.state !== "OPEN") {
      return ctx.block(state, job, {
        class: "stale_task",
        lane: "controller",
        summary: "issue objective or state changed after selection; a new claim is required",
        attemptResult: null,
      });
    }

    if (!alreadyClaimed) {
      try {
        await ctx.deps.github.claimIssue({
          repo: ctx.deps.config.repo,
          task: selected,
          jobId: job.id,
          claimLabel: ctx.deps.config.claimLabel,
          readyLabel: ctx.deps.config.readyLabel,
        });
      } catch (error) {
        return result(false, "claimed", job.id, `GitHub claim not confirmed: ${message(error)}`);
      }
    }

    let analyst;
    try {
      analyst = await ctx.deps.analyst.start({ jobId: job.id, task: job.task });
    } catch (error) {
      return ctx.block(state, job, {
        class: "analyst_unavailable",
        lane: "controller",
        summary: `task-bound Codex Analyst could not start: ${message(error)}`,
        attemptResult: null,
      });
    }
    const next = evolveJob(job, ctx.deps.clock.now(), {
      claimConfirmed: true,
      analyst,
      lastError: null,
    });
    await ctx.saveJob(state, job, next);
    return result(true, "claimed", job.id, "GitHub claim and task-bound Analyst are confirmed");
  }

  if (!job.analyst) {
    return ctx.block(state, job, {
      class: "analyst_unavailable",
      lane: "controller",
      summary: "claim is confirmed but no Analyst is bound to the task digest",
      attemptResult: null,
    });
  }
  if (job.worktree) {
    const next = evolveJob(job, ctx.deps.clock.now(), { state: "worker_ready" });
    await ctx.saveJob(state, job, next);
    return result(true, "worktree_created", job.id, "existing worktree accepted; worker lane is ready");
  }

  const path = `${trimSlash(ctx.deps.config.worktreeRoot)}/${safeToken(ctx.deps.config.repo)}/issue-${job.task.issueNumber}-${safeToken(job.id).slice(-10)}`;
  let worktree;
  try {
    worktree = await ctx.deps.herdr.createWorktree({
      sourcePath: ctx.deps.config.localPath,
      branch: job.branch,
      baseRef: job.baseSha,
      path,
      label: `issue #${job.task.issueNumber}`,
    });
  } catch (error) {
    return result(false, "claimed", job.id, `Herdr worktree not ready: ${message(error)}`);
  }
  if (worktree.branch !== job.branch || worktree.path !== path) {
    return ctx.block(state, job, {
      class: "integrity_violation",
      lane: "controller",
      summary: "Herdr returned a different worktree identity than requested",
      attemptResult: null,
    });
  }
  const next = evolveJob(job, ctx.deps.clock.now(), {
    state: "worker_ready",
    worktree,
    lastError: null,
  });
  await ctx.saveJob(state, job, next);
  return result(true, "worktree_created", job.id, `Herdr worktree created at ${worktree.path}`);
}

export async function archive(ctx: ControllerContext, state: HarnessState, job: Job): Promise<TickResult> {
  if (job.state === "cancelled") {
    try {
      if (job.activeAttempt?.handle) await ctx.closeAttempt(job.activeAttempt, "cancelled");
      await ctx.deps.github.requeueIssue({
        repo: ctx.deps.config.repo,
        issueNumber: job.task.issueNumber,
        claimLabel: ctx.deps.config.claimLabel,
        readyLabel: ctx.deps.config.readyLabel,
      });
    } catch (error) {
      return result(false, "archived", job.id, `cancelled job could not be requeued safely: ${message(error)}`);
    }
  }
  try {
    await ctx.deps.analyst.close({ jobId: job.id, taskDigest: job.task.digest, session: job.analyst });
  } catch (error) {
    return result(false, "archived", job.id, `Codex Analyst could not be closed safely: ${message(error)}`);
  }
  let warning = "";
  if (job.state === "done") {
    try {
      await ctx.deps.github.releaseIssueClaim({
        repo: ctx.deps.config.repo,
        issueNumber: job.task.issueNumber,
        claimLabel: ctx.deps.config.claimLabel,
      });
    } catch (error) {
      warning = `; warning: claim label cleanup failed: ${message(error)}`;
    }
  }
  const terminal = {
    id: job.id,
    repo: job.task.repo,
    issueNumber: job.task.issueNumber,
    state: job.state as "done" | "cancelled",
    finishedAt: job.updatedAt,
    cancellation: job.cancellation ?? null,
    reassessments: job.reassessments ?? [],
  } as const;
  const terminalJobs = state.terminalJobs.some((entry) => entry.id === job.id)
    ? state.terminalJobs
    : [...state.terminalJobs, terminal];
  await ctx.deps.store.save({ version: 1, activeJob: null, terminalJobs }, job.revision);
  return result(true, "archived", job.id, `${job.state} job archived; the slot is free${warning}`);
}
