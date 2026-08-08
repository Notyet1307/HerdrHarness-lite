import { existsSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { selectNextTask } from "./eligibility.js";
import { assertJobInvariant, digest, evolveJob, isRetryAction, MAX_CI_REWORKS, taskFromSelection, } from "./model.js";
import { allowedActionsFor, buildEvidencePack, isDecisionResolutionEligible, makeIncident, validateAttemptResult } from "./policy.js";
import { reviewerPrompt, workerPrompt } from "./prompts.js";
import { pathIsWithin, pathsOverlap } from "./path-safety.js";
const BUNDLED_CODE_REVIEW_SKILL = resolve(import.meta.dirname, "../../pi/skills/code-review");
const BUNDLED_FOCUSED_SELF_CHECK_SKILL = resolve(import.meta.dirname, "../../pi/skills/focused-self-check");
const BUNDLED_WORKER_TOOLS_EXTENSION = resolve(import.meta.dirname, "../../pi/extensions/worker-tools.js");
const BUNDLED_REVIEWER_TOOLS_EXTENSION = resolve(import.meta.dirname, "../../pi/extensions/reviewer-tools.js");
const WORKER_DESCRIPTOR_ENV = "HERDR_HARNESS_WORKER_DESCRIPTOR";
const REVIEW_DESCRIPTOR_ENV = "HERDR_HARNESS_REVIEW_DESCRIPTOR";
const REVIEW_SUBAGENT_CEILING_ENV = "PI_SUBAGENT_CAPABILITY_CEILING_V1";
const REVIEW_SUBAGENT_CEILING = Buffer.from(JSON.stringify({
    version: 1,
    allowedTools: ["find", "grep", "ls", "read"],
    allowedAgents: ["herdr-harness-review-axis"],
    denyExtensions: true,
    sources: ["herdr-harness-lite"],
}), "utf8").toString("base64url");
/**
 * One controller owns all writes. Each tick performs at most one durable state
 * transition, so restarts resume from the ledger instead of replaying a whole
 * orchestration script.
 */
export class HarnessController {
    deps;
    constructor(deps) {
        this.deps = deps;
        validateConfig(deps.config);
    }
    async tick() {
        const state = await this.deps.store.load();
        const job = state.activeJob;
        if (!job)
            return this.selectJob(state);
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
    async selectJob(state) {
        const graph = await this.deps.github.listIssueGraph(this.deps.config.repo, this.deps.config.readyLabel);
        const claimed = new Set(state.terminalJobs.filter((terminal) => terminal.state === "done").map((terminal) => terminal.issueNumber));
        const selected = selectNextTask(graph, {
            readyLabel: this.deps.config.readyLabel,
            claimedIssueNumbers: claimed,
        }).selected;
        if (!selected)
            return result(true, "idle", null, "no executable ready-for-agent issue");
        const preflight = await this.runRuntimePreflight(["worker", "reviewer"], null);
        if (!preflight.ok)
            return preflight.result;
        const baseSha = await this.deps.git.refreshBase(this.deps.config.localPath, this.deps.config.baseRef);
        const now = this.deps.clock.now();
        const jobId = this.deps.ids.next("job");
        const suffix = safeToken(jobId).slice(-10);
        const task = taskFromSelection(this.deps.config.repo, selected);
        const job = {
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
            ciFailure: null,
            ciReworkCount: 0,
            lastError: null,
            createdAt: now,
            updatedAt: now,
        };
        assertJobInvariant(job);
        await this.deps.store.save({ ...state, activeJob: job }, null);
        return result(true, "selected", job.id, `selected ${task.repo}#${task.issueNumber}; claim intent is durable`);
    }
    async advanceClaim(state, job) {
        if (!job.claimConfirmed) {
            const currentIssue = await this.deps.github.getIssue(this.deps.config.repo, job.task.issueNumber);
            const alreadyClaimed = currentIssue.labels.includes(this.deps.config.claimLabel);
            let selected = {
                issue: currentIssue,
                mapNumber: job.task.mapNumber,
                selectionKey: job.task.mapNumber ?? job.task.issueNumber,
            };
            if (!alreadyClaimed) {
                const graph = await this.deps.github.listIssueGraph(this.deps.config.repo, this.deps.config.readyLabel);
                selected = selectNextTask(graph, {
                    readyLabel: this.deps.config.readyLabel,
                    claimedIssueNumbers: new Set(state.terminalJobs.filter((terminal) => terminal.state === "done").map((terminal) => terminal.issueNumber)),
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
            if (!selected)
                throw new Error("internal: selected claim disappeared");
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
                }
                catch (error) {
                    return result(false, "claimed", job.id, `GitHub claim not confirmed: ${message(error)}`);
                }
            }
            let analyst;
            try {
                analyst = await this.deps.analyst.start({ jobId: job.id, task: job.task });
            }
            catch (error) {
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
        }
        catch (error) {
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
    async prepareAttempt(state, job, lane) {
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
        const attemptRoot = resolve(this.deps.config.stateDir, `${lane}-attempts`, safeToken(job.id), safeToken(attemptId));
        let attempt = {
            id: attemptId,
            lane,
            phase: "prepared",
            round: job.reviewRound + 1,
            baseSha: lane === "worker" ? (job.headSha ?? job.baseSha) : job.baseSha,
            expectedHeadSha: lane === "reviewer" ? job.headSha : null,
            expectedRemoteHeadSha: lane === "worker" ? (job.pullRequest?.headSha ?? null) : null,
            resultPath: lane === "reviewer"
                ? resolve(attemptRoot, "result.json")
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
    async driveAttempt(state, job, lane) {
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
                const integrityBlock = await this.verifyReviewerPreflight(state, job, attempt, attempt.expectedHeadSha, null);
                if (integrityBlock)
                    return integrityBlock;
            }
            const preflight = await this.runRuntimePreflight([lane], job.id);
            if (!preflight.ok)
                return preflight.result;
            let handle;
            try {
                let cwd = job.worktree.path;
                let env = lane === "worker" ? { PYTHONDONTWRITEBYTECODE: "1" } : {};
                if (lane === "worker") {
                    const channel = await this.deps.git.prepareWorkerResult({
                        worktree: job.worktree,
                        rootPath: resolve(this.deps.config.stateDir, "worker-attempts", safeToken(job.id), safeToken(attempt.id)),
                        resultPath: attempt.resultPath,
                        jobId: job.id,
                        attemptId: attempt.id,
                    });
                    env[WORKER_DESCRIPTOR_ENV] = channel.descriptorPath;
                    if (preflight.dockerHost)
                        env.DOCKER_HOST = preflight.dockerHost;
                }
                if (lane === "reviewer") {
                    if (!attempt.expectedHeadSha)
                        throw new Error("Reviewer attempt has no expected HEAD");
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
                        dockerHost: preflight.dockerHost,
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
            }
            catch (error) {
                return this.block(state, job, {
                    class: "infrastructure_exhausted",
                    lane,
                    summary: `Herdr ${lane} pane creation failed: ${message(error)}`,
                    attemptResult: null,
                });
            }
            const ready = { ...attempt, phase: "pane_ready", handle };
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
            }
            catch (error) {
                return this.block(state, job, {
                    class: "infrastructure_exhausted",
                    lane,
                    summary: `Herdr ${lane} start failed: ${message(error)}`,
                    attemptResult: null,
                });
            }
            const ready = { ...attempt, phase: "agent_ready" };
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
            const running = { ...attempt, phase: "running" };
            const next = evolveJob(job, this.deps.clock.now(), { activeAttempt: running });
            await this.saveJob(state, job, next);
            try {
                await this.deps.herdr.prompt({
                    handle: attempt.handle,
                    dispatchId: attempt.id,
                    skill: lane === "worker" ? "implement" : "code-review",
                    text: prompt,
                });
            }
            catch (error) {
                return result(false, "attempt_dispatched", job.id, `Herdr ${lane} dispatch outcome is uncertain and will only be observed: ${message(error)}`);
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
        }
        catch (error) {
            if (lane === "reviewer") {
                const integrityBlock = await this.verifyReviewerIntegrity(state, job, attempt, null, null);
                if (integrityBlock)
                    return integrityBlock;
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
            if (integrityBlock)
                return integrityBlock;
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
        if (lane === "worker")
            return this.finishWorker(state, job, attempt, validated.result, observation.diagnostic);
        return this.finishReviewer(state, job, attempt, validated.result, observation.diagnostic);
    }
    async runRuntimePreflight(lanes, jobId) {
        let dockerHost = null;
        try {
            if (this.deps.config.preflight?.dockerRequired === true) {
                dockerHost = (await this.deps.preflight.probeDocker({ cwd: this.deps.config.localPath })).host;
            }
            for (const lane of lanes) {
                await this.deps.preflight.probeProvider({
                    lane,
                    cwd: this.deps.config.localPath,
                    roleArgv: lane === "worker" ? this.deps.config.workerArgv : this.deps.config.reviewerArgv,
                    piBin: this.deps.config.preflight?.piBin ?? "pi",
                });
            }
            return { ok: true, dockerHost };
        }
        catch (error) {
            return {
                ok: false,
                result: result(false, "preflight_failed", jobId, message(error)),
            };
        }
    }
    async verifyReviewerIntegrity(state, job, attempt, reportedHeadSha, attemptResult) {
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
                .filter((path) => pathIsWithin(job.worktree.path, path)),
        });
        if (verification.ok)
            return null;
        return this.block(state, job, {
            class: verification.class,
            lane: "reviewer",
            summary: `Reviewer boundary violation: ${verification.reason}`,
            attemptResult,
        });
    }
    async verifyReviewerPreflight(state, job, attempt, reportedHeadSha, attemptResult) {
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
                .filter((path) => pathIsWithin(job.worktree.path, path)),
        });
        if (verification.ok)
            return null;
        const preflightResidue = verification.kind === "worktree_dirty" && attempt.handle === null;
        return this.block(state, job, {
            class: preflightResidue ? "reviewer_preflight_dirty" : verification.class,
            lane: "reviewer",
            summary: preflightResidue
                ? `Worktree residue existed before Reviewer start: ${verification.reason}`
                : `Reviewer boundary violation: ${verification.reason}`,
            attemptResult,
        });
    }
    async finishWorker(state, job, attempt, worker, diagnostic) {
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
            expectedRemoteHeadSha: attempt.expectedRemoteHeadSha ?? null,
            allowedResultPaths: [...job.attempts.map((settled) => settled.resultPath), attempt.resultPath]
                .filter((path) => pathIsWithin(job.worktree.path, path)),
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
        if (cleanup)
            return cleanup;
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
    async finishReviewer(state, job, attempt, review, diagnostic) {
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
            if (cleanup)
                return cleanup;
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
        if (cleanup)
            return cleanup;
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
    async closeCompletedAttempt(job, attempt) {
        if (!attempt.handle) {
            return result(false, "attempt_completed", job.id, `${attempt.lane} pane identity is missing; completion was not recorded`);
        }
        try {
            await this.deps.herdr.close(attempt.handle);
            return null;
        }
        catch (error) {
            return result(false, "attempt_completed", job.id, `${attempt.lane} pane close is not confirmed: ${message(error)}`);
        }
    }
    async publish(state, job) {
        if (!job.headSha) {
            return this.block(state, job, {
                class: "integrity_violation",
                lane: "controller",
                summary: "publish lane has no reviewed HEAD",
                attemptResult: null,
            });
        }
        const refreshed = await this.refreshBaseForReview(state, job, false, "publish_retry");
        if (refreshed)
            return refreshed;
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
        }
        catch (error) {
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
            ciFailure: null,
            lastError: null,
        });
        await this.saveJob(state, job, next);
        return result(true, "published", job.id, this.deps.config.autoMerge
            ? `PR #${pullRequest.number} published with native auto-merge requested`
            : `PR #${pullRequest.number} published; merge remains external`);
    }
    async observeMerge(state, job) {
        if (!job.pullRequest) {
            return this.block(state, job, {
                class: "integrity_violation",
                lane: "controller",
                summary: "awaiting_merge has no pull request identity",
                attemptResult: null,
            });
        }
        let observation;
        try {
            observation = await this.deps.github.observePullRequest(job.task.repo, job.pullRequest);
        }
        catch (error) {
            return result(false, "waiting_for_merge", job.id, `PR observation is retryable: ${message(error)}`);
        }
        if (observation.status === "open") {
            const failedChecks = observation.requiredChecks.filter(isFailedCheck);
            if (failedChecks.length > 0) {
                if (observation.autoMergeEnabled) {
                    try {
                        await this.deps.github.suspendAutoMerge(job.task.repo, job.pullRequest);
                    }
                    catch (error) {
                        return result(false, "waiting_for_merge", job.id, `required CI failed but auto-merge suspension is not confirmed: ${message(error)}`);
                    }
                }
                const ciFailure = {
                    headSha: job.pullRequest.headSha,
                    observedAt: this.deps.clock.now(),
                    checks: failedChecks,
                };
                return this.block(state, job, {
                    class: (job.ciReworkCount ?? 0) >= MAX_CI_REWORKS ? "ci_rework_exhausted" : "ci_failure",
                    lane: "controller",
                    summary: summarizeCiFailure(job.pullRequest.number, ciFailure),
                    attemptResult: null,
                    ciFailure,
                });
            }
            if (observation.requiredChecks.some((check) => check.bucket === "pending")) {
                return result(true, "waiting_for_merge", job.id, `PR #${job.pullRequest.number} required checks are still pending`);
            }
            const refreshed = await this.refreshBaseForReview(state, job, observation.autoMergeEnabled, "waiting_for_merge");
            if (refreshed)
                return refreshed;
            return result(true, "waiting_for_merge", job.id, `PR #${job.pullRequest.number} is still open`);
        }
        if (observation.status === "closed_unmerged") {
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
    async refreshBaseForReview(state, job, autoMergeEnabled, retryAction) {
        if (!job.worktree || !job.headSha) {
            return this.block(state, job, {
                class: "integrity_violation",
                lane: "controller",
                summary: "base refresh requires a worktree and reviewed HEAD",
                attemptResult: null,
            });
        }
        let latestBaseSha;
        try {
            latestBaseSha = await this.deps.git.refreshBase(this.deps.config.localPath, this.deps.config.baseRef);
        }
        catch (error) {
            return result(false, retryAction, job.id, `base refresh is retryable: ${message(error)}`);
        }
        if (latestBaseSha === job.baseSha)
            return null;
        if (autoMergeEnabled && job.pullRequest) {
            try {
                await this.deps.github.suspendAutoMerge(job.task.repo, job.pullRequest);
            }
            catch (error) {
                return result(false, retryAction, job.id, `base moved but auto-merge suspension is not confirmed: ${message(error)}`);
            }
        }
        let verification;
        try {
            verification = await this.deps.git.syncBase({
                worktree: job.worktree,
                branch: job.branch,
                baseRef: this.deps.config.baseRef,
                expectedHeadSha: job.headSha,
                expectedRemoteHeadSha: job.pullRequest?.headSha ?? null,
                latestBaseSha,
            });
        }
        catch (error) {
            return result(false, retryAction, job.id, `base refresh is retryable: ${message(error)}`);
        }
        if (!verification.ok) {
            return this.block(state, job, {
                class: verification.class,
                lane: "controller",
                summary: verification.reason,
                attemptResult: null,
            });
        }
        const next = evolveJob(job, this.deps.clock.now(), {
            state: "reviewer_ready",
            baseSha: latestBaseSha,
            headSha: verification.headSha,
            activeAttempt: null,
            ciFailure: null,
            lastError: null,
        });
        await this.saveJob(state, job, next);
        return result(true, "base_refreshed", job.id, `base advanced to ${latestBaseSha}; refreshed HEAD ${verification.headSha} requires fresh review`);
    }
    async diagnoseOrWait(state, job) {
        const recovered = await this.reconcileBlockedCi(state, job);
        if (recovered)
            return recovered;
        if (!job.incident)
            throw new Error("blocked job has no incident");
        if (job.analysis) {
            return result(true, "waiting_for_approval", job.id, `analysis ${job.analysis.id} is ready; human approval is required`);
        }
        if (!job.analyst) {
            return result(true, "waiting_for_approval", job.id, "Analyst is unavailable; incident can only be held or cancelled");
        }
        let advice;
        try {
            advice = await this.runDiagnosis(job, job.incident);
        }
        catch (error) {
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
    async reconcileBlockedCi(state, job) {
        if ((job.incident?.class !== "ci_failure" && job.incident?.class !== "ci_rework_exhausted") ||
            !job.pullRequest ||
            !job.ciFailure ||
            job.headSha !== job.pullRequest.headSha ||
            job.ciFailure.headSha !== job.pullRequest.headSha)
            return null;
        let observation;
        try {
            observation = await this.deps.github.observePullRequest(job.task.repo, job.pullRequest);
        }
        catch (error) {
            return result(false, "waiting_for_approval", job.id, `exact-HEAD CI reconciliation is retryable: ${message(error)}`);
        }
        if (observation.status === "merged") {
            const next = evolveJob(job, this.deps.clock.now(), {
                state: "done",
                incident: null,
                analysis: null,
                ciFailure: null,
                lastError: null,
            });
            await this.saveJob(state, job, next);
            return result(true, "merged", job.id, `PR #${job.pullRequest.number} merged while CI recovery was held`);
        }
        if (observation.status !== "open" ||
            observation.requiredChecks.length === 0 ||
            observation.requiredChecks.some((check) => check.bucket !== "pass" && check.bucket !== "skipping"))
            return null;
        const next = evolveJob(job, this.deps.clock.now(), {
            state: "publish_ready",
            incident: null,
            analysis: null,
            ciFailure: null,
            lastError: null,
        });
        await this.saveJob(state, job, next);
        return result(true, "ci_recovered", job.id, `PR #${job.pullRequest.number} required checks recovered on unchanged HEAD ${job.pullRequest.headSha}`);
    }
    async runDiagnosis(job, incident) {
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
            const output = await this.deps.analyst.turn({ session: job.analyst, job, evidence: pack, turn });
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
    async applyRecovery(state, job) {
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
        const humanDecision = approval.basis === "human_decision";
        if (approval.jobRevision >= job.revision ||
            approval.incidentId !== incident.id ||
            approval.analysisId !== analysis.id ||
            !isRetryAction(approval.action) ||
            (humanDecision ? !isDecisionResolutionEligible(job) : approval.action !== analysis.action) ||
            !incident.allowedActions.includes(approval.action) ||
            !allowedActionsFor(incident.class, incident.lane).includes(approval.action)) {
            return this.block(state, job, {
                class: "integrity_violation",
                lane: "controller",
                summary: "approval binding is stale or inconsistent",
                attemptResult: null,
            });
        }
        const ciRecovery = approval.action === "retry_fresh_worker" && incident.class === "ci_failure";
        if (ciRecovery) {
            if (incident.lane !== "controller" ||
                incident.attemptId !== null ||
                job.activeAttempt !== null ||
                !job.pullRequest ||
                !job.ciFailure ||
                job.ciFailure.headSha !== job.pullRequest.headSha ||
                job.headSha !== job.pullRequest.headSha ||
                (job.ciReworkCount ?? 0) >= MAX_CI_REWORKS) {
                return this.block(state, job, {
                    class: "integrity_violation",
                    lane: "controller",
                    summary: "fresh Worker CI recovery lost its exact PR or Git binding",
                    attemptResult: null,
                });
            }
            let observation;
            try {
                observation = await this.deps.github.observePullRequest(job.task.repo, job.pullRequest);
                if (observation.status !== "open")
                    throw new Error(`PR is ${observation.status}`);
                if (observation.autoMergeEnabled)
                    await this.deps.github.suspendAutoMerge(job.task.repo, job.pullRequest);
            }
            catch (error) {
                return result(false, "recovery_applied", job.id, `CI recovery safety check is retryable: ${message(error)}`);
            }
        }
        if (approval.action === "retry_fresh_reviewer") {
            if ((incident.class !== "infrastructure_exhausted" && incident.class !== "reviewer_preflight_dirty") ||
                incident.lane !== "reviewer" ||
                job.activeAttempt?.lane !== "reviewer" ||
                incident.attemptId !== job.activeAttempt.id) {
                return this.block(state, job, {
                    class: "integrity_violation",
                    lane: "controller",
                    summary: "fresh Reviewer recovery lost its exact incident or Git binding",
                    attemptResult: job.activeAttempt?.result ?? null,
                });
            }
            const integrityBlock = await this.verifyReviewerPreflight(state, job, job.activeAttempt, job.headSha, job.activeAttempt.result);
            if (integrityBlock)
                return integrityBlock;
        }
        if (job.activeAttempt?.handle) {
            try {
                await this.deps.herdr.close(job.activeAttempt.handle);
            }
            catch (error) {
                return result(false, "recovery_applied", job.id, `old agent could not be closed safely: ${message(error)}`);
            }
        }
        const now = this.deps.clock.now();
        const attempts = job.activeAttempt
            ? [...job.attempts, settleAttempt(job.activeAttempt, job.activeAttempt.result, now)]
            : job.attempts;
        const consumed = { ...approval, consumedAt: now };
        const decisionFindings = job.activeAttempt?.result?.lane === "reviewer"
            ? job.activeAttempt.result.findings
                .map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.summary} — ${finding.evidence}`)
                .join("\n")
            : "";
        const next = evolveJob(job, now, {
            state: approval.action === "retry_fresh_reviewer" ? "reviewer_ready" : "worker_ready",
            activeAttempt: null,
            attempts,
            pendingBrief: approval.action === "retry_fresh_worker"
                ? humanDecision
                    ? `Human-resolved decision:\n${approval.reason}\n\nBlocking Reviewer findings:\n${decisionFindings}`
                    : analysis.resolutionBrief
                : null,
            incident: null,
            analysis: null,
            approval: consumed,
            ...(ciRecovery ? { ciReworkCount: (job.ciReworkCount ?? 0) + 1 } : {}),
            lastError: null,
        });
        await this.saveJob(state, job, next);
        const lane = approval.action === "retry_fresh_reviewer" ? "Reviewer" : "Worker";
        return result(true, "recovery_applied", job.id, `approval consumed; a fresh ${lane} attempt is now required`);
    }
    async archive(state, job) {
        if (job.state === "cancelled") {
            try {
                if (job.activeAttempt?.handle)
                    await this.deps.herdr.close(job.activeAttempt.handle);
                await this.deps.github.requeueIssue({
                    repo: this.deps.config.repo,
                    issueNumber: job.task.issueNumber,
                    claimLabel: this.deps.config.claimLabel,
                    readyLabel: this.deps.config.readyLabel,
                });
            }
            catch (error) {
                return result(false, "archived", job.id, `cancelled job could not be requeued safely: ${message(error)}`);
            }
        }
        try {
            await this.deps.analyst.close({ jobId: job.id, taskDigest: job.task.digest, session: job.analyst });
        }
        catch (error) {
            return result(false, "archived", job.id, `Codex Analyst could not be closed safely: ${message(error)}`);
        }
        let warning = "";
        if (job.state === "done") {
            try {
                await this.deps.github.releaseIssueClaim({
                    repo: this.deps.config.repo,
                    issueNumber: job.task.issueNumber,
                    claimLabel: this.deps.config.claimLabel,
                });
            }
            catch (error) {
                warning = `; warning: claim label cleanup failed: ${message(error)}`;
            }
        }
        const terminal = {
            id: job.id,
            repo: job.task.repo,
            issueNumber: job.task.issueNumber,
            state: job.state,
            finishedAt: job.updatedAt,
            cancellation: job.cancellation ?? null,
            reassessments: job.reassessments ?? [],
        };
        const terminalJobs = state.terminalJobs.some((entry) => entry.id === job.id)
            ? state.terminalJobs
            : [...state.terminalJobs, terminal];
        await this.deps.store.save({ version: 1, activeJob: null, terminalJobs }, job.revision);
        return result(true, "archived", job.id, `${job.state} job archived; the slot is free${warning}`);
    }
    async block(state, job, input) {
        const now = this.deps.clock.now();
        const activeAttempt = job.activeAttempt
            ? {
                ...job.activeAttempt,
                phase: "settled",
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
            ...(input.ciFailure ? { ciFailure: input.ciFailure } : {}),
            lastError: input.summary,
        });
        await this.saveJob(state, job, next);
        return result(false, "blocked", job.id, `${input.class}: ${input.summary}`);
    }
    async saveJob(state, current, next) {
        assertJobInvariant(next);
        await this.deps.store.save({ ...state, activeJob: next }, current.revision);
    }
}
function settleAttempt(attempt, resultValue, now) {
    return {
        ...attempt,
        phase: "settled",
        result: resultValue,
        completedAt: attempt.completedAt ?? now,
    };
}
function dedupeEvidence(items) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        if (!item.ref.trim() || seen.has(item.ref))
            continue;
        seen.add(item.ref);
        result.push(item);
    }
    return result.slice(0, 32);
}
function isFailedCheck(check) {
    return check.bucket === "fail" || check.bucket === "cancel";
}
function summarizeCiFailure(number, failure) {
    const checks = failure.checks.slice(0, 8).map((check) => (`- ${check.name}: ${check.state} (${check.bucket})${check.link ? ` ${check.link}` : ""}`));
    if (failure.checks.length > checks.length)
        checks.push(`- ... ${failure.checks.length - checks.length} more failed checks`);
    return [`PR #${number} required CI failed at ${failure.headSha}:`, ...checks].join("\n");
}
function validateConfig(config) {
    for (const [name, value] of [
        ["repo", config.repo],
        ["localPath", config.localPath],
        ["stateDir", config.stateDir],
        ["baseRef", config.baseRef],
        ["readyLabel", config.readyLabel],
        ["claimLabel", config.claimLabel],
        ["worktreeRoot", config.worktreeRoot],
    ]) {
        if (!value.trim())
            throw new Error(`${name} must not be empty`);
    }
    for (const [name, path] of [["localPath", config.localPath], ["stateDir", config.stateDir], ["worktreeRoot", config.worktreeRoot]]) {
        if (!isAbsolute(path))
            throw new Error(`${name} must be absolute`);
    }
    if (pathsOverlap(config.localPath, config.stateDir))
        throw new Error("localPath and stateDir must not overlap");
    if (pathsOverlap(config.stateDir, config.worktreeRoot))
        throw new Error("stateDir and worktreeRoot must not overlap");
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
    ]) {
        if (!Array.isArray(value) || value.some((argument) => typeof argument !== "string")) {
            throw new Error(`${name} must be an array of strings`);
        }
    }
    if (!validReviewerValidationArgv(config.reviewerValidationArgv)) {
        throw new Error("reviewerValidationArgv must contain 1 to 32 non-empty arguments");
    }
    if (config.preflight !== undefined) {
        if (!config.preflight || typeof config.preflight !== "object") {
            throw new Error("preflight must be an object");
        }
        if (config.preflight.piBin !== undefined && !config.preflight.piBin.trim()) {
            throw new Error("preflight.piBin must not be empty");
        }
        if (config.preflight.dockerRequired !== undefined && typeof config.preflight.dockerRequired !== "boolean") {
            throw new Error("preflight.dockerRequired must be boolean");
        }
    }
    validatePiRoleArgv("workerArgv", config.workerArgv, ["implement", "tdd", "focused-self-check"], ["read", "bash", "edit", "write", "grep", "find", "ls", "worker_submit"], ["high", "xhigh", "max"]);
    validatePiRoleArgv("reviewerArgv", config.reviewerArgv, ["code-review"], ["read", "grep", "find", "ls", "subagent", "review_preflight", "review_validate", "review_submit"], ["max"]);
}
function validatePiRoleArgv(name, argv, skills, tools, allowedThinking) {
    const fail = (reason) => {
        throw new Error(`${name} must enforce the Pi role contract: ${reason}`);
    };
    validateAllowedPiArgv(argv, fail);
    if (!argv.includes("--no-approve"))
        fail("--no-approve is required");
    if (!argv.includes("--no-skills"))
        fail("--no-skills is required");
    if (name === "reviewerArgv") {
        validateReviewerExtensions(argv, fail);
    }
    else {
        validateWorkerExtension(argv, fail);
    }
    const skillPaths = flagValues(argv, "--skill");
    if (skillPaths.some((path) => !isAbsolute(path)))
        fail("skill paths must be absolute");
    let loadedSkillIdentities = [];
    try {
        loadedSkillIdentities = skillPaths.map(readPiSkillIdentity);
    }
    catch (error) {
        fail(`skill metadata cannot be verified: ${message(error)}`);
    }
    const loadedSkills = new Set(loadedSkillIdentities.map((skill) => skill.name));
    if (skills.some((skill) => !loadedSkills.has(skill)))
        fail(`required skills: ${skills.join(",")}`);
    const reviewSkills = loadedSkillIdentities.filter((skill) => skill.name === "code-review");
    if (skills.includes("code-review")) {
        if (reviewSkills.length !== 1 || reviewSkills[0].directory !== BUNDLED_CODE_REVIEW_SKILL) {
            fail("code-review must resolve to the bundled Harness skill");
        }
    }
    else if (reviewSkills.length > 0) {
        fail("Worker must leave complete code-review to the independent Reviewer");
    }
    const selfCheckSkills = loadedSkillIdentities.filter((skill) => skill.name === "focused-self-check");
    if (skills.includes("focused-self-check") && (selfCheckSkills.length !== 1 || selfCheckSkills[0].directory !== BUNDLED_FOCUSED_SELF_CHECK_SKILL)) {
        fail("focused-self-check must resolve to the bundled Harness skill");
    }
    for (const skillName of ["implement", "tdd"]) {
        if (!skills.includes(skillName))
            continue;
        const matches = loadedSkillIdentities.filter((skill) => skill.name === skillName);
        if (matches.length !== 1 || !hasMattPocockProvenance(matches[0])) {
            fail(`${skillName} must come from the installed mattpocock/skills package`);
        }
    }
    const toolValues = flagValues(argv, "--tools");
    if (toolValues.length !== 1 || !sameSet(toolValues[0].split(",").map((tool) => tool.trim()), tools)) {
        fail(`tools must be exactly: ${tools.join(",")}`);
    }
    const thinking = flagValues(argv, "--thinking");
    if (thinking.length !== 1 || !allowedThinking.includes(thinking[0])) {
        fail(`--thinking ${allowedThinking.join(" or ")} is required`);
    }
}
function validateWorkerExtension(argv, fail) {
    if (argv.filter((argument) => argument === "--no-extensions").length !== 1) {
        fail("exactly one --no-extensions is required");
    }
    const extensions = flagValues(argv, "--extension");
    if (extensions.length !== 1 || !isAbsolute(extensions[0]) || resolve(extensions[0]) !== BUNDLED_WORKER_TOOLS_EXTENSION) {
        fail("the sole Worker extension must be the bundled worker-tools extension");
    }
}
function flagValues(argv, flag) {
    return argv.flatMap((value, index) => value === flag && argv[index + 1] ? [argv[index + 1]] : []);
}
function validateAllowedPiArgv(argv, fail) {
    const valueFlags = new Set(["--skill", "--tools", "--thinking", "--provider", "--model", "--extension"]);
    const booleanFlags = new Set(["--no-approve", "--no-skills", "--no-session", "--no-extensions"]);
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (booleanFlags.has(argument))
            continue;
        if (!valueFlags.has(argument))
            fail(`unsupported Pi argument: ${argument}`);
        const value = argv[index + 1];
        if (!value || value.startsWith("-"))
            fail(`${argument} requires a separate value`);
        index += 1;
    }
}
function validateReviewerExtensions(argv, fail) {
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
    if (subagents.length !== 1 || !isPiSubagentsExtension(subagents[0])) {
        fail("the other Reviewer extension must be the declared pi-subagents package entrypoint");
    }
}
function isPiSubagentsExtension(path) {
    const extensionPath = resolve(path);
    const packageRoot = dirname(extensionPath);
    try {
        const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
        const capabilityEntrypoint = manifest.exports?.["./capability-ceiling"];
        return manifest.name === "pi-subagents"
            && existsSync(extensionPath)
            && Array.isArray(manifest.pi?.extensions)
            && manifest.pi.extensions.some((entry) => typeof entry === "string" && resolve(packageRoot, entry) === extensionPath)
            && typeof capabilityEntrypoint === "string"
            && existsSync(resolve(packageRoot, capabilityEntrypoint));
    }
    catch {
        return false;
    }
}
function piSkillDirectory(path) {
    const absolute = resolve(path);
    return basename(absolute) === "SKILL.md" ? dirname(absolute) : absolute;
}
function readPiSkillIdentity(path) {
    const directory = piSkillDirectory(path);
    const frontmatter = readFileSync(resolve(directory, "SKILL.md"), "utf8")
        .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    const name = frontmatter?.match(/^name:\s*["']?([a-zA-Z0-9._-]+)["']?\s*$/m)?.[1];
    if (!name)
        throw new Error(`${directory}/SKILL.md has no valid name frontmatter`);
    return { name, directory };
}
function hasMattPocockProvenance(skill) {
    const installRoot = resolve(skill.directory, "../..");
    if (skill.directory !== resolve(installRoot, "skills", skill.name))
        return false;
    try {
        const lock = JSON.parse(readFileSync(resolve(installRoot, ".skill-lock.json"), "utf8"));
        const entry = lock.skills?.[skill.name];
        return lock.version === 3
            && entry?.source === "mattpocock/skills"
            && entry.sourceType === "github"
            && entry.sourceUrl === "https://github.com/mattpocock/skills.git"
            && entry.skillPath === `skills/engineering/${skill.name}/SKILL.md`
            && entry.pluginName === "mattpocock-skills"
            && typeof entry.skillFolderHash === "string"
            && entry.skillFolderHash.length > 0;
    }
    catch {
        return false;
    }
}
function sameSet(actual, expected) {
    const values = new Set(actual);
    return values.size === expected.length && expected.every((value) => values.has(value));
}
function result(ok, action, jobId, messageValue) {
    return { ok, action, jobId, message: messageValue };
}
function safeToken(value) {
    const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return normalized || "job";
}
function validReviewerValidationArgv(value) {
    return Array.isArray(value) && value.length >= 1 && value.length <= 32
        && value.every((argument) => typeof argument === "string" && argument.length > 0 && argument.length <= 8192);
}
function trimSlash(value) {
    return value.replace(/\/+$/g, "");
}
function withHerdrDiagnostic(summary, diagnostic) {
    return diagnostic ? `${summary}\nHerdr diagnostics (untrusted):\n${diagnostic}` : summary;
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=controller.js.map