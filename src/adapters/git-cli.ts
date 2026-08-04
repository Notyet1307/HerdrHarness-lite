import type { GitPort, ReviewerVerification, WorkerVerification } from "../ports.js";
import { type CommandRunner, requireSuccess, SyncCommandRunner } from "./command.js";

export class GitCli implements GitPort {
  constructor(private readonly runner: CommandRunner = new SyncCommandRunner()) {}

  async refreshBase(localPath: string, baseRef: string): Promise<string> {
    requireSuccess(this.runner.run("git", ["-C", localPath, "fetch", "--prune", "origin", baseRef]), "git fetch base");
    const sha = requireSuccess(
      this.runner.run("git", ["-C", localPath, "rev-parse", `origin/${baseRef}^{commit}`]),
      "git resolve base",
    ).trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`invalid base SHA: ${sha}`);
    return sha;
  }

  async verifyWorker(input: {
    worktree: { path: string; branch: string; workspaceId: string };
    branch: string;
    baseSha: string;
    reportedHeadSha: string;
  }): Promise<WorkerVerification> {
    const path = input.worktree.path;
    const head = this.git(path, ["rev-parse", "HEAD"]).trim();
    if (head !== input.reportedHeadSha) {
      return { ok: false, class: "integrity_violation", reason: `worktree HEAD ${head} != worker result ${input.reportedHeadSha}` };
    }
    const branch = this.git(path, ["branch", "--show-current"]).trim();
    if (branch !== input.branch) {
      return { ok: false, class: "integrity_violation", reason: `branch ${branch || "detached"} != ${input.branch}` };
    }
    const ancestry = this.runner.run("git", ["-C", path, "merge-base", "--is-ancestor", input.baseSha, head]);
    if (!ancestry.ok) {
      return { ok: false, class: "integrity_violation", reason: `${input.baseSha} is not an ancestor of ${head}` };
    }
    const count = Number(this.git(path, ["rev-list", "--count", `${input.baseSha}..${head}`]).trim());
    if (!Number.isInteger(count) || count < 1) {
      return { ok: false, class: "integrity_violation", reason: "worker produced no commit after its attempt base" };
    }
    const dirty = this.git(path, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty.trim()) {
      return { ok: false, class: "integrity_violation", reason: `tracked worktree is dirty:\n${dirty.trim()}` };
    }
    const remote = this.runner.run("git", ["-C", path, "ls-remote", "--heads", "origin", input.branch]);
    if (!remote.ok) {
      return { ok: false, class: "stale_task", reason: "cannot prove whether the worker branch was pushed" };
    }
    if (remote.stdout.trim()) {
      return { ok: false, class: "integrity_violation", reason: "worker pushed the branch before review" };
    }
    return { ok: true, headSha: head };
  }

  async verifyReviewer(input: {
    worktree: { path: string; branch: string; workspaceId: string };
    expectedHeadSha: string;
    reportedHeadSha: string;
  }): Promise<ReviewerVerification> {
    const head = this.git(input.worktree.path, ["rev-parse", "HEAD"]).trim();
    if (head !== input.expectedHeadSha || input.reportedHeadSha !== input.expectedHeadSha) {
      return {
        ok: false,
        class: "integrity_violation",
        reason: `review is not bound to the current HEAD ${input.expectedHeadSha}`,
      };
    }
    const dirty = this.git(input.worktree.path, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty.trim()) {
      return { ok: false, class: "integrity_violation", reason: `reviewer modified tracked files:\n${dirty.trim()}` };
    }
    return { ok: true };
  }

  private git(path: string, args: string[]): string {
    return requireSuccess(this.runner.run("git", ["-C", path, ...args]), `git ${args[0] ?? "command"}`);
  }
}
