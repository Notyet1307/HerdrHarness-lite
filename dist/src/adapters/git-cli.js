import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathsOverlap } from "../path-safety.js";
import { requireSuccess, SyncCommandRunner } from "./command.js";
export class GitCli {
    runner;
    constructor(runner = new SyncCommandRunner()) {
        this.runner = runner;
    }
    async refreshBase(localPath, baseRef) {
        requireSuccess(this.runner.run("git", ["-C", localPath, "fetch", "--prune", "origin", baseRef]), "git fetch base");
        const sha = requireSuccess(this.runner.run("git", ["-C", localPath, "rev-parse", `origin/${baseRef}^{commit}`]), "git resolve base").trim();
        if (!/^[0-9a-f]{40}$/i.test(sha))
            throw new Error(`invalid base SHA: ${sha}`);
        return sha;
    }
    async verifyWorker(input) {
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
        const remoteHead = remote.stdout.trim().split(/\s+/, 1)[0] || null;
        if (input.expectedRemoteHeadSha === null && remoteHead) {
            return { ok: false, class: "integrity_violation", reason: "worker pushed the branch before review" };
        }
        if (input.expectedRemoteHeadSha !== null && remoteHead !== input.expectedRemoteHeadSha) {
            return {
                ok: false,
                class: remoteHead ? "integrity_violation" : "stale_task",
                reason: `remote branch ${remoteHead ?? "is missing"} differs from reviewed anchor ${input.expectedRemoteHeadSha}`,
            };
        }
        return { ok: true, headSha: head };
    }
    async prepareReviewer(input) {
        const rootPath = resolve(input.rootPath);
        if (pathsOverlap(input.worktree.path, rootPath))
            throw new Error("Reviewer state must be outside the product worktree");
        if (resolve(input.resultPath) !== join(rootPath, "result.json"))
            throw new Error("Reviewer result path escaped its attempt root");
        const reviewPath = join(rootPath, "source");
        const validationPath = join(rootPath, "validation");
        const scratchPath = join(rootPath, "scratch");
        const descriptorPath = join(rootPath, "descriptor.json");
        const evidencePath = join(rootPath, "review-evidence.txt");
        const descriptor = {
            version: 1,
            jobId: input.jobId,
            attemptId: input.attemptId,
            reviewedHeadSha: input.expectedHeadSha,
            validationArgv: input.validationArgv,
            validationPath,
            scratchPath,
            resultPath: resolve(input.resultPath),
        };
        if (existsSync(descriptorPath)) {
            const existing = JSON.parse(readFileSync(descriptorPath, "utf8"));
            if (JSON.stringify(existing) !== JSON.stringify(descriptor))
                throw new Error("Reviewer descriptor identity changed after preparation");
            for (const path of [reviewPath, validationPath, scratchPath, evidencePath]) {
                if (!existsSync(path))
                    throw new Error(`Reviewer workspace is incomplete: ${path}`);
            }
            return { reviewPath, descriptorPath, evidencePath };
        }
        const head = this.git(input.worktree.path, ["rev-parse", "HEAD"]).trim();
        if (head !== input.expectedHeadSha)
            throw new Error(`Reviewer source HEAD ${head} != ${input.expectedHeadSha}`);
        const ancestry = this.runner.run("git", ["-C", input.worktree.path, "merge-base", "--is-ancestor", input.baseSha, head]);
        if (!ancestry.ok)
            throw new Error(`Reviewer base ${input.baseSha} is not an ancestor of ${head}`);
        const dirty = this.git(input.worktree.path, ["status", "--porcelain", "--untracked-files=no"]);
        if (dirty.trim())
            throw new Error(`Reviewer source has tracked changes:\n${dirty.trim()}`);
        const diff = this.git(input.worktree.path, ["diff", "--no-ext-diff", "--find-renames", `${input.baseSha}...${head}`]);
        if (!diff.trim())
            throw new Error("Reviewer fixed-point diff is empty");
        const commits = this.git(input.worktree.path, ["log", "--oneline", `${input.baseSha}..${head}`]);
        if (existsSync(rootPath))
            makeWritable(rootPath);
        rmSync(rootPath, { recursive: true, force: true });
        mkdirSync(reviewPath, { recursive: true, mode: 0o700 });
        chmodSync(rootPath, 0o700);
        requireSuccess(this.runner.run("git", ["-C", input.worktree.path, "checkout-index", "--all", "--force", `--prefix=${reviewPath}${sep}`]), "git export Reviewer source");
        cpSync(reviewPath, validationPath, { recursive: true });
        for (const path of [join(scratchPath, "home"), join(scratchPath, "tmp"), join(scratchPath, "cache"), join(scratchPath, "pycache")]) {
            mkdirSync(path, { recursive: true });
        }
        writeFileSync(evidencePath, [
            `Base SHA: ${input.baseSha}`,
            `Head SHA: ${head}`,
            "Ancestry: verified",
            "Tracked source state: clean",
            "",
            "Commits:",
            commits.trim(),
            "",
            "Diff:",
            diff,
        ].join("\n"), { mode: 0o400 });
        makeReadOnly(reviewPath);
        writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: "wx", mode: 0o400 });
        return { reviewPath, descriptorPath, evidencePath };
    }
    async verifyReviewer(input) {
        const head = this.git(input.worktree.path, ["rev-parse", "HEAD"]).trim();
        if (head !== input.expectedHeadSha || (input.reportedHeadSha !== null && input.reportedHeadSha !== input.expectedHeadSha)) {
            return {
                ok: false,
                class: "integrity_violation",
                reason: `review is not bound to the current HEAD ${input.expectedHeadSha}`,
            };
        }
        const status = this.git(input.worktree.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
        const allowed = new Set(input.allowedResultPaths.map((path) => relative(input.worktree.path, path).replace(/\\/g, "/")));
        const unexpected = status.split(/\r?\n/).filter((line) => (line && (!line.startsWith("?? ") || !allowed.has(line.slice(3)))));
        if (unexpected.length > 0) {
            return {
                ok: false,
                class: "integrity_violation",
                reason: `reviewer modified the worktree outside Harness result files:\n${unexpected.join("\n")}`,
            };
        }
        return { ok: true };
    }
    git(path, args) {
        return requireSuccess(this.runner.run("git", ["-C", path, ...args]), `git ${args[0] ?? "command"}`);
    }
}
function makeReadOnly(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
        return;
    if (stat.isDirectory()) {
        for (const entry of readdirSync(path))
            makeReadOnly(join(path, entry));
    }
    chmodSync(path, stat.mode & ~0o222);
}
function makeWritable(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
        return;
    chmodSync(path, stat.mode | 0o200);
    if (stat.isDirectory()) {
        for (const entry of readdirSync(path))
            makeWritable(join(path, entry));
    }
}
//# sourceMappingURL=git-cli.js.map