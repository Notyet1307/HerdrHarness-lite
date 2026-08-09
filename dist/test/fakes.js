import { join, resolve } from "node:path";
import { digest } from "../src/model.js";
export const validCodeReviewSkillPath = resolve("pi/skills/code-review");
export const validFocusedSelfCheckSkillPath = resolve("pi/skills/focused-self-check");
export const validPiSubagentsExtensionPath = resolve("test/fixtures/pi-subagents/index.js");
export const validWorkerToolsExtensionPath = resolve("pi/extensions/worker-tools.js");
export const validReviewerToolsExtensionPath = resolve("pi/extensions/reviewer-tools.js");
export const validImplementSkillPath = resolve("test/fixtures/pi-skills/skills/implement");
export const validTddSkillPath = resolve("test/fixtures/pi-skills/skills/tdd");
export const substituteCodeReviewSkillPath = resolve("test/fixtures/substitute-review/other/SKILL.md");
export const untrustedImplementSkillPath = resolve("test/fixtures/untrusted-skills/skills/implement");
export const validWorkerArgv = [
    "--no-approve",
    "--no-skills",
    "--no-extensions",
    "--extension", validWorkerToolsExtensionPath,
    "--skill", validImplementSkillPath,
    "--skill", validTddSkillPath,
    "--skill", validFocusedSelfCheckSkillPath,
    "--tools", "read,bash,edit,write,grep,find,ls,worker_submit",
    "--thinking", "high",
];
export const validReviewerArgv = [
    "--no-approve",
    "--no-skills",
    "--no-extensions",
    "--extension", validPiSubagentsExtensionPath,
    "--extension", validReviewerToolsExtensionPath,
    "--skill", validCodeReviewSkillPath,
    "--tools", "read,grep,find,ls,subagent,review_preflight,review_validate,review_submit",
    "--thinking", "max",
];
export class FakeClock {
    tick = 0;
    now() {
        this.tick += 1;
        return new Date(Date.UTC(2026, 7, 3, 0, 0, this.tick)).toISOString();
    }
}
export class SequenceIds {
    count = 0;
    next(prefix) {
        this.count += 1;
        return `${prefix}-${String(this.count).padStart(3, "0")}`;
    }
}
export class FakeRuntimePreflight {
    providerCalls = [];
    dockerCalls = [];
    providerFailure = null;
    dockerFailure = null;
    dockerHost = "unix:///tmp/docker.sock";
    async probeProvider(input) {
        this.providerCalls.push({ ...input, roleArgv: [...input.roleArgv] });
        if (this.providerFailure)
            throw this.providerFailure;
    }
    async probeDocker(input) {
        this.dockerCalls.push(input.cwd);
        if (this.dockerFailure)
            throw this.dockerFailure;
        return { host: this.dockerHost };
    }
}
export class MemoryStore {
    state = { version: 1, activeJob: null, terminalJobs: [] };
    saves = [];
    async load() {
        return clone(this.state);
    }
    async save(next, expectedActiveRevision) {
        const current = this.state.activeJob?.revision ?? null;
        if (current !== expectedActiveRevision)
            throw new Error(`CAS expected ${expectedActiveRevision}, current ${current}`);
        this.state = clone(next);
        this.saves.push(clone(next));
    }
}
export class FakeGitHub {
    graph;
    claims = [];
    releasedClaims = [];
    published = [];
    suspended = [];
    mergeStatus = "open";
    autoMergeEnabled = false;
    requiredChecks = [];
    suspendFailure = null;
    releaseClaimFailure = null;
    constructor(graph) {
        this.graph = graph;
    }
    async listIssueGraph(_repo, _readyLabel) {
        return clone(this.graph);
    }
    async getIssue(_repo, issueNumber) {
        const issue = this.graph.find((candidate) => candidate.number === issueNumber);
        if (!issue)
            throw new Error(`missing issue #${issueNumber}`);
        return clone(issue);
    }
    async claimIssue(input) {
        this.claims.push({ issue: input.task.issue.number, jobId: input.jobId });
        const issue = this.graph.find((candidate) => candidate.number === input.task.issue.number);
        if (issue) {
            issue.labels = issue.labels.filter((label) => label !== input.readyLabel);
            if (!issue.labels.includes(input.claimLabel))
                issue.labels.push(input.claimLabel);
        }
    }
    async requeueIssue(input) {
        const issue = this.graph.find((candidate) => candidate.number === input.issueNumber);
        if (!issue)
            throw new Error(`missing issue #${input.issueNumber}`);
        issue.labels = issue.labels.filter((label) => label !== input.claimLabel);
        if (!issue.labels.includes(input.readyLabel))
            issue.labels.push(input.readyLabel);
    }
    async releaseIssueClaim(input) {
        if (this.releaseClaimFailure)
            throw this.releaseClaimFailure;
        this.releasedClaims.push(input.issueNumber);
        const issue = this.graph.find((candidate) => candidate.number === input.issueNumber);
        if (issue)
            issue.labels = issue.labels.filter((label) => label !== input.claimLabel);
    }
    async publish(input) {
        const pr = { number: 42, url: "https://example.test/pr/42", headSha: input.headSha };
        this.published.push(pr);
        return pr;
    }
    async observePullRequest(_repo, _pullRequest) {
        return {
            status: this.mergeStatus,
            autoMergeEnabled: this.mergeStatus === "open" && this.autoMergeEnabled,
            requiredChecks: this.mergeStatus === "open" ? clone(this.requiredChecks) : [],
        };
    }
    async suspendAutoMerge(_repo, pullRequest) {
        if (this.suspendFailure)
            throw this.suspendFailure;
        this.suspended.push(pullRequest.number);
        this.autoMergeEnabled = false;
    }
}
export class FakeGit {
    baseSha = "a".repeat(40);
    baseSyncHeadSha = null;
    baseSyncFailure = null;
    baseSyncs = [];
    workerFailure = null;
    reviewerFailure = null;
    reviewerValidationArgv = [];
    reviewerDockerHosts = [];
    workerVerifications = [];
    async refreshBase() {
        return this.baseSha;
    }
    async syncBase(input) {
        this.baseSyncs.push({
            expectedHeadSha: input.expectedHeadSha,
            expectedRemoteHeadSha: input.expectedRemoteHeadSha,
            latestBaseSha: input.latestBaseSha,
        });
        return this.baseSyncFailure
            ? { ok: false, ...this.baseSyncFailure }
            : { ok: true, headSha: this.baseSyncHeadSha ?? input.expectedHeadSha };
    }
    async verifyWorker(input) {
        this.workerVerifications.push({
            reportedHeadSha: input.reportedHeadSha,
            expectedRemoteHeadSha: input.expectedRemoteHeadSha,
        });
        return this.workerFailure ? { ok: false, ...this.workerFailure } : { ok: true, headSha: input.reportedHeadSha };
    }
    async prepareWorkerResult(input) {
        return { descriptorPath: join(input.rootPath, "descriptor.json") };
    }
    async prepareReviewer(input) {
        this.reviewerValidationArgv.push([...input.validationArgv]);
        this.reviewerDockerHosts.push(input.dockerHost);
        return {
            reviewPath: join(input.rootPath, "source"),
            descriptorPath: join(input.rootPath, "descriptor.json"),
            evidencePath: join(input.rootPath, "review-evidence.txt"),
        };
    }
    async verifyReviewer() {
        return this.reviewerFailure
            ? { ok: false, class: "integrity_violation", kind: "worktree_dirty", reason: this.reviewerFailure }
            : { ok: true };
    }
}
export class FakeHerdr {
    outcomes;
    prepared = [];
    started = [];
    prompts = [];
    closed = [];
    promptFailureAfterDispatch = null;
    waitFailure = null;
    settleWithoutResult = null;
    lateResultAttemptId = null;
    settledWithoutResultAttempt = null;
    constructor(outcomes) {
        this.outcomes = outcomes;
    }
    async createWorktree(input) {
        return { workspaceId: "ws-1", path: input.path, branch: input.branch };
    }
    async createAttemptPane(input) {
        const handle = {
            agentName: `agent-${input.attempt.id}`,
            paneId: `pane-${input.attempt.id}`,
            tabId: `tab-${input.attempt.id}`,
            workspaceId: input.worktree.workspaceId,
        };
        this.prepared.push({ attemptId: input.attempt.id, lane: input.attempt.lane, cwd: input.cwd ?? input.worktree.path, env: input.env ?? {}, handle });
        return handle;
    }
    async startAgent(input) {
        this.started.push(input.handle.agentName);
    }
    async prompt(input) {
        this.prompts.push({ dispatchId: input.dispatchId, skill: input.skill, text: input.text });
        const failure = this.promptFailureAfterDispatch;
        this.promptFailureAfterDispatch = null;
        if (failure)
            throw failure;
    }
    async wait(input) {
        if (this.settleWithoutResult) {
            const settled = this.settleWithoutResult;
            this.settleWithoutResult = null;
            this.settledWithoutResultAttempt = { id: input.expectedAttemptId, ...settled };
            return { ...settled, result: null };
        }
        if (this.settledWithoutResultAttempt?.id === input.expectedAttemptId) {
            if (this.lateResultAttemptId !== input.expectedAttemptId) {
                return {
                    agentStatus: this.settledWithoutResultAttempt.agentStatus,
                    diagnostic: this.settledWithoutResultAttempt.diagnostic,
                    result: null,
                };
            }
            this.settledWithoutResultAttempt = null;
            this.lateResultAttemptId = null;
        }
        const failure = this.waitFailure;
        this.waitFailure = null;
        if (failure)
            throw failure;
        const outcome = this.outcomes.shift();
        if (!outcome)
            throw new Error("no fake outcome queued");
        if (outcome.lane !== input.expectedLane)
            throw new Error(`expected ${input.expectedLane}, got ${outcome.lane}`);
        if (outcome.lane === "worker") {
            const result = {
                version: 1,
                jobId: input.expectedJobId,
                attemptId: input.expectedAttemptId,
                lane: "worker",
                status: outcome.status,
                summary: outcome.summary ?? outcome.status,
                headSha: outcome.status === "completed" ? (outcome.headSha ?? "b".repeat(40)) : null,
                failedCommands: [],
            };
            return { agentStatus: outcome.agentStatus ?? (outcome.status === "blocked" ? "blocked" : "done"), result, diagnostic: null };
        }
        const job = currentJobId(input.expectedJobId);
        const result = {
            version: 1,
            jobId: job,
            attemptId: input.expectedAttemptId,
            lane: "reviewer",
            status: outcome.status,
            summary: outcome.summary ?? outcome.status,
            reviewedHeadSha: outcome.reviewedHeadSha
                ?? (outcome.status === "pass" || outcome.status === "changes" ? "b".repeat(40) : null),
            findings: outcome.findings ?? [],
        };
        return { agentStatus: outcome.agentStatus ?? (outcome.status === "blocked" ? "blocked" : "done"), result, diagnostic: null };
    }
    async close(handle) {
        this.closed.push(handle.agentName);
    }
}
export class FakeAnalyst {
    starts = [];
    closes = [];
    closeFailure = null;
    turns;
    constructor(turns = [{
            kind: "advice",
            action: "hold",
            summary: "hold",
            resolutionBrief: "",
            evidenceRefs: ["task"],
            unknowns: [],
        }]) {
        this.turns = [...turns];
    }
    async start(input) {
        this.starts.push({ jobId: input.jobId, taskDigest: input.task.digest });
        return {
            id: `analyst-${input.jobId}`,
            agentName: `codex-${input.jobId}`,
            startedAt: "2026-08-03T00:00:00.000Z",
            taskDigest: input.task.digest,
        };
    }
    async turn() {
        const turn = this.turns.shift();
        if (!turn)
            throw new Error("no analyst turn queued");
        return turn;
    }
    async close(input) {
        this.closes.push({ jobId: input.jobId, sessionId: input.session?.id ?? null, taskDigest: input.taskDigest });
        if (this.closeFailure)
            throw this.closeFailure;
    }
}
export class FakeEvidence {
    async initial(job) {
        const result = {
            items: [
                {
                    ref: "task",
                    source: "task",
                    summary: job.task.objective,
                    digest: digest(job.task.objective),
                    trust: "untrusted",
                },
            ],
            missing: ["git_diff"],
        };
        if (job.ciFailure) {
            const summary = JSON.stringify(job.ciFailure);
            result.items.push({
                ref: "ci-checks",
                source: "github.required-checks",
                summary,
                digest: digest(summary),
                trust: "untrusted",
            });
        }
        return result;
    }
    async collect(_job, requests) {
        return requests.map((request, index) => ({
            ref: `${request.kind}-${index}`,
            source: request.kind,
            summary: request.reason,
            digest: digest(request),
            trust: "untrusted",
        }));
    }
}
export function issue(input) {
    return {
        number: input.number,
        title: input.title,
        body: input.body ?? `Implement ${input.title}`,
        state: input.state ?? "OPEN",
        labels: input.labels ?? ["ready-for-agent"],
        assignees: input.assignees ?? [],
        blockedBy: input.blockedBy ?? [],
        parentNumber: input.parentNumber ?? null,
        subIssues: input.subIssues ?? [],
        updatedAt: input.updatedAt ?? "2026-08-03T00:00:00Z",
    };
}
function clone(value) {
    return JSON.parse(JSON.stringify(value));
}
function currentJobId(value) {
    return value;
}
//# sourceMappingURL=fakes.js.map