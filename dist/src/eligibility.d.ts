import type { IssueSnapshot, SelectedTask } from "./model.js";
export type SkipReason = "not_open" | "missing_ready_label" | "assigned" | "blocked" | "already_claimed" | "map_container" | "map_waiting" | "nested_map" | "ambiguous_parent" | "missing_child_snapshot";
export type SelectionDiagnostic = {
    issueNumber: number;
    reason: SkipReason;
    detail: string;
};
export type SelectionResult = {
    selected: SelectedTask | null;
    eligible: SelectedTask[];
    diagnostics: SelectionDiagnostic[];
};
export type EligibilityOptions = {
    readyLabel: string;
    claimedIssueNumbers?: ReadonlySet<number>;
};
/**
 * Pure GitHub issue-graph selection.
 *
 * Map semantics are intentionally strict: a Map is never claimed, and only its
 * first OPEN child is the frontier. If that child is not executable, later
 * children are not allowed to jump the queue.
 */
export declare function selectNextTask(snapshots: readonly IssueSnapshot[], options: EligibilityOptions): SelectionResult;
export declare function isStillClaimable(issue: IssueSnapshot, readyLabel: string): boolean;
