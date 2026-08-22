import type {
  DiagnosticViewEnvelope,
  EventEnvelope,
  FleetViewEnvelope,
  ProjectViewEnvelope,
  TelegramTransportEnvelope,
} from "./telegram-protocol.js";

const AT = "2026-08-22T00:00:00.000Z";
const controller = {
  health: "healthy" as const,
  lease: "alive" as const,
  heartbeat: "fresh" as const,
  heartbeatAgeMs: 1_000,
  pidAlive: true,
};

export function telegramTransportGoldenFixtures(): Record<string, TelegramTransportEnvelope> {
  const project: ProjectViewEnvelope = {
    version: 2,
    kind: "project-view",
    generatedAt: AT,
    routeId: "exposure",
    projectId: "Exposure-Agent",
    fleetId: "engineering-fleet",
    project: { repo: "owner/exposure-agent", controller },
    workflow: {
      mode: "needs_decision",
      state: "blocked",
      jobId: "job-001",
      issueNumber: 48,
      revision: 12,
      reviewRound: 2,
      maxReviewRounds: 3,
      lane: "reviewer",
      phase: "settled",
      attemptId: "reviewer-002",
      headSha: "b".repeat(40),
      pullRequest: { number: 50, url: "https://github.com/owner/exposure-agent/pull/50" },
      incidentClass: "infrastructure_exhausted",
      incidentLane: "reviewer",
    },
    runtime: {
      adapter: "pi-rpc",
      provider: `sha256:${"1".repeat(64)}`,
      model: `sha256:${"2".repeat(64)}`,
      runtimeVersion: "0.84.2",
      credentialMode: "canonical-oauth",
      axisConcurrency: 1,
      compactionMode: "disabled",
      lastProgressType: "assistant_message_end",
      lastProgressAt: AT,
      elapsedMs: 60_000,
      runtimeDeadlineAt: "2026-08-22T00:45:00.000Z",
      remainingBucket: "15m_60m",
      resultPresent: false,
    },
    reviewer: {
      validationStatus: "passed",
      validationDurationMs: 12_000,
      validationOutputByteBuckets: { stdout: "lt64k", stderr: "lt64k" },
      validationOutputDigests: { stdout: "3".repeat(64), stderr: "4".repeat(64) },
      reusedCheckpointStages: ["reviewer-preflight", "standards-axis", "validation"],
      missingAxisStages: ["spec-axis"],
    },
    failure: {
      taxonomyDomain: "execution",
      failureDomain: "provider",
      failureCode: "provider_timeout",
      failureDetailCode: "provider_timeout",
      retryable: true,
      partial: false,
      corrupt: false,
      unknown: false,
    },
    recovery: {
      automaticRule: null,
      action: null,
      notBefore: null,
      quotaConsumed: false,
      humanActionRequired: true,
    },
    actions: [{ id: "decision-0123456789abcdef", kind: "approve_retry", effect: "retry_fresh_reviewer" }],
  };

  const fleet: FleetViewEnvelope = {
    version: 2,
    kind: "fleet-view",
    generatedAt: AT,
    routeId: "fleet",
    projectId: null,
    fleetId: "engineering-fleet",
    fleet: {
      health: "degraded",
      lease: "alive",
      heartbeat: "fresh",
      heartbeatAgeMs: 1_000,
      runtimeError: false,
      configDrift: false,
      supervisorPidAlive: true,
      stopping: false,
    },
    projects: [
      fleetProject("exposure", "Exposure-Agent", "running", true, true, { state: "blocked", issueNumber: 48, revision: 12, incidentClass: "infrastructure_exhausted" }),
      fleetProject("atlas", "CloudAtlas.v2", "adopted", false, true, { state: "awaiting_merge", issueNumber: 81, revision: 20, incidentClass: null }),
      fleetProject("governance", "Governance_Run", "backoff", false, false, null),
      fleetProject("canary", "Canary", "tripped", false, false, null),
    ],
  };

  const diagnostic: DiagnosticViewEnvelope = {
    version: 2,
    kind: "diagnostic-view",
    generatedAt: AT,
    routeId: "fleet",
    projectId: null,
    fleetId: "engineering-fleet",
    diagnostic: {
      days: 7,
      partial: true,
      corruptProjects: 0,
      corruptAttempts: 0,
      corruptArtifacts: 0,
      totalAttempts: 5,
      partialAttempts: 1,
      unknownAttempts: 1,
      resultPresentButTerminalMissing: 1,
      runtimeStallsAndDeadlines: 2,
      credentialFailures: 1,
      validationInfrastructure: 1,
      automaticRecoveryCount: 1,
      topFailureCodes: [{ key: "runtime_stall", count: 2 }, { key: "unknown", count: 1 }],
      byLane: [{ key: "reviewer", count: 2 }, { key: "worker", count: 3 }],
      byProviderModel: [{ key: `sha256:${"1".repeat(64)}/sha256:${"2".repeat(64)}`, count: 5 }],
    },
  };

  return {
    "project-view.json": project,
    "fleet-view.json": fleet,
    "diagnostic-view.json": diagnostic,
    "event-provider-transient.json": event({
      routeId: "exposure",
      projectId: "Exposure-Agent",
      eventId: "event-provider-transient-001",
      dedupeKey: "recovery.automatic:approval-001",
      severity: "warning",
      category: "recovery.automatic",
      title: "Provider transient fresh retry",
      summary: "A fresh Reviewer is authorized after a verified pre-side-effect transient failure.",
      facts: [
        { label: "Lane", value: "reviewer" },
        { label: "Provider", value: `sha256:${"1".repeat(64)}` },
        { label: "Failure", value: "provider_timeout" },
        { label: "Not before", value: "2026-08-22T00:00:05.000Z" },
        { label: "Attempt", value: "fresh" },
        { label: "Boundary", value: "pre-side-effect verified" },
        { label: "Quota", value: "consumed for job/lane/HEAD" },
      ],
    }),
    "event-controller-down.json": event({
      routeId: "exposure",
      projectId: "Exposure-Agent",
      eventId: "event-controller-down-001",
      dedupeKey: "controller.down:Exposure-Agent:stale",
      severity: "critical",
      category: "controller.down",
      title: "Controller heartbeat stopped",
      summary: "The project Controller lease or heartbeat is not healthy; no restart was attempted.",
      facts: [{ label: "Controller", value: "down" }],
      actionRequired: true,
    }),
    "event-project-tripped.json": event({
      routeId: "canary",
      projectId: "Canary",
      eventId: "event-project-tripped-001",
      dedupeKey: "project.tripped:Canary:4",
      severity: "critical",
      category: "project.tripped",
      title: "Fleet project circuit opened",
      summary: "The Fleet Supervisor stopped restarting this project after its bounded restart budget was exhausted.",
      facts: [{ label: "Phase", value: "tripped" }, { label: "Restarts", value: "4" }],
      actionRequired: true,
    }),
    "approval-card.json": event({
      routeId: "exposure",
      projectId: "Exposure-Agent",
      eventId: "event-approval-001",
      dedupeKey: "operator.approval:analysis-001:decision-0123456789abcdef",
      severity: "warning",
      category: "operator.approval",
      title: "Exact operator approval required",
      summary: "Harness offers one current Core-owned fresh Reviewer option.",
      facts: [{ label: "Action", value: "retry_fresh_reviewer" }, { label: "Revision", value: "12" }],
      actionRequired: true,
      operatorActionKinds: ["approve_retry"],
      approval: { token: "0123456789ABCDEF", approveLabel: "Approve fresh Reviewer", expiresAt: "2026-08-22T00:10:00.000Z" },
    }),
  };
}

function fleetProject(
  routeId: string,
  projectId: string,
  phase: FleetViewEnvelope["projects"][number]["phase"],
  owned: boolean,
  pidPresent: boolean,
  workflow: FleetViewEnvelope["projects"][number]["workflow"],
): FleetViewEnvelope["projects"][number] {
  return {
    routeId,
    projectId,
    enabled: true,
    phase,
    owned,
    pidPresent,
    pidAlive: pidPresent,
    nextStartAt: phase === "backoff" ? "2026-08-22T00:01:00.000Z" : null,
    restartCount: phase === "tripped" ? 4 : phase === "backoff" ? 2 : 0,
    restartWindowMs: 300_000,
    lastExitCategory: phase === "backoff" || phase === "tripped" ? "error" : null,
    controller: phase === "running" || phase === "adopted"
      ? controller
      : { health: "down", lease: "absent", heartbeat: "stale", heartbeatAgeMs: 120_000, pidAlive: false },
    workflow,
  };
}

function event(input: Omit<EventEnvelope, "version" | "kind" | "generatedAt" | "fleetId" | "occurredAt" | "actionRequired" | "operatorActionKinds"> & {
  actionRequired?: boolean;
  operatorActionKinds?: EventEnvelope["operatorActionKinds"];
}): EventEnvelope {
  return {
    version: 2,
    kind: "event",
    generatedAt: AT,
    fleetId: "engineering-fleet",
    occurredAt: AT,
    actionRequired: input.actionRequired ?? false,
    operatorActionKinds: input.operatorActionKinds ?? [],
    ...input,
  };
}
