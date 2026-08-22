#!/usr/bin/env node
import { projectViewFromConfig } from "./transport/project-projection.js";
import { fleetViewFromConfig } from "./transport/fleet-projection.js";
import { fleetDiagnosticViewFromConfig, projectDiagnosticViewFromConfig } from "./transport/diagnostic-projection.js";
import type { TelegramTransportEnvelope } from "./transport/telegram-protocol.js";

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
  const json = flag(argv, "--json");
  if (json !== null && json !== "v2") throw new Error("--json only supports v2");
  const config = requiredFlag(argv, "--config");
  const envelope = diagnose
    ? scope === "project"
      ? projectDiagnosticViewFromConfig(config, daysFlag(argv))
      : fleetDiagnosticViewFromConfig(config, daysFlag(argv))
    : project
      ? await projectViewFromConfig(config)
      : await fleetViewFromConfig(config);
  process.stdout.write(`${json === "v2" ? JSON.stringify(envelope) : humanOutput(envelope, view!)}\n`);
  return 0;
}

function humanOutput(envelope: TelegramTransportEnvelope, view: string): string {
  if (envelope.kind === "diagnostic-view") {
    return `Diagnose ${envelope.diagnostic.days}d · attempts ${envelope.diagnostic.totalAttempts} · partial ${envelope.diagnostic.partialAttempts} · unknown ${envelope.diagnostic.unknownAttempts}`;
  }
  if (envelope.kind === "fleet-view") {
    const phases = envelope.projects.reduce<Record<string, number>>((counts, project) => ({ ...counts, [project.phase]: (counts[project.phase] ?? 0) + 1 }), {});
    return view === "health"
      ? `${envelope.fleetId} · ${envelope.fleet.health.toUpperCase()} · lease ${envelope.fleet.lease} · heartbeat ${envelope.fleet.heartbeat}`
      : `${envelope.fleetId} · ${envelope.fleet.health.toUpperCase()} · running ${phases.running ?? 0} · adopted ${phases.adopted ?? 0} · backoff ${phases.backoff ?? 0} · tripped ${phases.tripped ?? 0}`;
  }
  if (envelope.kind !== "project-view") return `${envelope.category} · ${envelope.title}`;
  if (view === "actions") return envelope.actions.length === 0
    ? `${envelope.projectId} · no current operator action`
    : envelope.actions.map((action) => `${action.kind} · ${action.effect} · ${action.id}`).join("\n");
  if (view === "why") return `${envelope.projectId} · ${envelope.failure.taxonomyDomain ?? "unknown"}/${envelope.failure.failureCode ?? "none"} · retryable ${String(envelope.failure.retryable)}`;
  if (view === "health") return `${envelope.projectId} · controller ${envelope.project.controller.health.toUpperCase()} · workflow ${envelope.workflow.state ?? "idle"}`;
  return `${envelope.projectId} · ${(envelope.workflow.state ?? "idle").toUpperCase()} · issue ${envelope.workflow.issueNumber ?? "-"} · controller ${envelope.project.controller.health}`;
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
