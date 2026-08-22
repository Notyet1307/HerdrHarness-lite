#!/usr/bin/env node
import { loadFleetConfig, selectFleetProjects } from "./fleet/config.js";
import { resetFleetProject } from "./fleet/reset.js";
import { readFleetStatus } from "./fleet/status.js";
import { runFleetSupervisor } from "./fleet/supervisor.js";
import { runFleetTick } from "./fleet/tick.js";
import { aggregateDiagnosticOutput, diagnoseProjects, diagnosticProject } from "./diagnostics.js";

const usage = `Usage:
  herdr-harness-fleet validate --config /absolute/fleet.config.json [--project ID]
  herdr-harness-fleet status --config /absolute/fleet.config.json [--project ID] [--operator]
  herdr-harness-fleet diagnose --config /absolute/fleet.config.json [--project ID] [--days 7] [--json]
  herdr-harness-fleet tick --config /absolute/fleet.config.json [--project ID] [--concurrency N]
  herdr-harness-fleet run --config /absolute/fleet.config.json [--project ID]
  herdr-harness-fleet reset --config /absolute/fleet.config.json --project ID
`;

async function main(argv: string[]): Promise<number> {
  const command = argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage);
    return 0;
  }
  const configPath = requiredFlag(argv, "--config");
  const config = loadFleetConfig(configPath);
  const projectId = flag(argv, "--project");
  const projects = selectFleetProjects(config, projectId, command === "tick" || command === "run");

  if (command === "validate") {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      fleet: config.name,
      configDigest: config.digest,
      stateDir: config.stateDir,
      projects: projects.map((project) => ({
        id: project.id,
        repo: project.config.repo,
        configPath: project.configPath,
        configDigest: project.configDigest,
        localPath: project.config.localPath,
        stateDir: project.config.stateDir,
        worktreeRoot: project.config.worktreeRoot,
        herdrSession: project.config.herdr.session,
      })),
    }, null, 2)}\n`);
    return 0;
  }
  if (command === "status") {
    const status = await readFleetStatus({ ...config, projects }, argv.includes("--operator"));
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }
  if (command === "diagnose") {
    const report = diagnoseProjects(
      projects.map((project) => diagnosticProject(project.config, project.id)),
      { days: optionalIntegerFlag(argv, "--days") ?? 7 },
    );
    process.stdout.write(`${JSON.stringify(argv.includes("--json") ? report : aggregateDiagnosticOutput(report), null, 2)}\n`);
    return 0;
  }
  if (command === "tick") {
    const concurrency = optionalIntegerFlag(argv, "--concurrency") ?? config.tickConcurrency;
    if (concurrency < 1 || concurrency > 64) throw new Error("--concurrency must be between 1 and 64");
    const report = await runFleetTick({ config, projects, concurrency });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }
  if (command === "run") {
    await runFleetSupervisor({ config, projects });
    return 0;
  }
  if (command === "reset") {
    if (!projectId) throw new Error("reset requires --project");
    process.stdout.write(`${JSON.stringify(resetFleetProject(config, projectId), null, 2)}\n`);
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
}

function requiredFlag(argv: string[], name: string): string {
  const value = flag(argv, name);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function optionalIntegerFlag(argv: string[], name: string): number | null {
  const raw = flag(argv, name);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

main(process.argv)
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
