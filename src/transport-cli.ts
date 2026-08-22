#!/usr/bin/env node
import { projectViewFromConfig } from "./transport/project-projection.js";
import { fleetViewFromConfig } from "./transport/fleet-projection.js";
import { fleetDiagnosticViewFromConfig, projectDiagnosticViewFromConfig } from "./transport/diagnostic-projection.js";

const PROJECT_VIEWS = new Set(["status", "why", "actions", "health"]);
const FLEET_VIEWS = new Set(["status", "health"]);

async function main(argv: string[]): Promise<number> {
  const alias = argv[2] === "project-diagnose" || argv[2] === "fleet-diagnose";
  const scope = alias ? argv[2]!.startsWith("project") ? "project" : "fleet" : argv[2];
  const view = alias ? "diagnose" : argv[3];
  const project = scope === "project" && PROJECT_VIEWS.has(view ?? "");
  const fleet = scope === "fleet" && FLEET_VIEWS.has(view ?? "");
  const diagnose = (scope === "project" || scope === "fleet") && view === "diagnose";
  if (!project && !fleet && !diagnose) throw new Error("usage: transport-cli project status|why|actions|health|diagnose | fleet status|health|diagnose --config /absolute/observer.json --json v2");
  if (flag(argv, "--json") !== "v2") throw new Error("--json v2 is required");
  const config = requiredFlag(argv, "--config");
  const envelope = diagnose
    ? scope === "project"
      ? projectDiagnosticViewFromConfig(config, daysFlag(argv))
      : fleetDiagnosticViewFromConfig(config, daysFlag(argv))
    : project
      ? await projectViewFromConfig(config)
      : await fleetViewFromConfig(config);
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  return 0;
}

function daysFlag(argv: string[]): 7 | 30 {
  const value = Number(flag(argv, "--days") ?? "7");
  if (value !== 7 && value !== 30) throw new Error("--days must be 7 or 30");
  return value;
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

main(process.argv)
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
