import { diagnoseProjects, diagnosticProject, type DiagnosticReport } from "../diagnostics.js";
import { loadFleetConfig } from "../fleet/config.js";
import {
  assertBoundedTransportEnvelope,
  transportBase,
  type DiagnosticViewEnvelope,
} from "./telegram-protocol.js";
import { loadFleetTransportConfig } from "./fleet-projection.js";
import { loadProjectHarnessConfig, loadProjectTransportConfig } from "./project-projection.js";

export function projectDiagnosticViewFromConfig(
  configPath: string,
  days: 7 | 30,
  now?: string,
): DiagnosticViewEnvelope {
  const transport = loadProjectTransportConfig(configPath);
  const harness = loadProjectHarnessConfig(transport.harnessConfig, transport.projectId);
  const report = diagnoseProjects([diagnosticProject(harness, transport.projectId)], { days, ...(now ? { now } : {}) });
  return diagnosticView(report, {
    routeId: transport.routeId,
    projectId: transport.projectId,
    fleetId: transport.fleetId ?? null,
  }, now);
}

export function fleetDiagnosticViewFromConfig(
  configPath: string,
  days: 7 | 30,
  now?: string,
): DiagnosticViewEnvelope {
  const transport = loadFleetTransportConfig(configPath);
  const fleet = loadFleetConfig(transport.fleetConfig);
  const report = diagnoseProjects(
    fleet.projects.map((project) => diagnosticProject(project.config, project.id)),
    { days, ...(now ? { now } : {}) },
  );
  return diagnosticView(report, { routeId: transport.routeId, projectId: null, fleetId: fleet.name }, now);
}

export function diagnosticView(
  report: DiagnosticReport,
  identity: { routeId: string; projectId: string | null; fleetId: string | null },
  now = report.timeRange.to,
): DiagnosticViewEnvelope {
  const automaticRecoveries = new Map<string, number>();
  for (const attempt of report.attempts) {
    automaticRecoveries.set(attempt.projectId, Math.max(
      automaticRecoveries.get(attempt.projectId) ?? 0,
      attempt.automaticRecoveryCount ?? 0,
    ));
  }
  return assertBoundedTransportEnvelope({
    ...transportBase("diagnostic-view", identity, now),
    diagnostic: {
      days: report.timeRange.days as 7 | 30,
      partial: report.partial,
      corruptProjects: report.corrupt.projects,
      corruptAttempts: report.corrupt.attempts,
      corruptArtifacts: report.corrupt.artifacts,
      totalAttempts: report.totals.failedAttempts,
      partialAttempts: report.totals.partialAttempts,
      unknownAttempts: report.attempts.filter((attempt) => attempt.failureCode === "unknown").length,
      resultPresentButTerminalMissing: report.attempts.filter((attempt) => attempt.resultPresent === true && !attempt.terminalPresent).length,
      runtimeStallsAndDeadlines: report.attempts.filter((attempt) => attempt.failureCode === "runtime_stall" || attempt.failureCode === "attempt_deadline").length,
      credentialFailures: report.attempts.filter((attempt) => attempt.failureDomain === "credential" || attempt.failureCode.startsWith("credential_") || attempt.failureCode.startsWith("oauth_")).length,
      validationInfrastructure: report.attempts.filter((attempt) => attempt.failureCode === "validation_infrastructure").length,
      automaticRecoveryCount: [...automaticRecoveries.values()].reduce((sum, count) => sum + count, 0),
      topFailureCodes: keyCounts(report.views.byFailureCode, 8),
      byLane: keyCounts(report.views.byLane, 3),
      byProviderModel: keyCounts(report.views.byProviderModel, 8),
    },
  });
}

function keyCounts(values: Record<string, number>, limit: number): Array<{ key: string; count: number }> {
  return Object.entries(values)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key: key.slice(0, 256), count }));
}
