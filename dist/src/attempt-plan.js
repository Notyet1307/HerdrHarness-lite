import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { digest } from "./model.js";
export function buildExecutionSnapshot(input) {
    return {
        version: 1,
        adapter: input.adapter,
        executable: input.executable,
        runtimeVersion: input.runtimeVersion,
        argv: [...input.argv],
        provider: oneFlag(input.argv, "--provider"),
        model: oneFlag(input.argv, "--model"),
        thinking: requiredFlag(input.argv, "--thinking"),
        tools: requiredFlag(input.argv, "--tools").split(",").map((tool) => tool.trim()),
        sessionMode: input.argv.includes("--no-session") ? "ephemeral" : "fresh-persistent",
        retryMode: input.retryMode ?? "runtime-default",
        compactionMode: input.compactionMode ?? "runtime-default",
        credentialMode: input.credentialMode ?? (input.adapter === "pi-rpc" ? "canonical-oauth" : "runtime-default"),
        dockerHost: input.dockerHost ?? null,
        resources: [
            ...flagValues(input.argv, "--skill").map((path) => executionResource("skill", path)),
            ...flagValues(input.argv, "--extension").map((path) => executionResource("extension", path)),
            ...(input.extraResources ?? []).map(({ kind, path }) => executionResource(kind, path)),
        ],
        ...(input.context ? { context: input.context } : {}),
    };
}
export function attemptPlanDigest(attempt) {
    return digest({
        id: attempt.id,
        lane: attempt.lane,
        round: attempt.round,
        baseSha: attempt.baseSha,
        expectedHeadSha: attempt.expectedHeadSha,
        expectedRemoteHeadSha: attempt.expectedRemoteHeadSha ?? null,
        resultPath: attempt.resultPath,
        reviewerValidationArgv: attempt.reviewerValidationArgv,
        promptDigest: attempt.promptDigest,
        executionSnapshot: attempt.executionSnapshot,
    });
}
export function executionPlanMatches(attempt) {
    return attempt.executionSnapshot !== undefined
        && attempt.planDigest !== undefined
        && attempt.planDigest === attemptPlanDigest(attempt);
}
function oneFlag(argv, flag) {
    const values = flagValues(argv, flag);
    if (values.length > 1)
        throw new Error(`${flag} must appear at most once`);
    return values[0] ?? null;
}
function requiredFlag(argv, flag) {
    const value = oneFlag(argv, flag);
    if (!value)
        throw new Error(`${flag} is required in the execution snapshot`);
    return value;
}
function flagValues(argv, flag) {
    return argv.flatMap((value, index) => value === flag && argv[index + 1] ? [argv[index + 1]] : []);
}
export function executionResource(kind, path) {
    if (kind === "model-config") {
        if (!isAbsolute(path))
            throw new Error("models.json path must be absolute");
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
            throw new Error("models.json must be a private regular single-link file");
        }
    }
    const realPath = realpathSync(path);
    const digestRoot = (kind === "extension" || kind === "runtime") && lstatSync(realPath).isFile() ? dirname(realPath) : realPath;
    return { kind, path: realPath, digest: executionResourceDigest(digestRoot) };
}
export function executionResourceDigest(path) {
    const hash = createHash("sha256");
    const visit = (current, relative) => {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink())
            throw new Error(`execution resource contains a symbolic link: ${current}`);
        if (stat.isDirectory()) {
            for (const name of readdirSync(current).sort())
                visit(join(current, name), join(relative, name));
            return;
        }
        if (!stat.isFile())
            throw new Error(`execution resource is not a file or directory: ${current}`);
        hash.update(relative);
        hash.update("\0");
        hash.update(readFileSync(current));
        hash.update("\0");
    };
    visit(path, ".");
    return hash.digest("hex");
}
//# sourceMappingURL=attempt-plan.js.map