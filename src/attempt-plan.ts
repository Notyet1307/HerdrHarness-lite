import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { digest, type Attempt, type AttemptRuntimeAdapter, type ExecutionContext, type ExecutionResource, type ExecutionSnapshot } from "./model.js";

export function buildExecutionSnapshot(input: {
  adapter: AttemptRuntimeAdapter;
  executable: string;
  runtimeVersion: string;
  argv: string[];
  retryMode?: ExecutionSnapshot["retryMode"];
  compactionMode?: ExecutionSnapshot["compactionMode"];
  dockerHost?: string | null;
  context?: ExecutionContext;
  extraResources?: Array<{ kind: "agent"; path: string }>;
}): ExecutionSnapshot {
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
    dockerHost: input.dockerHost ?? null,
    resources: [
      ...flagValues(input.argv, "--skill").map((path) => resource("skill", path)),
      ...flagValues(input.argv, "--extension").map((path) => resource("extension", path)),
      ...(input.extraResources ?? []).map(({ kind, path }) => resource(kind, path)),
    ],
    ...(input.context ? { context: input.context } : {}),
  };
}

export function attemptPlanDigest(attempt: Attempt): string {
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

export function executionPlanMatches(attempt: Attempt): boolean {
  return attempt.executionSnapshot !== undefined
    && attempt.planDigest !== undefined
    && attempt.planDigest === attemptPlanDigest(attempt);
}

function oneFlag(argv: string[], flag: string): string | null {
  const values = flagValues(argv, flag);
  if (values.length > 1) throw new Error(`${flag} must appear at most once`);
  return values[0] ?? null;
}

function requiredFlag(argv: string[], flag: string): string {
  const value = oneFlag(argv, flag);
  if (!value) throw new Error(`${flag} is required in the execution snapshot`);
  return value;
}

function flagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((value, index) => value === flag && argv[index + 1] ? [argv[index + 1]!] : []);
}

function resource(kind: ExecutionResource["kind"], path: string): ExecutionResource {
  const realPath = realpathSync(path);
  const digestRoot = kind === "extension" && lstatSync(realPath).isFile() ? dirname(realPath) : realPath;
  return { kind, path: realPath, digest: executionResourceDigest(digestRoot) };
}

export function executionResourceDigest(path: string): string {
  const hash = createHash("sha256");
  const visit = (current: string, relative: string): void => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`execution resource contains a symbolic link: ${current}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(current).sort()) visit(join(current, name), join(relative, name));
      return;
    }
    if (!stat.isFile()) throw new Error(`execution resource is not a file or directory: ${current}`);
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(current));
    hash.update("\0");
  };
  visit(path, ".");
  return hash.digest("hex");
}
