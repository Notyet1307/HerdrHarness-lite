import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { GitCli } from "./adapters/git-cli.js";
import { HerdrCli } from "./adapters/herdr-cli.js";
import { JsonStateStore } from "./adapters/json-store.js";
import { PiRpcRuntime } from "./adapters/pi-rpc-runtime.js";
import { RuntimePreflightCli } from "./adapters/runtime-preflight.js";
import { SyncCommandRunner, requireSuccess } from "./adapters/command.js";
import {
  canaryFailureFromDiagnostic,
  type CanaryExecutor,
  type CanaryFailure,
  type CanaryUnit,
  type CanaryUnitResult,
} from "./canary.js";
import { prepareAttempt } from "./controller/attempt-preparation.js";
import { driveAttempt } from "./controller/attempt-driver.js";
import { validateHarnessConfig } from "./controller/config-validation.js";
import { ControllerContext } from "./controller/context.js";
import {
  classifyPiRpcRunnerFailure,
  makeSafeRuntimeDiagnostic,
  safePiRpcDiagnosticFromError,
  type SafeRuntimeDiagnostic,
} from "./pi-rpc-diagnostics.js";
import { pathsOverlap } from "./path-safety.js";
import { readJsonIfExists, rpcRuntimeRoot, writeAtomicJson, writeExclusiveJson } from "./pi-rpc-spool.js";
import {
  digest,
  taskFromSelection,
  type Attempt,
  type HarnessState,
  type Job,
  type WorktreeHandle,
} from "./model.js";
import type {
  AnalystPort,
  AttemptRuntimePort,
  EvidencePort,
  GitPort,
  GitHubPort,
  HarnessConfig,
  HerdrPort,
  IdGenerator,
  RuntimePreflightPort,
} from "./ports.js";
import { reviewerValidationResult } from "./reviewer-validation.js";
import { safeCompactionReceipt } from "./adapters/local-evidence.js";

export type CanaryFileConfig = {
  version: 1;
  stateDir: string;
  harnessConfig: string;
  herdrSession: string;
  repetitions: number;
  stressConcurrency?: number;
  oauthReviewerProfile: string;
  customReviewerProfile: string;
  validationLongMs?: number;
  validationOutputBytes?: number;
};

type HarnessTemplate = HarnessConfig & {
  herdr: { bin?: string; session: string };
};

export type ResolvedCanaryConfig = {
  file: CanaryFileConfig;
  path: string;
  stateDir: string;
  template: HarnessTemplate;
  configDigest: string;
  stressConcurrency: number;
  validationLongMs: number;
  validationOutputBytes: number;
  herdr: { bin?: string; session: string };
};

export type LiveCanaryDependencies = {
  runner?: SyncCommandRunner;
  herdr?: HerdrPort;
  git?: GitPort;
  preflight?: RuntimePreflightPort;
  piRpc?: AttemptRuntimePort;
};

type Fixture = {
  version: 1;
  baseSha: string;
  sourcePath: string;
};

type UnitSetup = {
  version: 1;
  unitId: string;
  generation: number;
  baseSha: string;
  headSha: string | null;
  branch: string;
  worktree: WorktreeHandle;
};

type UnitSetupState =
  | {
      version: 1;
      unitId: string;
      generation: number;
      phase: "reserved";
      baseSha: string;
      branch: string;
      worktreePath: string;
    }
  | (UnitSetup & { phase: "ready"; worktreePath: string });

const CANARY_CONFIG_KEYS = new Set([
  "version",
  "stateDir",
  "harnessConfig",
  "herdrSession",
  "repetitions",
  "stressConcurrency",
  "oauthReviewerProfile",
  "customReviewerProfile",
  "validationLongMs",
  "validationOutputBytes",
]);
const MAX_CONFIG_BYTES = 1024 * 1024;
const LONG_TASK_PROBES = 96;
const LONG_TASK_PROBE_BYTES = 24 * 1024;

export function loadCanaryConfig(path: string): ResolvedCanaryConfig {
  const absolute = resolve(path);
  if (statSync(absolute).size > MAX_CONFIG_BYTES) throw new Error("canary config exceeds the bounded input size");
  const file = JSON.parse(readFileSync(absolute, "utf8")) as CanaryFileConfig;
  if (
    !file
    || typeof file !== "object"
    || Array.isArray(file)
    || Object.keys(file).some((key) => !CANARY_CONFIG_KEYS.has(key))
    || file.version !== 1
    || !isAbsolute(file.stateDir)
    || !isAbsolute(file.harnessConfig)
    || !profileName(file.herdrSession)
    || !Number.isInteger(file.repetitions)
    || file.repetitions < 1
    || file.repetitions > 100
    || !profileName(file.oauthReviewerProfile)
    || !profileName(file.customReviewerProfile)
  ) throw new Error("invalid canary config");
  const stateDir = resolve(file.stateDir);
  if (stateDir === resolve("/") || stateDir === resolve(homedir())) throw new Error("canary stateDir is too broad");

  const harnessPath = resolve(file.harnessConfig);
  if (statSync(harnessPath).size > MAX_CONFIG_BYTES) throw new Error("Harness template exceeds the bounded input size");
  const template = JSON.parse(readFileSync(harnessPath, "utf8")) as HarnessTemplate;
  validateHarnessConfig(template);
  if (!template.herdr?.session?.trim() || (template.herdr.bin !== undefined && !template.herdr.bin.trim())) {
    throw new Error("canary Harness template requires herdr.session and an optional non-empty bin");
  }
  if (file.herdrSession === template.herdr.session) {
    throw new Error("canary herdrSession must differ from the Harness template session");
  }
  for (const protectedPath of [template.localPath, template.stateDir, template.worktreeRoot]) {
    if (pathsOverlap(stateDir, protectedPath)) throw new Error("canary stateDir must be isolated from production paths");
  }

  const profiles = template.reviewerProviderProfiles?.profiles;
  const oauth = profiles?.[file.oauthReviewerProfile];
  const custom = profiles?.[file.customReviewerProfile];
  if (oauth?.credentialMode !== "canonical-oauth" || oauth.provider !== "openai-codex") {
    throw new Error("oauthReviewerProfile must select canonical-oauth openai-codex");
  }
  if (!custom || custom.credentialMode !== "canonical-model-config" || custom.provider === "openai-codex") {
    throw new Error("customReviewerProfile must select a non-openai canonical-model-config Provider");
  }

  const stressConcurrency = file.stressConcurrency ?? 2;
  const validationLongMs = file.validationLongMs ?? 60_000;
  const validationOutputBytes = file.validationOutputBytes ?? 2 * 1024 * 1024;
  if (!Number.isInteger(stressConcurrency) || stressConcurrency < 2 || stressConcurrency > 16) {
    throw new Error("stressConcurrency must be between 2 and 16");
  }
  if (!Number.isInteger(validationLongMs) || validationLongMs < 1_000 || validationLongMs > 30 * 60_000) {
    throw new Error("validationLongMs must be between 1000 and 1800000");
  }
  if (!Number.isInteger(validationOutputBytes) || validationOutputBytes < 256 * 1024 || validationOutputBytes > 16 * 1024 * 1024) {
    throw new Error("validationOutputBytes must be between 256 KiB and 16 MiB");
  }
  return {
    file,
    path: absolute,
    stateDir,
    template,
    configDigest: digest({ version: 1, file, harnessTemplate: template }),
    stressConcurrency,
    validationLongMs,
    validationOutputBytes,
    herdr: {
      ...(template.herdr.bin ? { bin: template.herdr.bin } : {}),
      session: file.herdrSession,
    },
  };
}

export class LiveCanaryExecutor implements CanaryExecutor {
  private readonly fixture: Fixture;
  private readonly runner: SyncCommandRunner;
  private readonly herdr: HerdrPort;
  private readonly git: GitPort;
  private readonly preflight: RuntimePreflightPort;
  private readonly piRpc: AttemptRuntimePort;

  constructor(private readonly config: ResolvedCanaryConfig, dependencies: LiveCanaryDependencies = {}) {
    this.runner = dependencies.runner ?? new SyncCommandRunner();
    this.fixture = ensureFixture(config.stateDir, this.runner);
    this.herdr = dependencies.herdr ?? new HerdrCli(config.herdr);
    this.git = dependencies.git ?? new GitCli();
    this.preflight = dependencies.preflight ?? new RuntimePreflightCli();
    this.piRpc = dependencies.piRpc ?? new PiRpcRuntime(this.herdr);
  }

  async execute(unit: CanaryUnit, unitDir: string): Promise<CanaryUnitResult> {
    const wallStarted = Date.now();
    const startedAt = new Date().toISOString();
    const harness = this.unitConfig(unit, unitDir);
    const store = new JsonStateStore(harness.stateDir);
    try {
      let state = await store.load();
      if (!state.activeJob) {
        const setup = await this.prepareUnit(unit, unitDir);
        await store.save({ version: 1, activeJob: canaryJob(unit, setup, harness), terminalJobs: [] }, null);
        state = await store.load();
      }
      assertBoundUnit(state, unit);
      const ctx = new ControllerContext({
        config: harness,
        store,
        github: unavailablePort<GitHubPort>("GitHub"),
        git: this.git,
        herdr: this.herdr,
        analyst: unavailablePort<AnalystPort>("Analyst"),
        evidence: unavailablePort<EvidencePort>("Evidence"),
        clock: { now: () => new Date().toISOString() },
        ids: new CanaryIds(unit.id),
        preflight: this.preflight,
        piRpc: this.piRpc,
      });

      for (let transition = 0; transition < 32; transition += 1) {
        state = await store.load();
        const job = state.activeJob!;
        const terminal = terminalAttempt(job, unit.lane);
        if (job.state === "blocked" || terminal) {
          return unitResult(unit, job, terminal ?? job.activeAttempt, startedAt, wallStarted);
        }
        if (!job.activeAttempt) {
          const expected = unit.lane === "worker" ? "worker_ready" : "reviewer_ready";
          if (job.state !== expected) return unitResult(unit, job, terminalAttempt(job, unit.lane), startedAt, wallStarted);
          const prepared = await prepareAttempt(ctx, state, job, unit.lane);
          if (!prepared.ok) return preflightFailure(unit, startedAt, wallStarted);
          continue;
        }
        const driven = await driveAttempt(ctx, state, job, unit.lane);
        if (!driven.ok && driven.action === "preflight_failed") {
          return preflightFailure(unit, startedAt, wallStarted);
        }
      }
      const current = await store.load();
      if (current.activeJob?.activeAttempt?.phase === "running") {
        throw new Error("canary observation interrupted; resume the same stateDir");
      }
      return genericFailure(unit, startedAt, wallStarted, current.activeJob);
    } catch (error) {
      const state = await store.load();
      if (state.activeJob?.activeAttempt?.phase === "running") {
        throw new Error("canary observation interrupted; resume the same stateDir");
      }
      return genericFailure(unit, startedAt, wallStarted, state.activeJob, error);
    }
  }

  private unitConfig(unit: CanaryUnit, unitDir: string): HarnessTemplate {
    const template = JSON.parse(JSON.stringify(this.config.template)) as HarnessTemplate;
    const profiles = template.reviewerProviderProfiles!;
    const oauth = profiles.profiles[this.config.file.oauthReviewerProfile]!;
    const active = unit.provider === "openai-oauth"
      ? this.config.file.oauthReviewerProfile
      : this.config.file.customReviewerProfile;
    const sourcePath = this.fixture.sourcePath;
    const stateDir = join(unitDir, "harness");
    const worktreeRoot = join(this.config.stateDir, "worktrees");
    const result: HarnessTemplate = {
      ...template,
      repo: "canary/local",
      localPath: sourcePath,
      stateDir,
      worktreeRoot,
      baseRef: "main",
      autoMerge: false,
      readyLabel: "canary-never-ready",
      claimLabel: "canary-never-claim",
      workerRuntime: unit.lane === "worker" ? unit.runtime : template.workerRuntime ?? "herdr-pi-cli",
      reviewerRuntime: unit.lane === "reviewer" ? unit.runtime : template.reviewerRuntime ?? "herdr-pi-cli",
      workerArgv: selectors(template.workerArgv, oauth.provider, oauth.model),
      reviewerProviderProfiles: { ...profiles, active },
      workerCompaction: {
        mode: unit.compaction === "controlled-threshold" ? "controlled-threshold" : "disabled",
      },
      reviewer: {
        ...template.reviewer,
        ...(unit.axisConcurrency ? { axisConcurrency: unit.axisConcurrency } : {}),
      },
      reviewerValidationArgv: validationArgv(unit, this.config),
      diagnostics: { projectId: `canary-${unit.id}`, redactRepo: true, redactIssue: true },
      herdr: this.config.herdr,
    };
    validateHarnessConfig(result);
    return result;
  }

  private async prepareUnit(unit: CanaryUnit, unitDir: string): Promise<UnitSetup> {
    const path = join(unitDir, "setup.json");
    const existing = readJsonIfExists<UnitSetupState>(path);
    if (existing?.phase === "ready") {
      verifyUnitSetup(existing, unit, this.fixture.baseSha, this.config.stateDir, this.runner);
      return existing;
    }
    if (existing) assertSetupReservation(existing, unit, this.fixture.baseSha);
    const generation = (existing?.generation ?? 0) + 1;
    const branch = `canary/${unit.id}-setup-${generation}`;
    const worktreePath = join(this.config.stateDir, "worktrees", `${unit.id}-setup-${generation}`);
    const reservation: UnitSetupState = {
      version: 1,
      unitId: unit.id,
      generation,
      phase: "reserved",
      baseSha: this.fixture.baseSha,
      branch,
      worktreePath,
    };
    writeAtomicJson(path, reservation);
    const worktree = await this.herdr.createWorktree({
      sourcePath: this.fixture.sourcePath,
      branch,
      baseRef: this.fixture.baseSha,
      path: worktreePath,
      label: `canary ${unit.id}`,
    });
    const headSha = unit.lane === "reviewer" ? prepareReviewedCommit(worktree.path, this.runner) : null;
    const setup: UnitSetupState = {
      version: 1,
      unitId: unit.id,
      generation,
      phase: "ready",
      baseSha: this.fixture.baseSha,
      headSha,
      branch,
      worktreePath,
      worktree,
    };
    writeAtomicJson(path, setup);
    return setup;
  }
}

function ensureFixture(stateDir: string, runner: SyncCommandRunner): Fixture {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const root = join(stateDir, "fixture");
  const manifestPath = join(root, "fixture.json");
  const existing = readJsonIfExists<Fixture>(manifestPath);
  if (existing) {
    verifyFixture(existing, runner);
    return existing;
  }
  if (existsSync(root)) throw new Error("canary fixture setup is incomplete; use a fresh isolated stateDir");

  const temporary = join(stateDir, `.fixture-${process.pid}-${randomUUID()}`);
  const origin = join(temporary, "origin.git");
  const source = join(temporary, "source");
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  run(runner, "git", ["init", "--bare", origin]);
  run(runner, "git", ["clone", origin, source]);
  writeFixtureFiles(source);
  run(runner, "git", ["-C", source, "config", "user.name", "Herdr Canary"]);
  run(runner, "git", ["-C", source, "config", "user.email", "canary@example.invalid"]);
  run(runner, "git", ["-C", source, "add", "."]);
  run(runner, "git", ["-C", source, "commit", "-m", "fixture: fixed canary base"]);
  run(runner, "git", ["-C", source, "branch", "-M", "main"]);
  run(runner, "git", ["-C", source, "push", "-u", "origin", "main"]);
  const baseSha = run(runner, "git", ["-C", source, "rev-parse", "HEAD"]).trim();
  const manifest = { version: 1 as const, baseSha, sourcePath: join(root, "source") };
  writeExclusiveJson(join(temporary, "fixture.json"), manifest);
  renameSync(temporary, root);
  run(runner, "git", ["-C", manifest.sourcePath, "remote", "set-url", "origin", join(root, "origin.git")]);
  verifyFixture(manifest, runner);
  return manifest;
}

function verifyFixture(fixture: Fixture, runner: SyncCommandRunner): void {
  if (fixture.version !== 1 || !/^[0-9a-f]{40}$/i.test(fixture.baseSha) || !isAbsolute(fixture.sourcePath)) {
    throw new Error("invalid canary fixture manifest");
  }
  const head = run(runner, "git", ["-C", fixture.sourcePath, "rev-parse", "HEAD"]).trim();
  const status = run(runner, "git", ["-C", fixture.sourcePath, "status", "--porcelain"]).trim();
  const remote = run(runner, "git", ["-C", fixture.sourcePath, "ls-remote", "origin", "refs/heads/main"]).trim().split(/\s+/, 1)[0];
  if (head !== fixture.baseSha || status || remote !== fixture.baseSha) throw new Error("canary fixture Git identity drifted");
}

function writeFixtureFiles(source: string): void {
  for (const directory of ["src", "test", "scripts"]) mkdirSync(join(source, directory), { recursive: true });
  writeFileSync(join(source, "AGENTS.md"), "# Canary repository\n\nOnly implement the fixed task. Never push or change remotes.\n");
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "herdr-runtime-canary",
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2) + "\n");
  writeFileSync(join(source, "src", "greeting.js"), 'export const greeting = "hello";\n');
  writeFileSync(join(source, "src", "math.js"), "export function add(a, b) { return a + b; }\n");
  writeFileSync(join(source, "test", "greeting.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { greeting } from "../src/greeting.js";',
    'test("greeting", () => assert.equal(greeting, "hello"));',
    "",
  ].join("\n"));
  writeFileSync(join(source, "test", "math.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add } from "../src/math.js";',
    'test("add", () => assert.equal(add(2, 3), 5));',
    "",
  ].join("\n"));
  writeFileSync(join(source, "scripts", "context-probe.js"), [
    'import { createHash } from "node:crypto";',
    'const probe = Number(process.argv[2]);',
    `if (!Number.isInteger(probe) || probe < 0 || probe >= ${LONG_TASK_PROBES}) process.exit(2);`,
    'let output = `probe=${probe}\\n`;',
    `for (let line = 0; Buffer.byteLength(output) < ${LONG_TASK_PROBE_BYTES}; line += 1) {`,
    '  output += `${probe}:${line}:${createHash("sha256").update(`${probe}:${line}`).digest("hex")}\\n`;',
    '}',
    `process.stdout.write(output.slice(0, ${LONG_TASK_PROBE_BYTES}));`,
    "",
  ].join("\n"));
}

function prepareReviewedCommit(path: string, runner: SyncCommandRunner): string {
  writeFileSync(join(path, "src", "greeting.js"), 'export const greeting = "hello canary";\n');
  writeFileSync(join(path, "test", "greeting.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { greeting } from "../src/greeting.js";',
    'test("greeting", () => assert.equal(greeting, "hello canary"));',
    "",
  ].join("\n"));
  run(runner, "git", ["-C", path, "config", "user.name", "Herdr Canary"]);
  run(runner, "git", ["-C", path, "config", "user.email", "canary@example.invalid"]);
  run(runner, "git", ["-C", path, "add", "src/greeting.js", "test/greeting.test.js"]);
  run(runner, "git", ["-C", path, "commit", "-m", "feat: prepare exact-head review fixture"]);
  return run(runner, "git", ["-C", path, "rev-parse", "HEAD"]).trim();
}

function canaryJob(unit: CanaryUnit, setup: UnitSetup, config: HarnessConfig): Job {
  const now = new Date().toISOString();
  const issueNumber = Number.parseInt(unit.id.slice(0, 7), 16) + 1;
  const task = taskFromSelection("canary/local", {
    issue: {
      number: issueNumber,
      title: `Canary ${unit.task}`,
      body: objective(unit.task),
      state: "OPEN",
      labels: [],
      assignees: [],
      blockedBy: [],
      parentNumber: null,
      subIssues: [],
      updatedAt: "2026-08-22T00:00:00.000Z",
    },
    mapNumber: null,
    selectionKey: issueNumber,
  });
  return {
    id: `canary-${unit.id}`,
    revision: 0,
    state: unit.lane === "worker" ? "worker_ready" : "reviewer_ready",
    task,
    baseSha: setup.baseSha,
    claimConfirmed: true,
    headSha: setup.headSha,
    branch: setup.branch,
    worktree: setup.worktree,
    analyst: null,
    activeAttempt: null,
    attempts: [],
    reviewRound: 0,
    maxReviewRounds: config.maxReviewRounds,
    pendingHandoff: null,
    incident: null,
    analysis: null,
    approval: null,
    reassessments: [],
    pullRequest: null,
    ciFailure: null,
    ciReworkCount: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

function objective(task: CanaryUnit["task"]): string {
  if (task === "short-change") {
    return 'Change the greeting to "hello canary", update its test, run npm test, commit, then call worker_submit.';
  }
  if (task === "medium-change") {
    return "Add multiply(a,b) in src/math.js, add a formatGreeting(name) export in src/greeting.js, update both test files, run npm test, commit, then call worker_submit.";
  }
  if (task === "long-tools") {
    return `Run node scripts/context-probe.js separately for probe indexes 0 through ${LONG_TASK_PROBES - 1}, verify each bounded output starts with its exact probe index, add src/context-summary.js exporting probeCount=${LONG_TASK_PROBES} and probeBytes=${LONG_TASK_PROBE_BYTES}, add a test, run npm test, commit, then call worker_submit. Re-read Git and tests after any compaction.`;
  }
  return "Review the fixed candidate HEAD independently. Run review_preflight, complete Standards and Spec axes, then call review_submit. Do not modify the source.";
}

function validationArgv(unit: CanaryUnit, config: ResolvedCanaryConfig): string[] {
  if (unit.task === "validation-long") {
    return [process.execPath, "-e", `setTimeout(() => process.exit(0), ${config.validationLongMs})`];
  }
  if (unit.task === "validation-large-output") {
    return [process.execPath, "-e", `process.stdout.write("x".repeat(${config.validationOutputBytes}))`];
  }
  return ["npm", "test"];
}

function selectors(argv: string[], provider: string, model: string): string[] {
  const output = [...argv];
  for (const [flag, value] of [["--provider", provider], ["--model", model]] as const) {
    const indexes = output.flatMap((entry, index) => entry === flag ? [index] : []);
    if (indexes.length > 1) throw new Error(`${flag} appears more than once in workerArgv`);
    if (indexes.length === 0) output.push(flag, value);
    else {
      if (!output[indexes[0]! + 1]) throw new Error(`${flag} has no value in workerArgv`);
      output[indexes[0]! + 1] = value;
    }
  }
  return output;
}

function terminalAttempt(job: Job, lane: CanaryUnit["lane"]): Attempt | null {
  return [...job.attempts].reverse().find((attempt) => attempt.lane === lane) ?? null;
}

function unitResult(
  unit: CanaryUnit,
  job: Job,
  attempt: Attempt | null,
  startedAt: string,
  wallStarted: number,
): CanaryUnitResult {
  const result = attempt?.result;
  const accepted = unit.lane === "worker"
    ? result?.lane === "worker" && result.status === "completed" && job.state === "reviewer_ready"
    : result?.lane === "reviewer" && ["pass", "changes"].includes(result.status)
      && (job.state === "publish_ready" || job.state === "worker_ready");
  const validation = validationFacts(attempt);
  return {
    version: 1,
    unit,
    evidence: "measured",
    outcome: accepted ? "passed" : "failed",
    startedAt: attempt?.startedAt ?? startedAt,
    completedAt: attempt?.completedAt ?? new Date().toISOString(),
    durationMs: elapsed(attempt?.startedAt ?? startedAt, attempt?.completedAt, wallStarted),
    resultPresent: attempt ? attempt.result !== null || existsSync(attempt.resultPath) : false,
    terminalObserved: attempt ? attempt.completedAt !== null || terminalReceiptPresent(attempt) : false,
    validationRan: validation.ran,
    validationDurationMs: validation.durationMs,
    validationOutputBytes: validation.outputBytes,
    compactionCount: compactionCount(attempt),
    failure: accepted ? null : failureForJob(job),
  };
}

function preflightFailure(unit: CanaryUnit, startedAt: string, wallStarted: number): CanaryUnitResult {
  const failure = makeSafeRuntimeDiagnostic({
    domain: "execution",
    code: "provider_unknown",
    stage: "startup",
    failureDomain: "provider",
    failureCode: "provider_unknown",
    retryable: false,
  });
  return failedResult(unit, startedAt, wallStarted, canaryFailureFromDiagnostic(failure));
}

function genericFailure(
  unit: CanaryUnit,
  startedAt: string,
  wallStarted: number,
  job: Job | null,
  error?: unknown,
): CanaryUnitResult {
  const diagnostic = safePiRpcDiagnosticFromError(error)
    ?? (job ? diagnosticForJob(job) : null)
    ?? runnerDiagnostic(error);
  return failedResult(unit, startedAt, wallStarted, canaryFailureFromDiagnostic(diagnostic));
}

function failedResult(
  unit: CanaryUnit,
  startedAt: string,
  wallStarted: number,
  failure: CanaryFailure,
): CanaryUnitResult {
  return {
    version: 1,
    unit,
    evidence: "measured",
    outcome: "failed",
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - wallStarted),
    resultPresent: false,
    terminalObserved: false,
    validationRan: false,
    validationDurationMs: null,
    validationOutputBytes: null,
    compactionCount: null,
    failure,
  };
}

function failureForJob(job: Job): CanaryFailure {
  return canaryFailureFromDiagnostic(diagnosticForJob(job) ?? policyDiagnostic());
}

function diagnosticForJob(job: Job): SafeRuntimeDiagnostic | null {
  if (job.incident?.runtimeDiagnostic) return job.incident.runtimeDiagnostic;
  if (job.incident?.class === "validation_infrastructure") {
    return makeSafeRuntimeDiagnostic({
      domain: "execution",
      code: "validation_infrastructure",
      stage: "review-validation",
      failureDomain: "validation",
      failureCode: "validation_infrastructure",
      retryable: true,
    });
  }
  if (job.incident?.class === "integrity_violation" || job.incident?.class === "stale_task") {
    return makeSafeRuntimeDiagnostic({
      domain: "acceptance",
      code: "git_integrity",
      stage: "git-verification",
      failureDomain: "git",
      failureCode: "git_integrity",
      retryable: false,
    });
  }
  return null;
}

function policyDiagnostic(): SafeRuntimeDiagnostic {
  return makeSafeRuntimeDiagnostic({
    domain: "acceptance",
    code: "policy_violation",
    stage: "result-validation",
    failureDomain: "policy",
    failureCode: "policy_violation",
    retryable: false,
  });
}

function runnerDiagnostic(error: unknown): SafeRuntimeDiagnostic {
  const classified = classifyPiRpcRunnerFailure(error, "startup");
  return makeSafeRuntimeDiagnostic({
    domain: classified.domain,
    code: classified.code,
    stage: classified.stage,
    failureDomain: classified.failureDomain,
    failureCode: classified.failureCode,
    retryable: classified.retryable,
  });
}

function validationFacts(attempt: Attempt | null): {
  ran: boolean;
  durationMs: number | null;
  outputBytes: number | null;
} {
  const path = attempt?.reviewerValidationReceipt?.path;
  if (!path || !existsSync(path)) return { ran: false, durationMs: null, outputBytes: null };
  try {
    const receipt = JSON.parse(readFileSync(path, "utf8")) as Parameters<typeof reviewerValidationResult>[0];
    const result = reviewerValidationResult(receipt);
    return {
      ran: true,
      durationMs: result.durationMs,
      outputBytes: result.stdout.byteCount + result.stderr.byteCount,
    };
  } catch {
    return { ran: true, durationMs: null, outputBytes: null };
  }
}

function compactionCount(attempt: Attempt | null): number | null {
  if (!attempt?.executionSnapshot) return null;
  if (attempt.executionSnapshot.adapter !== "pi-rpc") return null;
  const terminal = readJsonIfExists<Record<string, unknown>>(join(rpcRuntimeRoot(attempt.executionSnapshot), "terminal.json"));
  if (!terminal) return null;
  const receipt = safeCompactionReceipt(terminal.controlledCompaction);
  return receipt ? Number(receipt.count) : 0;
}

function terminalReceiptPresent(attempt: Attempt): boolean {
  try {
    return !!attempt.executionSnapshot && existsSync(join(rpcRuntimeRoot(attempt.executionSnapshot), "terminal.json"));
  } catch {
    return false;
  }
}

function elapsed(startedAt: string, completedAt: string | null | undefined, wallStarted: number): number {
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : Math.max(0, Date.now() - wallStarted);
}

function verifyUnitSetup(
  setup: UnitSetup & { phase?: unknown; worktreePath?: unknown },
  unit: CanaryUnit,
  expectedBaseSha: string,
  canaryStateDir: string,
  runner: SyncCommandRunner,
): void {
  const expectedWorktreePath = join(
    canaryStateDir,
    "worktrees",
    `${unit.id}-setup-${setup.generation}`,
  );
  if (
    setup.version !== 1
    || setup.unitId !== unit.id
    || !Number.isInteger(setup.generation)
    || setup.generation < 1
    || setup.phase !== "ready"
    || !/^[0-9a-f]{40}$/i.test(setup.baseSha)
    || setup.baseSha !== expectedBaseSha
    || (setup.headSha !== null && !/^[0-9a-f]{40}$/i.test(setup.headSha))
    || setup.worktree.branch !== setup.branch
    || setup.worktree.path !== setup.worktreePath
    || setup.worktreePath !== expectedWorktreePath
  ) throw new Error("invalid canary unit setup receipt");
  const head = run(runner, "git", ["-C", setup.worktree.path, "rev-parse", "HEAD"]).trim();
  const status = run(runner, "git", ["-C", setup.worktree.path, "status", "--porcelain"]).trim();
  const expected = setup.headSha ?? setup.baseSha;
  if (head !== expected || status) throw new Error("canary unit worktree drifted before resume");
}

function assertSetupReservation(setup: UnitSetupState, unit: CanaryUnit, expectedBaseSha: string): void {
  if (
    setup.version !== 1
    || setup.unitId !== unit.id
    || !Number.isInteger(setup.generation)
    || setup.generation < 1
    || setup.phase !== "reserved"
    || !/^[0-9a-f]{40}$/i.test(setup.baseSha)
    || setup.baseSha !== expectedBaseSha
    || !isAbsolute(setup.worktreePath)
    || setup.branch !== `canary/${unit.id}-setup-${setup.generation}`
  ) throw new Error("invalid canary setup reservation");
}

function assertBoundUnit(state: HarnessState, unit: CanaryUnit): void {
  if (!state.activeJob || state.activeJob.id !== `canary-${unit.id}`) {
    throw new Error("canary Harness state belongs to a different unit");
  }
}

function profileName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function unavailablePort<T>(name: string): T {
  return new Proxy({}, {
    get() {
      return () => Promise.reject(new Error(`${name} port is unavailable in the local-only canary`));
    },
  }) as T;
}

export class CanaryIds implements IdGenerator {
  constructor(private readonly unitId: string) {}

  next(prefix: string): string {
    return `${prefix}-${this.unitId}-${randomUUID()}`;
  }
}

function run(runner: SyncCommandRunner, command: string, argv: string[]): string {
  return requireSuccess(runner.run(command, argv, { timeoutMs: 120_000 }), `${command} ${argv[0] ?? ""}`);
}
