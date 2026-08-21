import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SUPPORTED_PI_SUBAGENTS_VERSION } from "../src/compatibility.js";
import type { FleetRuntimeState } from "../src/fleet/types.js";

test("Fleet isolates tripped, adopted, and owned projects and releases leases after a degraded shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-supervisor-"));
  const fleetStateDir = join(root, "fleet-state");
  const projectStateDirs = {
    alpha: join(root, "blocked-parent", "state"),
    beta: join(root, "beta-state"),
    gamma: join(root, "gamma-state"),
  };
  let fleetPid: number | null = null;
  let gammaPid: number | null = null;
  try {
    writeFileSync(dirname(projectStateDirs.alpha), "not a directory");
    mkdirSync(projectStateDirs.beta, { recursive: true });
    writeFileSync(join(projectStateDirs.beta, "controller-lease.json"), `${JSON.stringify({
      version: 1,
      instanceId: "external-controller",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });

    const resources = createRoleResources(root);
    const projects = Object.entries(projectStateDirs).map(([id, stateDir]) => {
      const configPath = join(root, `${id}.harness.json`);
      writeFileSync(configPath, `${JSON.stringify(projectConfig(root, id, stateDir, resources), null, 2)}\n`);
      return { id, config: configPath, enabled: true, pollMs: 100 };
    });
    const fleetConfigPath = join(root, "fleet.json");
    writeFileSync(fleetConfigPath, `${JSON.stringify({
      version: 1,
      name: "integration-fleet",
      stateDir: fleetStateDir,
      defaultPollMs: 100,
      shutdownGraceMs: 2_000,
      maxLogBytes: 4_096,
      restartPolicy: {
        initialBackoffMs: 100,
        maxBackoffMs: 100,
        maxRestarts: 0,
        windowMs: 10_000,
        stableAfterMs: 1_000,
      },
      projects,
    }, null, 2)}\n`);

    const fakeBin = join(root, "bin");
    const fakeGh = join(fakeBin, "gh");
    mkdirSync(fakeBin);
    writeFileSync(fakeGh, `#!${process.execPath}\nprocess.stdout.write("[]\\n");\n`);
    chmodSync(fakeGh, 0o700);

    const first = startFleetProcess(fleetConfigPath, fakeBin);
    fleetPid = first.child.pid ?? null;
    const firstState = await waitForState(fleetStateDir, (candidate) => (
      candidate.projects.alpha?.phase === "tripped"
      && candidate.projects.beta?.phase === "adopted"
      && candidate.projects.gamma?.phase === "running"
      && existsSync(join(projectStateDirs.gamma, "controller-lease.json"))
    ));
    gammaPid = firstState.projects.gamma?.pid ?? null;
    const alphaExit = firstState.projects.alpha?.lastExit?.exitedAt;
    assert.ok(alphaExit);
    first.child.kill("SIGTERM");
    assert.deepEqual(await withTimeout(first.exited, 5_000), { code: 0, signal: null }, first.stderr());
    assert.equal(existsSync(join(fleetStateDir, "fleet-supervisor-lease.json")), false, first.stderr());
    assert.equal(existsSync(join(projectStateDirs.gamma, "controller-lease.json")), false, first.stderr());
    gammaPid = null;

    const betaConfigPath = projects.find((project) => project.id === "beta")!.config;
    const betaConfig = JSON.parse(readFileSync(betaConfigPath, "utf8")) as Record<string, unknown>;
    betaConfig.analyst = { command: process.execPath, argv: ["changed-sibling-config"] };
    writeFileSync(betaConfigPath, `${JSON.stringify(betaConfig, null, 2)}\n`);

    const second = startFleetProcess(fleetConfigPath, fakeBin);
    fleetPid = second.child.pid ?? null;
    const secondState = await waitForState(fleetStateDir, (candidate) => (
      candidate.projects.alpha?.phase === "tripped"
      && candidate.projects.beta?.phase === "adopted"
      && candidate.projects.gamma?.phase === "running"
      && existsSync(join(projectStateDirs.gamma, "controller-lease.json"))
    ));
    gammaPid = secondState.projects.gamma?.pid ?? null;
    assert.equal(secondState.projects.alpha?.lastExit?.exitedAt, alphaExit, "sibling config drift reset alpha's circuit history");

    const statePath = join(fleetStateDir, "fleet-state.json");
    rmSync(statePath);
    mkdirSync(statePath);
    const previousGammaPid = gammaPid;
    assert.ok(previousGammaPid);
    process.kill(previousGammaPid, "SIGKILL");
    gammaPid = null;
    await delay(250);
    assert.equal(processIsAlive(fleetPid), true, "Fleet state degradation stopped the Supervisor");
    const staleLease = JSON.parse(readFileSync(join(projectStateDirs.gamma, "controller-lease.json"), "utf8")) as { pid?: unknown };
    assert.equal(staleLease.pid, previousGammaPid);
    second.child.kill("SIGTERM");
    const outcome = await withTimeout(second.exited, 5_000);

    assert.deepEqual(outcome, { code: 0, signal: null }, second.stderr());
    assert.equal(existsSync(join(fleetStateDir, "fleet-supervisor-lease.json")), false, second.stderr());
    assert.equal(readdirSync(fleetStateDir).some((name) => name.endsWith(".tmp")), false, "failed checkpoints leaked temp files");
    assert.equal(existsSync(join(projectStateDirs.beta, "controller-lease.json")), true, "adopted Controller lease was removed");
  } finally {
    if (fleetPid !== null) killIfAlive(fleetPid);
    if (gammaPid !== null) killIfAlive(gammaPid);
    rmSync(root, { recursive: true, force: true });
  }
});

type RoleResources = { implementSkill: string; piSubagentsExtension: string };

function startFleetProcess(configPath: string, path: string): {
  child: ReturnType<typeof spawn>;
  exited: Promise<{ code: number | null; signal: string | null }>;
  stderr(): string;
} {
  const child = spawn(process.execPath, [resolve("dist/src/fleet-cli.js"), "run", "--config", configPath], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: path },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: unknown) => { stderr += String(chunk); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("exit", (code: number | null, signal: string | null) => resolveExit({ code, signal }));
  });
  return { child, exited, stderr: () => stderr };
}

function createRoleResources(root: string): RoleResources {
  const installRoot = join(root, "mattpocock-skills");
  const implementSkill = join(installRoot, "skills", "implement");
  mkdirSync(implementSkill, { recursive: true });
  writeFileSync(join(implementSkill, "SKILL.md"), "---\nname: implement\n---\n");
  writeFileSync(join(installRoot, ".skill-lock.json"), JSON.stringify({
    version: 3,
    skills: {
      implement: {
        source: "mattpocock/skills",
        sourceType: "github",
        sourceUrl: "https://github.com/mattpocock/skills.git",
        skillPath: "skills/engineering/implement/SKILL.md",
        pluginName: "mattpocock-skills",
        skillFolderHash: "test-fixture",
      },
    },
  }));

  const piSubagentsRoot = join(root, "pi-subagents");
  const piSubagentsExtension = join(piSubagentsRoot, "index.ts");
  mkdirSync(piSubagentsRoot);
  writeFileSync(piSubagentsExtension, "export {};\n");
  writeFileSync(join(piSubagentsRoot, "capability-ceiling.js"), "export {};\n");
  writeFileSync(join(piSubagentsRoot, "package.json"), JSON.stringify({
    name: "pi-subagents",
    version: SUPPORTED_PI_SUBAGENTS_VERSION,
    pi: { extensions: ["./index.ts"] },
    exports: { "./capability-ceiling": "./capability-ceiling.js" },
  }));
  return { implementSkill, piSubagentsExtension };
}

function projectConfig(root: string, id: string, stateDir: string, resources: RoleResources): Record<string, unknown> {
  const localPath = join(root, `${id}-source`);
  const worktreeRoot = join(root, `${id}-worktrees`);
  mkdirSync(localPath, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  const repositoryRoot = process.cwd();
  const baseArgv = [
    "--no-approve", "--no-skills", "--no-session", "--no-extensions",
    "--no-context-files", "--no-prompt-templates", "--no-themes",
  ];
  return {
    repo: `owner/${id}`,
    localPath,
    stateDir,
    baseRef: "main",
    readyLabel: "ready-for-agent",
    claimLabel: "agent:claimed",
    worktreeRoot,
    maxReviewRounds: 1,
    maxAnalystTurns: 1,
    workerRuntime: "pi-rpc",
    reviewerRuntime: "pi-rpc",
    preflight: { piBin: join(root, "missing-pi"), dockerRequired: false },
    reviewerValidationArgv: ["npm", "test"],
    workerArgv: [
      ...baseArgv,
      "--extension", join(repositoryRoot, "pi/extensions/worker-tools.js"),
      "--skill", resources.implementSkill,
      "--skill", join(repositoryRoot, "pi/skills/tdd"),
      "--skill", join(repositoryRoot, "pi/skills/focused-self-check"),
      "--provider", "openai-codex",
      "--model", "fixture-model",
      "--tools", "read,bash,edit,write,grep,find,ls,worker_submit",
      "--thinking", "high",
    ],
    reviewerArgv: [
      ...baseArgv,
      "--extension", join(repositoryRoot, "pi/extensions/reviewer-subagent-config.js"),
      "--extension", resources.piSubagentsExtension,
      "--extension", join(repositoryRoot, "pi/extensions/reviewer-tools.js"),
      "--skill", join(repositoryRoot, "pi/skills/code-review"),
      "--provider", "openai-codex",
      "--model", "fixture-model",
      "--tools", "read,grep,find,ls,subagent,review_preflight,review_submit",
      "--thinking", "max",
    ],
    herdr: { bin: "herdr", session: `session-${id}` },
    analyst: { command: process.execPath },
  };
}

async function waitForState(
  stateDir: string,
  predicate: (state: FleetRuntimeState) => boolean,
): Promise<FleetRuntimeState> {
  const deadline = Date.now() + 5_000;
  const statePath = join(stateDir, "fleet-state.json");
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8")) as FleetRuntimeState;
      if (predicate(state)) return state;
    } catch {
      // The Supervisor may be between atomic state files during startup.
    }
    await delay(25);
  }
  throw new Error(`Fleet state did not reach the expected phases: ${statePath}`);
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolveResult, rejectResult) => {
    const timer = setTimeout(() => rejectResult(new Error(`timed out after ${milliseconds}ms`)), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolveResult(value); },
      (error) => { clearTimeout(timer); rejectResult(error); },
    );
  });
}

function killIfAlive(pid: number): void {
  try { process.kill(pid, "SIGKILL"); } catch { /* Process already exited. */ }
}

function processIsAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, milliseconds); });
}
