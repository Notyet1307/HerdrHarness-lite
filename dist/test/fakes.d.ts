import { type AnalystSession, type AnalystTurn, type AttemptResult, type EvidenceItem, type EvidenceRequest, type HarnessState, type IssueSnapshot, type Job, type PullRequestCheck, type PullRequestObservation, type PullRequestRef, type SelectedTask } from "../src/model.js";
import type { AnalystPort, Clock, EvidencePort, GitHubPort, GitPort, HerdrPort, IdGenerator, StateStore } from "../src/ports.js";
export declare const validCodeReviewSkillPath: string;
export declare const validPiSubagentsExtensionPath: string;
export declare const validReviewerToolsExtensionPath: string;
export declare const validImplementSkillPath: string;
export declare const validTddSkillPath: string;
export declare const substituteCodeReviewSkillPath: string;
export declare const untrustedImplementSkillPath: string;
export declare const validWorkerArgv: string[];
export declare const validReviewerArgv: string[];
export declare class FakeClock implements Clock {
    private tick;
    now(): string;
}
export declare class SequenceIds implements IdGenerator {
    private count;
    next(prefix: string): string;
}
export declare class MemoryStore implements StateStore {
    state: HarnessState;
    saves: HarnessState[];
    load(): Promise<HarnessState>;
    save(next: HarnessState, expectedActiveRevision: number | null): Promise<void>;
}
export declare class FakeGitHub implements GitHubPort {
    graph: IssueSnapshot[];
    claims: Array<{
        issue: number;
        jobId: string;
    }>;
    published: PullRequestRef[];
    suspended: number[];
    mergeStatus: "open" | "merged" | "closed_unmerged";
    autoMergeEnabled: boolean;
    requiredChecks: PullRequestCheck[];
    suspendFailure: Error | null;
    constructor(graph: IssueSnapshot[]);
    listIssueGraph(_repo: string, _readyLabel: string): Promise<IssueSnapshot[]>;
    getIssue(_repo: string, issueNumber: number): Promise<IssueSnapshot>;
    claimIssue(input: {
        repo: string;
        task: SelectedTask;
        jobId: string;
        claimLabel: string;
        readyLabel: string;
    }): Promise<void>;
    publish(input: {
        repo: string;
        issueNumber: number;
        branch: string;
        baseRef: string;
        headSha: string;
        title: string;
        worktreePath: string;
    }): Promise<PullRequestRef>;
    observePullRequest(_repo: string, _pullRequest: PullRequestRef): Promise<PullRequestObservation>;
    suspendAutoMerge(_repo: string, pullRequest: PullRequestRef): Promise<void>;
}
export declare class FakeGit implements GitPort {
    baseSha: string;
    workerFailure: {
        class: "integrity_violation" | "stale_task";
        reason: string;
    } | null;
    reviewerFailure: string | null;
    reviewerValidationArgv: string[][];
    workerVerifications: Array<{
        reportedHeadSha: string;
        expectedRemoteHeadSha: string | null;
    }>;
    refreshBase(): Promise<string>;
    verifyWorker(input: {
        reportedHeadSha: string;
        expectedRemoteHeadSha: string | null;
    }): Promise<{
        ok: true;
        headSha: string;
    } | {
        ok: false;
        class: "integrity_violation" | "stale_task";
        reason: string;
    }>;
    prepareReviewer(input: {
        rootPath: string;
        validationArgv: string[];
    }): Promise<{
        reviewPath: string;
        descriptorPath: string;
        evidencePath: string;
    }>;
    verifyReviewer(): Promise<{
        ok: true;
    } | {
        ok: false;
        class: "integrity_violation";
        reason: string;
    }>;
}
type Outcome = ({
    lane: "worker";
    status: "completed" | "blocked" | "failed";
    summary?: string;
    headSha?: string;
} | {
    lane: "reviewer";
    status: "pass" | "changes" | "blocked" | "failed";
    summary?: string;
    reviewedHeadSha?: string;
    findings?: Array<{
        severity: "critical" | "major" | "minor";
        summary: string;
        evidence: string;
    }>;
}) & {
    agentStatus?: "idle" | "done" | "blocked" | "unknown";
};
export declare class FakeHerdr implements HerdrPort {
    private readonly outcomes;
    prepared: Array<{
        attemptId: string;
        lane: string;
        cwd: string;
        env: Record<string, string>;
        handle: {
            agentName: string;
            paneId: string;
            tabId: string;
            workspaceId: string;
        };
    }>;
    started: string[];
    prompts: Array<{
        dispatchId: string;
        skill: "implement" | "code-review";
        text: string;
    }>;
    closed: string[];
    promptFailureAfterDispatch: Error | null;
    waitFailure: Error | null;
    settleWithoutResult: {
        agentStatus: "idle" | "done" | "blocked" | "unknown";
        diagnostic: string | null;
    } | null;
    constructor(outcomes: Outcome[]);
    createWorktree(input: {
        branch: string;
        path: string;
    }): Promise<{
        workspaceId: string;
        path: string;
        branch: string;
    }>;
    createAttemptPane(input: {
        worktree: {
            workspaceId: string;
            path: string;
        };
        attempt: {
            id: string;
            lane: "worker" | "reviewer";
        };
        cwd?: string;
        env?: Record<string, string>;
    }): Promise<{
        agentName: string;
        paneId: string;
        tabId: string;
        workspaceId: string;
    }>;
    startAgent(input: {
        handle: {
            agentName: string;
        };
    }): Promise<void>;
    prompt(input: {
        dispatchId: string;
        skill: "implement" | "code-review";
        text: string;
    }): Promise<void>;
    wait(input: {
        expectedJobId: string;
        expectedAttemptId: string;
        expectedLane: "worker" | "reviewer";
    }): Promise<{
        agentStatus: "idle" | "done" | "blocked" | "unknown";
        result: AttemptResult | null;
        diagnostic: string | null;
    }>;
    close(handle: {
        agentName: string;
    }): Promise<void>;
}
export declare class FakeAnalyst implements AnalystPort {
    starts: Array<{
        jobId: string;
        taskDigest: string;
    }>;
    closes: Array<{
        jobId: string;
        sessionId: string | null;
        taskDigest: string;
    }>;
    closeFailure: Error | null;
    turns: AnalystTurn[];
    constructor(turns?: AnalystTurn[]);
    start(input: {
        jobId: string;
        task: {
            digest: string;
        };
    }): Promise<AnalystSession>;
    turn(): Promise<AnalystTurn>;
    close(input: {
        jobId: string;
        session: AnalystSession | null;
        taskDigest: string;
    }): Promise<void>;
}
export declare class FakeEvidence implements EvidencePort {
    initial(job: Job): Promise<{
        items: EvidenceItem[];
        missing: string[];
    }>;
    collect(_job: Job, requests: EvidenceRequest[]): Promise<EvidenceItem[]>;
}
export declare function issue(input: Partial<IssueSnapshot> & Pick<IssueSnapshot, "number" | "title">): IssueSnapshot;
export {};
