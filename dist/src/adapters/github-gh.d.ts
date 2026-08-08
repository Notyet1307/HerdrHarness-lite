import type { IssueSnapshot, PullRequestObservation, PullRequestRef, SelectedTask } from "../model.js";
import type { GitHubPort } from "../ports.js";
import { type CommandRunner } from "./command.js";
/** GitHub adapter built only on `gh` and `git`; mutations are idempotent. */
export declare class GitHubGh implements GitHubPort {
    private readonly runner;
    private readonly autoMerge;
    constructor(runner?: CommandRunner, autoMerge?: boolean);
    listIssueGraph(repo: string, readyLabel: string): Promise<IssueSnapshot[]>;
    getIssue(repo: string, issueNumber: number): Promise<IssueSnapshot>;
    claimIssue(input: {
        repo: string;
        task: SelectedTask;
        jobId: string;
        claimLabel: string;
        readyLabel: string;
    }): Promise<void>;
    requeueIssue(input: {
        repo: string;
        issueNumber: number;
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
    observePullRequest(repo: string, pullRequest: PullRequestRef): Promise<PullRequestObservation>;
    suspendAutoMerge(repo: string, pullRequest: PullRequestRef): Promise<void>;
    private readRequiredChecks;
    private readFailedLog;
    private disableAutoMerge;
}
