import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isWorkerControlledCompactionPolicy } from "./compatibility.js";
import { digest, type Attempt, type AttemptRuntimeAdapter, type ExecutionContext, type ExecutionResource, type ExecutionSnapshot } from "./model.js";

export function buildExecutionSnapshot(input: {
  adapter: AttemptRuntimeAdapter;
  executable: string;
  runtimeVersion: string;
  argv: string[];
  retryMode?: ExecutionSnapshot["retryMode"];
  compactionMode?: ExecutionSnapshot["compactionMode"];
  compactionPolicy?: ExecutionSnapshot["compactionPolicy"];
  credentialMode?: ExecutionSnapshot["credentialMode"];
  runtimeTimeouts?: ExecutionSnapshot["runtimeTimeouts"];
  runtimeDeadlineAt?: string;
  validationTimeoutMs?: number;
  dockerHost?: string | null;
  context?: ExecutionContext;
  extraResources?: Array<{ kind: "agent" | "runtime" | "model-config"; path: string }>;
}): ExecutionSnapshot {
  const compactionMode = input.compactionMode ?? "runtime-default";
  if (compactionMode === "controlled-threshold"
    ? !isWorkerControlledCompactionPolicy(input.compactionPolicy)
    : input.compactionPolicy !== undefined) {
    throw new Error("controlled compaction mode requires the exact qualified policy");
  }
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
    compactionMode,
    ...(input.compactionPolicy ? { compactionPolicy: { ...input.compactionPolicy } } : {}),
    credentialMode: input.credentialMode ?? (input.adapter === "pi-rpc" ? "canonical-oauth" : "runtime-default"),
    ...(input.runtimeTimeouts ? { runtimeTimeouts: { ...input.runtimeTimeouts } } : {}),
    ...(input.runtimeDeadlineAt !== undefined ? { runtimeDeadlineAt: input.runtimeDeadlineAt } : {}),
    ...(input.validationTimeoutMs !== undefined ? { validationTimeoutMs: input.validationTimeoutMs } : {}),
    dockerHost: input.dockerHost ?? null,
    resources: [
      ...flagValues(input.argv, "--skill").map((path) => executionResource("skill", path)),
      ...flagValues(input.argv, "--extension").map((path) => executionResource("extension", path)),
      ...(input.extraResources ?? []).map(({ kind, path }) => executionResource(kind, path)),
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
    reviewerCheckpointInputs: attempt.reviewerCheckpointInputs,
    contextEnvelope: attempt.contextEnvelope,
    contextEnvelopeDigest: attempt.contextEnvelopeDigest,
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

export function executionResource(kind: ExecutionResource["kind"], path: string): ExecutionResource {
  if (kind === "model-config") {
    if (!isAbsolute(path)) throw new Error("models.json path must be absolute");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
      throw new Error("models.json must be a private regular single-link file");
    }
  }
  const realPath = realpathSync(path);
  const digestRoot = kind === "extension" && lstatSync(realPath).isFile()
    ? extensionDigestRoot(realPath)
    : kind === "runtime" && lstatSync(realPath).isFile()
      ? dirname(realPath)
      : realPath;
  return { kind, path: realPath, digest: executionResourceDigest(digestRoot) };
}

function extensionDigestRoot(path: string): string {
  const fallback = dirname(path);
  let directory = fallback;
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        pi?: { extensions?: unknown };
      };
      if (Array.isArray(manifest.pi?.extensions) && manifest.pi.extensions.some((entry) => (
        typeof entry === "string" && resolve(directory, entry) === path
      ))) return directory;
    } catch {
      // Keep looking for the declaring Pi package.
    }
    const parent = dirname(directory);
    if (parent === directory) return fallback;
    directory = parent;
  }
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
