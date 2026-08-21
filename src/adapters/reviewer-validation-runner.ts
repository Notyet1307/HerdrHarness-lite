import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { digest, type ReviewerValidationOutput } from "../model.js";
import { REVIEWER_VALIDATION_OUTPUT_REDACTED } from "../reviewer-validation.js";

export type ReviewerValidationProcessInput = {
  validationPath: string;
  scratchPath: string;
  validationArgv: string[];
  dockerHost: string | null;
  timeoutMs: number;
};

export type ReviewerValidationProcessOutput = {
  exitCode: number | null;
  signal: string | null;
  timeout: boolean;
  error: string | null;
  stdout: ReviewerValidationOutput;
  stderr: ReviewerValidationOutput;
  relevantEnvironmentDigest: string;
};

export async function runReviewerValidationProcess(
  input: ReviewerValidationProcessInput,
): Promise<ReviewerValidationProcessOutput> {
  const environment = reviewerValidationEnvironment(input);
  const environmentDigest = digest(environment.env);
  try {
    if (environment.error) throw new Error(environment.error);
    for (const command of validationExecutables(input.validationArgv)) {
      resolveExecutable(command, input.validationPath, environment.env.PATH ?? "");
    }
    proveWritable(input.validationPath);
    verifyDocker(input.validationPath, environment.env, input.dockerHost);
  } catch (error) {
    const [stdout, stderr] = emptyCaptures();
    return {
      exitCode: null,
      signal: null,
      timeout: false,
      error: boundedError(error),
      stdout,
      stderr,
      relevantEnvironmentDigest: environmentDigest,
    };
  }

  const [command, ...args] = input.validationArgv;
  const stdout = openOutputCapture();
  const stderr = openOutputCapture();
  let child;
  try {
    child = spawn(command!, args, {
      cwd: input.validationPath,
      env: environment.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      timeout: false,
      error: boundedError(error),
      stdout: stdout.finish(),
      stderr: stderr.finish(),
      relevantEnvironmentDigest: environmentDigest,
    };
  }

  return await new Promise((resolveRun) => {
    let runtimeError: Error | null = null;
    let captureFailed = false;
    let timedOut = false;
    let interruptedBy: "SIGTERM" | "SIGINT" | null = null;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    const stop = (signal: "SIGTERM" | "SIGINT"): void => {
      interruptedBy = signal;
      child.kill("SIGTERM");
      forceTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    const onSigterm = (): void => stop("SIGTERM");
    const onSigint = (): void => stop("SIGINT");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, input.timeoutMs);
    const capture = (target: ReturnType<typeof openOutputCapture>, chunk: Uint8Array): void => {
      if (captureFailed) return;
      try {
        target.write(chunk);
      } catch {
        captureFailed = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk: Uint8Array) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Uint8Array) => capture(stderr, chunk));
    child.stdout.on("error", () => { captureFailed = true; child.kill("SIGKILL"); });
    child.stderr.on("error", () => { captureFailed = true; child.kill("SIGKILL"); });
    child.on("error", (error) => { runtimeError = error; });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
      let stdoutResult: ReviewerValidationOutput;
      let stderrResult: ReviewerValidationOutput;
      try {
        stdoutResult = stdout.finish();
        stderrResult = stderr.finish();
      } catch (error) {
        resolveRun({
          exitCode,
          signal,
          timeout: timedOut,
          error: `Attempt-private validation evidence capture failed: ${boundedError(error)}`,
          stdout: emptyOutput(),
          stderr: emptyOutput(),
          relevantEnvironmentDigest: environmentDigest,
        });
        return;
      }
      const error = captureFailed
        ? "Attempt-private validation evidence capture failed"
        : timedOut
          ? "Reviewer validation timed out"
          : interruptedBy
            ? `Reviewer validation interrupted by ${interruptedBy}`
            : runtimeError
              ? boundedError(runtimeError)
              : null;
      resolveRun({
        exitCode,
        signal,
        timeout: timedOut,
        error,
        stdout: stdoutResult,
        stderr: stderrResult,
        relevantEnvironmentDigest: environmentDigest,
      });
    });
  });
}

function reviewerValidationEnvironment(input: ReviewerValidationProcessInput): {
  env: Record<string, string>;
  error: string | null;
} {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: join(input.scratchPath, "home"),
    TMPDIR: join(input.scratchPath, "tmp"),
    TMP: join(input.scratchPath, "tmp"),
    TEMP: join(input.scratchPath, "tmp"),
    XDG_CACHE_HOME: join(input.scratchPath, "cache"),
    PYTHONPYCACHEPREFIX: join(input.scratchPath, "pycache"),
  };
  if (input.dockerHost) env.DOCKER_HOST = input.dockerHost;
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE"] as const) {
    if (process.env[name]) env[name] = process.env[name]!;
  }
  const wrapped = envAssignments(input.validationArgv);
  const configuredHost = wrapped.get("DOCKER_HOST");
  if (configuredHost && configuredHost !== input.dockerHost) {
    return { env, error: "Reviewer validation argv attempts to override the bound Docker host" };
  }
  const dockerConfig = wrapped.get("DOCKER_CONFIG");
  if (dockerConfig) {
    if (!isAbsolute(dockerConfig) || /[\0\r\n]/.test(dockerConfig)) {
      return { env, error: "Reviewer validation DOCKER_CONFIG must be an absolute safe path" };
    }
    env.DOCKER_CONFIG = dockerConfig;
  }
  return { env, error: null };
}

function verifyDocker(cwd: string, env: Record<string, string>, dockerHost: string | null): void {
  if (!dockerHost) return;
  for (const [args, label] of [
    [["version", "--format", "{{.Server.Version}}"], "Docker daemon"],
    [["compose", "version", "--short"], "Docker Compose V2"],
  ] as const) {
    const output = spawnSync("docker", args, { cwd, env, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 15_000 });
    if (output.error || output.status !== 0 || !output.stdout.trim()) {
      throw new Error(`${label} is unavailable: ${processFailure(output)}`);
    }
  }
}

function envAssignments(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  if (basename(argv[0] ?? "") !== "env") return values;
  for (const argument of argv.slice(1)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([^\0\r\n]*)$/.exec(argument);
    if (!match) break;
    values.set(match[1]!, match[2]!);
  }
  return values;
}

function validationExecutables(argv: string[]): string[] {
  const commands = [argv[0]!];
  if (basename(argv[0] ?? "") !== "env") return commands;
  const target = argv.slice(1).find((argument) => !/^[A-Za-z_][A-Za-z0-9_]*=[^\0\r\n]*$/.test(argument));
  if (!target || target.startsWith("-")) throw new Error("Reviewer validation env wrapper has no supported command");
  commands.push(target);
  return commands;
}

function resolveExecutable(command: string, cwd: string, pathValue: string): string {
  const candidates = command.includes("/")
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : pathValue.split(delimiter).filter(Boolean).map((entry) => join(entry, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`Reviewer validation executable is unavailable: ${command}`);
}

function proveWritable(path: string): void {
  const probe = join(path, `.herdr-harness-preflight-${randomUUID()}`);
  let fd: number | null = null;
  try {
    fd = openSync(probe, "wx", 0o600);
    closeSync(fd);
    fd = null;
    unlinkSync(probe);
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(probe)) unlinkSync(probe);
  }
}

function openOutputCapture(): {
  write(value: Uint8Array): void;
  finish(): ReviewerValidationOutput;
} {
  const hash = createHash("sha256");
  let byteCount = 0;
  let closed = false;
  return {
    write(chunk) {
      hash.update(chunk);
      byteCount += chunk.length;
    },
    finish() {
      if (closed) throw new Error("Reviewer validation evidence was already finalized");
      closed = true;
      return {
        text: byteCount === 0 ? "" : REVIEWER_VALIDATION_OUTPUT_REDACTED,
        truncated: byteCount > 0,
        redacted: byteCount > 0,
        byteCount,
        sha256: hash.digest("hex"),
      };
    },
  };
}

function emptyCaptures(): [ReviewerValidationOutput, ReviewerValidationOutput] {
  return [openOutputCapture().finish(), openOutputCapture().finish()];
}

function emptyOutput(): ReviewerValidationOutput {
  return { text: "", truncated: false, redacted: false, byteCount: 0, sha256: createHash("sha256").digest("hex") };
}

function processFailure(output: { error?: Error; stderr?: string; stdout?: string; status: number | null }): string {
  return boundedError(output.error?.message ?? (output.stderr?.trim() || output.stdout?.trim() || `exit ${output.status}`));
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 4_000 ? message : `[truncated]\n${message.slice(-4_000)}`;
}
