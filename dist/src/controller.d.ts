import type { AnalystPort, Clock, EvidencePort, GitHubPort, GitPort, HarnessConfig, HerdrPort, IdGenerator, RuntimePreflightPort, StateStore } from "./ports.js";
export type TickAction = "idle" | "preflight_failed" | "selected" | "claimed" | "worktree_created" | "attempt_prepared" | "attempt_pane_ready" | "attempt_agent_ready" | "attempt_dispatched" | "attempt_reconciling" | "attempt_completed" | "analysis_recorded" | "waiting_for_approval" | "recovery_applied" | "ci_recovered" | "base_refreshed" | "published" | "publish_retry" | "waiting_for_merge" | "merged" | "archived" | "blocked";
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
    preflight: RuntimePreflightPort;
};
/**
 * One controller owns all writes. Each tick performs at most one durable state
 * transition, so restarts resume from the ledger instead of replaying a whole
 * orchestration script.
 */
export declare class HarnessController {
    private readonly deps;
    constructor(deps: Dependencies);
    tick(): Promise<TickResult>;
    private selectJob;
    private advanceClaim;
    private prepareAttempt;
    private driveAttempt;
    private finishObservedAttempt;
    private reconcileAttemptOrBlock;
    private runRuntimePreflight;
    private verifyReviewerIntegrity;
    private verifyReviewerPreflight;
    private finishWorker;
    private finishReviewer;
    private closeCompletedAttempt;
    private publish;
    private observeMerge;
    private refreshBaseForReview;
    private diagnoseOrWait;
    private reconcileLateAttemptResult;
    private reconcileBlockedCi;
    private runDiagnosis;
    private applyRecovery;
    private archive;
    private block;
    private saveJob;
}
export {};
