import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { safeCompactionReceipt } from "./adapters/local-evidence.js";
import { digest, type Attempt, type Job, type JobState, type Lane, type ReviewerCheckpointIdentity } from "./model.js";
import type { HarnessConfig } from "./ports.js";
import {
  isSafePiRpcDiagnostic,
  safePiRpcDiagnosticFrom,
  type SafeRuntimeDiagnostic,
} from "./pi-rpc-diagnostics.js";
import { assertReviewerCheckpoint } from "./reviewer-checkpoints.js";

const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_AUDIT_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 10_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const JOB_STATES = new Set<JobState | "done" | "cancelled">([
  "claimed", "worker_ready", "worker_running", "reviewer_ready", "reviewer_running",
  "publish_ready", "awaiting_merge", "blocked", "recovery_approved", "done", "cancelled",
]);
const INCIDENT_CLASSES = new Set([
  "agent_decision", "agent_blocked", "review_uncertain", "reviewer_preflight_dirty",
  "validation_infrastructure", "infrastructure_exhausted", "integrity_violation", "stale_task",
  "ci_failure", "ci_rework_exhausted", "analyst_unavailable",
]);
const PROGRESS_TYPES = new Set([
  "runner_started", "dispatch_accepted", "assistant_message_start", "assistant_message_update",
  "assistant_message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "compaction_start", "compaction_end", "provider_retry_progress", "durable_result", "agent_settled",
  "terminal_receipt", "herdr_output_update",
]);
const SIZE_BUCKETS = new Set(["lt64k", "64k_256k", "256k_1m", "gte1m"]);

export type DiagnosticProject = {
  id: string;
  repo: string;
  stateDir: string;
  redactRepo: boolean;
  redactIssue: boolean;
};

export function diagnosticProject(config: HarnessConfig, projectId?: string): DiagnosticProject {
  const diagnostics = config.diagnostics;
  if (diagnostics !== undefined && (
    !diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)
    || Object.keys(diagnostics).some((key) => !["projectId", "redactRepo", "redactIssue"].includes(key))
    || (diagnostics.projectId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(diagnostics.projectId))
    || (diagnostics.redactRepo !== undefined && typeof diagnostics.redactRepo !== "boolean")
    || (diagnostics.redactIssue !== undefined && typeof diagnostics.redactIssue !== "boolean")
  )) throw new Error("invalid diagnostics config");
  const id = projectId ?? diagnostics?.projectId ?? "single-project";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error("invalid diagnostic project ID");
  return {
    id,
    repo: config.repo,
    stateDir: config.stateDir,
    redactRepo: diagnostics?.redactRepo === true,
    redactIssue: diagnostics?.redactIssue === true,
  };
}

export type AttemptFailureDiagnostic = {
  projectId: string;
  repo: string | null;
  repoRedacted: boolean;
  issueNumber: number | null;
  issueRedacted: boolean;
  jobId: string;
  attemptId: string;
  lane: Lane;
  observedAt: string;
  runtimeAdapter: "herdr-pi-cli" | "pi-rpc" | null;
  provider: string | null;
  model: string | null;
  piVersion: string | null;
  taxonomyDomain: string | null;
  failureDomain: string;
  failureCode: string;
  failureDetailCode: string | null;
  failureStage: string;
  retryable: boolean | null;
  resultPresent: boolean | null;
  terminalPresent: boolean;
  terminalValid: boolean;
  agentSettled: boolean | null;
  lastProgressType: string | null;
  elapsedBucket: string;
  transcriptSizeBucket: string;
  toolCount: number | null;
  toolErrorCount: number | null;
  validationDurationMs: number | null;
  validationDurationBucket: string;
  validationOutputSizeBucket: string;
  axisOutputSizeBucket: string;
  compactionCount: number | null;
  compactionFailure: boolean | null;
  automaticRecoveryCount: number | null;
  jobOutcome: string | null;
  partial: boolean;
  corrupt: boolean;
  partialReasons: string[];
  corruptArtifacts: string[];
};

export type DiagnosticReport = {
  version: 1;
  timeRange: { from: string; to: string; days: number; observedFrom: string | null; observedTo: string | null };
  partial: boolean;
  corrupt: { projects: number; attempts: number; artifacts: number };
  totals: { projects: number; failedAttempts: number; partialAttempts: number; corruptAttempts: number };
  projects: Array<{
    id: string;
    repo: string | null;
    repoRedacted: boolean;
    failedAttempts: number;
    partial: boolean;
    corruptAttempts: number;
    issues: string[];
  }>;
  views: {
    byFailureCode: Record<string, number>;
    byLane: Record<string, number>;
    byProviderModel: Record<string, number>;
    byRuntimeAdapter: Record<string, number>;
    byElapsedBucket: Record<string, number>;
    byContextOutputSize: {
      transcript: Record<string, number>;
      validation: Record<string, number>;
      axis: Record<string, number>;
    };
    byDurableResult: Record<string, number>;
    byCompaction: Record<string, number>;
    byProject: Record<string, number>;
  };
  attempts: AttemptFailureDiagnostic[];
};

type AttemptMetadata = {
  jobId: string;
  attemptId: string;
  lane: Lane;
  issueNumber: number | null;
  startedAt: string | null;
  completedAt: string | null;
  savedAt: string | null;
  runtimeAdapter: AttemptFailureDiagnostic["runtimeAdapter"];
  provider: string | null;
  model: string | null;
  piVersion: string | null;
  resultPresent: boolean | null;
  resultStatus: string | null;
  incidentClass: string | null;
  runtimeDiagnostic: SafeRuntimeDiagnostic | null;
  automaticRecoveryCount: number | null;
  jobOutcome: string | null;
  hasDurableMetadata: boolean;
};

type JobFacts = {
  issueNumber: number | null;
  outcome: string | null;
  finishedAt: string | null;
  automaticRecoveryCount: number | null;
};

type ArtifactFacts = {
  lane: Lane | null;
  terminalPresent: boolean;
  terminalValid: boolean;
  terminalOk: boolean | null;
  terminalDiagnostic: SafeRuntimeDiagnostic | null;
  runtimeAdapter: AttemptFailureDiagnostic["runtimeAdapter"];
  agentSettled: boolean | null;
  resultPresent: boolean | null;
  progressPresent: boolean;
  lastProgressAt: string | null;
  lastProgressType: string | null;
  elapsedMs: number | null;
  transcriptSizeBucket: string | null;
  toolCount: number | null;
  toolErrorCount: number | null;
  validationStatus: string | null;
  validationDurationMs: number | null;
  validationOutputBytes: number | null;
  axisOutputBytes: number | null;
  compactionCount: number | null;
  compactionFailure: boolean | null;
  latestMtime: string | null;
  corruptArtifacts: string[];
};

type ProjectScan = {
  project: DiagnosticProject;
  attempts: AttemptFailureDiagnostic[];
  issues: string[];
};

export function diagnoseProjects(
  projects: DiagnosticProject[],
  options: { days: number; now?: string },
): DiagnosticReport {
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 3_650) {
    throw new Error("--days must be an integer between 1 and 3650");
  }
  const toMs = options.now === undefined ? Date.now() : Date.parse(options.now);
  if (!Number.isFinite(toMs)) throw new Error("diagnostic end time is invalid");
  const fromMs = toMs - options.days * 86_400_000;
  const scans = projects.map((project) => scanProject(project, fromMs, toMs));
  const attempts = scans.flatMap((scan) => scan.attempts).sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.projectId.localeCompare(right.projectId)
    || left.jobId.localeCompare(right.jobId)
    || left.attemptId.localeCompare(right.attemptId)
  ));
  const observed = attempts.map((attempt) => attempt.observedAt).sort();
  const projectReports = scans.map((scan) => {
    const selected = attempts.filter((attempt) => attempt.projectId === scan.project.id);
    return {
      id: scan.project.id,
      repo: scan.project.redactRepo ? null : scan.project.repo,
      repoRedacted: scan.project.redactRepo,
      failedAttempts: selected.length,
      partial: scan.issues.length > 0 || selected.some((attempt) => attempt.partial),
      corruptAttempts: selected.filter((attempt) => attempt.corrupt).length,
      issues: [...new Set(scan.issues)].sort(),
    };
  });
  const corruptArtifacts = attempts.reduce((count, attempt) => count + attempt.corruptArtifacts.length, 0);
  return {
    version: 1,
    timeRange: {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      days: options.days,
      observedFrom: observed[0] ?? null,
      observedTo: observed.at(-1) ?? null,
    },
    partial: projectReports.some((project) => project.partial),
    corrupt: {
      projects: projectReports.filter((project) => (
        project.corruptAttempts > 0 || project.issues.some((issue) => issue.includes("corrupt"))
      )).length,
      attempts: attempts.filter((attempt) => attempt.corrupt).length,
      artifacts: corruptArtifacts,
    },
    totals: {
      projects: projects.length,
      failedAttempts: attempts.length,
      partialAttempts: attempts.filter((attempt) => attempt.partial).length,
      corruptAttempts: attempts.filter((attempt) => attempt.corrupt).length,
    },
    projects: projectReports,
    views: {
      byFailureCode: counts(attempts, (attempt) => attempt.failureCode),
      byLane: counts(attempts, (attempt) => attempt.lane),
      byProviderModel: counts(attempts, (attempt) => `${attempt.provider ?? "unknown"}/${attempt.model ?? "unknown"}`),
      byRuntimeAdapter: counts(attempts, (attempt) => attempt.runtimeAdapter ?? "unknown"),
      byElapsedBucket: counts(attempts, (attempt) => attempt.elapsedBucket),
      byContextOutputSize: {
        transcript: counts(attempts, (attempt) => attempt.transcriptSizeBucket),
        validation: counts(attempts, (attempt) => attempt.validationOutputSizeBucket),
        axis: counts(attempts, (attempt) => attempt.axisOutputSizeBucket),
      },
      byDurableResult: counts(attempts, (attempt) => attempt.resultPresent === null
        ? "unknown"
        : attempt.resultPresent ? "present" : "missing"),
      byCompaction: counts(attempts, (attempt) => attempt.compactionCount === null
        ? "unknown"
        : attempt.compactionFailure ? "failed" : attempt.compactionCount > 0 ? "completed" : "none"),
      byProject: counts(attempts, (attempt) => attempt.projectId),
    },
    attempts,
  };
}

export function aggregateDiagnosticOutput(report: DiagnosticReport): Omit<DiagnosticReport, "attempts"> {
  const { attempts: _attempts, ...aggregate } = report;
  return aggregate;
}

/** Safe, content-free projection appended to the existing best-effort audit log. */
export function diagnosticAuditProjection(job: Job | null): Record<string, unknown> | null {
  const attempt = job?.activeAttempt;
  const incident = job?.incident;
  if (!job || !attempt) return null;
  const snapshot = attempt.executionSnapshot;
  return {
    version: 1,
    jobId: boundedLabel(job.id, 256),
    issueNumber: safeInteger(job.task.issueNumber),
    jobState: job.state,
    automaticRecoveryCount: Math.min(job.automaticRecoveries?.length ?? 0, 32),
    attempt: {
      id: boundedLabel(attempt.id, 256),
      lane: attempt.lane,
      phase: attempt.phase,
      startedAt: validTime(attempt.startedAt),
      completedAt: validTime(attempt.completedAt),
      resultPresent: attempt.result !== null,
      resultStatus: attemptResultStatus(attempt),
      runtimeAdapter: snapshot?.adapter ?? null,
      piVersion: boundedLabel(snapshot?.runtimeVersion, 64),
      providerId: runtimeIdentity(snapshot?.provider, "provider"),
      modelId: runtimeIdentity(snapshot?.model, "model"),
    },
    incident: incident?.attemptId === attempt.id ? {
      class: incident.class,
      lane: incident.lane,
      runtimeDiagnostic: incident.runtimeDiagnostic ?? null,
    } : null,
  };
}

function scanProject(project: DiagnosticProject, fromMs: number, toMs: number): ProjectScan {
  const metadata = new Map<string, AttemptMetadata>();
  const jobs = new Map<string, JobFacts>();
  const issues: string[] = [];
  readAudit(project.stateDir, metadata, jobs, issues);
  readState(project.stateDir, metadata, jobs, issues);
  const artifactAttempts = scanAttemptTrees(project.stateDir, issues);
  const keys = new Set([...artifactAttempts.keys(), ...metadata.keys()]);
  const attempts: AttemptFailureDiagnostic[] = [];
  for (const key of keys) {
    const artifacts = artifactAttempts.get(key) ?? emptyArtifacts();
    const meta = metadata.get(key);
    const [jobId = "", attemptId = ""] = key.split("\0");
    const lane = meta?.lane ?? artifacts.lane;
    if (!lane || !SAFE_ID.test(jobId) || !SAFE_ID.test(attemptId)) continue;
    const failure = classifyFailure(meta, artifacts);
    if (!failure) continue;
    const job = jobs.get(jobId);
    const observed = observedAt(meta, artifacts, job);
    if (!observed || Date.parse(observed.value) < fromMs || Date.parse(observed.value) > toMs) continue;
    const runtimeAdapter = meta?.runtimeAdapter ?? artifacts.runtimeAdapter;
    const resultPresent = artifacts.resultPresent ?? meta?.resultPresent ?? null;
    const automaticRecoveryCount = maxNullable(meta?.automaticRecoveryCount ?? null, job?.automaticRecoveryCount ?? null);
    const partialReasons = [
      ...artifacts.corruptArtifacts.map(() => "corrupt-artifact"),
      ...(!meta?.hasDurableMetadata ? ["attempt-metadata-missing"] : []),
      ...(runtimeAdapter === null || meta?.piVersion === null || meta === undefined ? ["runtime-metadata-missing"] : []),
      ...(runtimeAdapter === "pi-rpc" && !artifacts.terminalPresent ? ["terminal-missing"] : []),
      ...(!artifacts.terminalPresent && !artifacts.progressPresent ? ["runtime-receipts-missing"] : []),
      ...(automaticRecoveryCount === null ? ["automatic-recovery-count-missing"] : []),
      ...((job?.outcome ?? meta?.jobOutcome ?? null) === null ? ["job-outcome-missing"] : []),
      ...(observed.source === "filesystem" ? ["time-from-filesystem"] : []),
    ];
    attempts.push({
      projectId: project.id,
      repo: project.redactRepo ? null : project.repo,
      repoRedacted: project.redactRepo,
      issueNumber: project.redactIssue ? null : (meta?.issueNumber ?? job?.issueNumber ?? null),
      issueRedacted: project.redactIssue,
      jobId,
      attemptId,
      lane,
      observedAt: observed.value,
      runtimeAdapter,
      provider: meta?.provider ?? null,
      model: meta?.model ?? null,
      piVersion: meta?.piVersion ?? null,
      taxonomyDomain: failure.taxonomyDomain,
      failureDomain: failure.domain,
      failureCode: failure.code,
      failureDetailCode: failure.detailCode,
      failureStage: failure.stage,
      retryable: failure.retryable,
      resultPresent,
      terminalPresent: artifacts.terminalPresent,
      terminalValid: artifacts.terminalValid,
      agentSettled: artifacts.agentSettled,
      lastProgressType: artifacts.lastProgressType,
      elapsedBucket: elapsedBucket(artifacts.elapsedMs ?? elapsedBetween(meta?.startedAt, meta?.completedAt)),
      transcriptSizeBucket: artifacts.transcriptSizeBucket ?? "unknown",
      toolCount: artifacts.toolCount,
      toolErrorCount: artifacts.toolErrorCount,
      validationDurationMs: artifacts.validationDurationMs,
      validationDurationBucket: elapsedBucket(artifacts.validationDurationMs),
      validationOutputSizeBucket: sizeBucket(artifacts.validationOutputBytes),
      axisOutputSizeBucket: sizeBucket(artifacts.axisOutputBytes),
      compactionCount: artifacts.compactionCount,
      compactionFailure: artifacts.compactionFailure,
      automaticRecoveryCount,
      jobOutcome: job?.outcome ?? meta?.jobOutcome ?? null,
      partial: partialReasons.length > 0,
      corrupt: artifacts.corruptArtifacts.length > 0,
      partialReasons: [...new Set(partialReasons)].sort(),
      corruptArtifacts: [...new Set(artifacts.corruptArtifacts)].sort(),
    });
  }
  return { project, attempts, issues };
}

function readState(
  stateDir: string,
  metadata: Map<string, AttemptMetadata>,
  jobs: Map<string, JobFacts>,
  issues: string[],
): void {
  const artifact = readJsonArtifact(join(stateDir, "state.json"), MAX_STATE_BYTES);
  if (artifact.status === "missing") {
    issues.push("state-missing");
    return;
  }
  if (artifact.status === "corrupt") {
    issues.push("state-corrupt");
    return;
  }
  const root = object(artifact.value);
  if (root.version !== 1 || !Array.isArray(root.terminalJobs) || (root.activeJob !== null && !objectOrNull(root.activeJob))) {
    issues.push("state-corrupt");
    return;
  }
  for (const terminalValue of root.terminalJobs) {
    const terminal = object(terminalValue);
    const id = safeId(terminal.id);
    const outcome = jobOutcome(terminal.state);
    if (!id || (outcome !== "done" && outcome !== "cancelled")) {
      issues.push("state-terminal-job-corrupt");
      continue;
    }
    mergeJobFacts(jobs, id, {
      issueNumber: safeInteger(terminal.issueNumber),
      outcome,
      finishedAt: validTime(terminal.finishedAt),
      automaticRecoveryCount: null,
    });
  }
  if (root.activeJob === null) return;
  const job = object(root.activeJob);
  const jobId = safeId(job.id);
  const outcome = jobOutcome(job.state);
  const task = object(job.task);
  if (!jobId || !outcome) {
    issues.push("state-active-job-corrupt");
    return;
  }
  const automaticRecoveryCount = Array.isArray(job.automaticRecoveries)
    ? Math.min(job.automaticRecoveries.length, 32)
    : job.automaticRecoveries === undefined ? 0 : null;
  const jobFact: JobFacts = {
    issueNumber: safeInteger(task.issueNumber),
    outcome,
    finishedAt: validTime(job.updatedAt),
    automaticRecoveryCount,
  };
  mergeJobFacts(jobs, jobId, jobFact);
  const incident = job.incident === null
    ? null
    : objectOrNull(job.incident) ? object(job.incident) : null;
  const attemptValues = Array.isArray(job.attempts) ? [...job.attempts] : [];
  if (job.activeAttempt !== null && job.activeAttempt !== undefined) attemptValues.push(job.activeAttempt);
  for (const value of attemptValues) {
    const attempt = object(value);
    const attemptId = safeId(attempt.id);
    const lane = safeLane(attempt.lane);
    if (!attemptId || !lane) {
      issues.push("state-attempt-corrupt");
      continue;
    }
    const snapshot = objectOrNull(attempt.executionSnapshot) ? object(attempt.executionSnapshot) : null;
    const result = objectOrNull(attempt.result) ? object(attempt.result) : null;
    const incidentMatches = incident?.attemptId === attemptId;
    mergeMetadata(metadata, {
      jobId,
      attemptId,
      lane,
      issueNumber: jobFact.issueNumber,
      startedAt: validTime(attempt.startedAt),
      completedAt: validTime(attempt.completedAt),
      savedAt: validTime(job.updatedAt),
      runtimeAdapter: safeAdapter(snapshot?.adapter),
      provider: runtimeIdentity(snapshot?.provider, "provider"),
      model: runtimeIdentity(snapshot?.model, "model"),
      piVersion: boundedLabel(snapshot?.runtimeVersion, 64),
      resultPresent: attempt.result === null ? false : result === null ? null : true,
      resultStatus: boundedLabel(result?.status, 64),
      incidentClass: incidentMatches && INCIDENT_CLASSES.has(String(incident?.class)) ? String(incident?.class) : null,
      runtimeDiagnostic: incidentMatches && isSafePiRpcDiagnostic(incident?.runtimeDiagnostic)
        ? incident.runtimeDiagnostic
        : null,
      automaticRecoveryCount,
      jobOutcome: outcome,
      hasDurableMetadata: true,
    });
  }
}

function readAudit(
  stateDir: string,
  metadata: Map<string, AttemptMetadata>,
  jobs: Map<string, JobFacts>,
  issues: string[],
): void {
  const tail = readFileTail(join(stateDir, "events.jsonl"), MAX_AUDIT_BYTES);
  if (tail.status === "missing") {
    issues.push("audit-missing");
    return;
  }
  if (tail.status === "corrupt") {
    issues.push("audit-corrupt");
    return;
  }
  if (tail.truncated) issues.push("audit-partial");
  for (const line of tail.text.split(/\r?\n/).filter(Boolean)) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      issues.push("audit-record-corrupt");
      continue;
    }
    const event = object(value);
    const savedAt = validTime(event.savedAt);
    const activeJobId = safeId(event.activeJobId);
    const outcome = jobOutcome(event.activeState);
    const automaticRecoveryCount = boundedCount(event.automaticRecoveryCount, 32);
    if (activeJobId && outcome) {
      mergeJobFacts(jobs, activeJobId, {
        issueNumber: null,
        outcome,
        finishedAt: savedAt,
        automaticRecoveryCount,
      });
    }
    if (event.attemptDiagnostic === undefined) continue;
    const projection = parseAuditProjection(event.attemptDiagnostic, savedAt);
    if (!projection) {
      issues.push("audit-attempt-corrupt");
      continue;
    }
    mergeMetadata(metadata, projection);
    mergeJobFacts(jobs, projection.jobId, {
      issueNumber: projection.issueNumber,
      outcome: projection.jobOutcome,
      finishedAt: projection.savedAt,
      automaticRecoveryCount: projection.automaticRecoveryCount,
    });
  }
}

function parseAuditProjection(value: unknown, savedAt: string | null): AttemptMetadata | null {
  const projection = object(value);
  const attempt = object(projection.attempt);
  const incident = projection.incident === null ? null : object(projection.incident);
  const jobId = safeId(projection.jobId);
  const attemptId = safeId(attempt.id);
  const lane = safeLane(attempt.lane);
  const outcome = jobOutcome(projection.jobState);
  const runtimeDiagnostic = incident === null || incident.runtimeDiagnostic === null
    ? null
    : isSafePiRpcDiagnostic(incident.runtimeDiagnostic) ? incident.runtimeDiagnostic : undefined;
  if (projection.version !== 1 || !jobId || !attemptId || !lane || !outcome || runtimeDiagnostic === undefined
    || (incident !== null && (incident.lane !== lane || !INCIDENT_CLASSES.has(String(incident.class))))) return null;
  return {
    jobId,
    attemptId,
    lane,
    issueNumber: safeInteger(projection.issueNumber),
    startedAt: validTime(attempt.startedAt),
    completedAt: validTime(attempt.completedAt),
    savedAt,
    runtimeAdapter: safeAdapter(attempt.runtimeAdapter),
    provider: storedRuntimeIdentity(attempt.providerId),
    model: storedRuntimeIdentity(attempt.modelId),
    piVersion: boundedLabel(attempt.piVersion, 64),
    resultPresent: typeof attempt.resultPresent === "boolean" ? attempt.resultPresent : null,
    resultStatus: boundedLabel(attempt.resultStatus, 64),
    incidentClass: incident === null ? null : String(incident.class),
    runtimeDiagnostic,
    automaticRecoveryCount: boundedCount(projection.automaticRecoveryCount, 32),
    jobOutcome: outcome,
    hasDurableMetadata: true,
  };
}

function scanAttemptTrees(stateDir: string, issues: string[]): Map<string, ArtifactFacts> {
  const attempts = new Map<string, ArtifactFacts>();
  let count = 0;
  for (const lane of ["worker", "reviewer"] as const) {
    const laneRoot = join(stateDir, `${lane}-attempts`);
    for (const jobId of safeDirectories(laneRoot, issues, "attempt-tree-corrupt")) {
      for (const attemptId of safeDirectories(join(laneRoot, jobId), issues, "attempt-tree-corrupt")) {
        count += 1;
        if (count > MAX_ATTEMPTS) {
          issues.push("attempt-tree-partial");
          return attempts;
        }
        const key = attemptKey(jobId, attemptId);
        const facts = scanArtifacts(join(laneRoot, jobId, attemptId), jobId, attemptId, lane);
        attempts.set(key, facts);
      }
    }
  }
  return attempts;
}

function scanArtifacts(root: string, jobId: string, attemptId: string, lane: Lane): ArtifactFacts {
  const facts = emptyArtifacts();
  facts.lane = lane;
  const terminal = readJsonArtifact(join(root, "runtime", "terminal.json"), MAX_RECEIPT_BYTES);
  if (terminal.status !== "missing") facts.terminalPresent = true;
  if (terminal.status === "corrupt") {
    facts.latestMtime = latestTime(facts.latestMtime, terminal.mtime);
    facts.corruptArtifacts.push("terminal.json");
  }
  if (terminal.status === "ok") {
    facts.latestMtime = latestTime(facts.latestMtime, terminal.mtime);
    const receipt = object(terminal.value);
    if (receipt.attemptId !== attemptId || typeof receipt.ok !== "boolean") {
      facts.corruptArtifacts.push("terminal.json");
    } else {
      try {
        facts.terminalDiagnostic = safePiRpcDiagnosticFrom(receipt);
        facts.terminalValid = true;
        facts.terminalOk = receipt.ok;
        facts.runtimeAdapter = safeAdapter(receipt.adapter)
          ?? (typeof receipt.generation === "string" && typeof receipt.planDigest === "string" ? "pi-rpc" : null);
        facts.agentSettled = typeof receipt.agentSettled === "boolean" ? receipt.agentSettled : null;
        facts.resultPresent = typeof receipt.durableResultPresent === "boolean" ? receipt.durableResultPresent : null;
        facts.transcriptSizeBucket = SIZE_BUCKETS.has(String(receipt.transcriptSizeBucket))
          ? String(receipt.transcriptSizeBucket)
          : null;
        facts.toolCount = boundedCount(receipt.toolExecutionCount);
        facts.toolErrorCount = boundedCount(receipt.toolErrorCount);
        if (receipt.controlledCompaction !== undefined) {
          const compaction = safeCompactionReceipt(receipt.controlledCompaction);
          if (!compaction) facts.corruptArtifacts.push("terminal.controlledCompaction");
          else {
            facts.compactionCount = Number(compaction.count);
            facts.compactionFailure = compaction.outcome === "failed";
          }
        } else {
          facts.compactionCount = 0;
          facts.compactionFailure = facts.terminalDiagnostic?.failureDomain === "compaction";
        }
      } catch {
        facts.corruptArtifacts.push("terminal.json");
      }
    }
  }
  const progress = readJsonArtifact(join(root, "runtime", "runtime-progress.json"), MAX_RECEIPT_BYTES);
  if (progress.status !== "missing") facts.progressPresent = true;
  if (progress.status === "corrupt") {
    facts.latestMtime = latestTime(facts.latestMtime, progress.mtime);
    facts.corruptArtifacts.push("runtime-progress.json");
  }
  if (progress.status === "ok") {
    facts.latestMtime = latestTime(facts.latestMtime, progress.mtime);
    const receipt = object(progress.value);
    if (receipt.attemptId !== attemptId
      || !validTime(receipt.lastProgressAt)
      || typeof receipt.lastProgressType !== "string"
      || !PROGRESS_TYPES.has(receipt.lastProgressType)
      || boundedCount(receipt.elapsedMs) === null
      || typeof receipt.resultPresent !== "boolean") {
      facts.corruptArtifacts.push("runtime-progress.json");
    } else {
      facts.lastProgressAt = validTime(receipt.lastProgressAt);
      facts.lastProgressType = String(receipt.lastProgressType);
      facts.elapsedMs = Number(receipt.elapsedMs);
      facts.resultPresent ??= receipt.resultPresent;
      facts.runtimeAdapter ??= safeAdapter(receipt.adapter)
        ?? (typeof receipt.generation === "string" && typeof receipt.planDigest === "string" ? "pi-rpc" : null);
    }
  }
  if (lane === "reviewer") readReviewerArtifacts(root, jobId, attemptId, facts);
  if (facts.latestMtime === null && facts.corruptArtifacts.length > 0) {
    try {
      facts.latestMtime = new Date(statSync(root).mtimeMs).toISOString();
    } catch {
      // The corrupt Attempt remains isolated; without any time fact it is excluded from a bounded window.
    }
  }
  return facts;
}

function readReviewerArtifacts(root: string, jobId: string, attemptId: string, facts: ArtifactFacts): void {
  const validation = readCheckpoint(root, jobId, attemptId, "validation");
  if (validation.status === "corrupt") facts.corruptArtifacts.push("validation-receipt.json");
  if (validation.status === "ok" && validation.checkpoint.stage === "validation") {
    facts.latestMtime = latestTime(facts.latestMtime, validation.mtime);
    const result = validation.checkpoint.result;
    facts.validationStatus = result.status;
    facts.validationDurationMs = result.durationMs;
    facts.validationOutputBytes = result.stdout.byteCount + result.stderr.byteCount;
  }
  const axisBytes: number[] = [];
  for (const stage of ["standards-axis", "spec-axis"] as const) {
    const axis = readCheckpoint(root, jobId, attemptId, stage);
    if (axis.status === "corrupt") facts.corruptArtifacts.push(`${stage}.json`);
    if (axis.status === "ok" && (axis.checkpoint.stage === "standards-axis" || axis.checkpoint.stage === "spec-axis")) {
      facts.latestMtime = latestTime(facts.latestMtime, axis.mtime);
      axisBytes.push(axis.checkpoint.result.outputByteCount);
    }
  }
  facts.axisOutputBytes = axisBytes.length > 0 ? Math.max(...axisBytes) : null;
}

function readCheckpoint(
  root: string,
  jobId: string,
  attemptId: string,
  stage: "validation" | "standards-axis" | "spec-axis",
): { status: "missing" | "corrupt" } | { status: "ok"; checkpoint: import("./model.js").ReviewerCheckpoint; mtime: string } {
  const name = stage === "validation" ? "validation-receipt.json" : `${stage}.json`;
  const artifact = readJsonArtifact(join(root, name), MAX_RECEIPT_BYTES);
  if (artifact.status !== "ok") return artifact;
  const value = object(artifact.value);
  const identity = checkpointIdentity(value);
  if (!identity || identity.jobId !== jobId || identity.sourceAttemptId !== attemptId) return { status: "corrupt" };
  try {
    assertReviewerCheckpoint(artifact.value, identity, stage);
    return { status: "ok", checkpoint: artifact.value, mtime: artifact.mtime };
  } catch {
    return { status: "corrupt" };
  }
}

function checkpointIdentity(value: Record<string, unknown>): ReviewerCheckpointIdentity | null {
  const jobId = safeId(value.jobId);
  const sourceAttemptId = safeId(value.sourceAttemptId);
  if (!jobId || !sourceAttemptId || !Number.isInteger(value.jobRevision)) return null;
  const digests = ["taskDigest", "runtimeDigest", "providerDigest", "modelDigest", "resourceDigest", "repositoryContextBundleDigest"] as const;
  if (digests.some((key) => typeof value[key] !== "string" || !/^[0-9a-f]{64}$/i.test(value[key] as string))) return null;
  if (typeof value.baseSha !== "string" || !/^[0-9a-f]{40}$/i.test(value.baseSha)
    || typeof value.reviewedHeadSha !== "string" || !/^[0-9a-f]{40}$/i.test(value.reviewedHeadSha)) return null;
  return {
    jobId,
    sourceAttemptId,
    jobRevision: Number(value.jobRevision),
    taskDigest: value.taskDigest as string,
    baseSha: value.baseSha,
    reviewedHeadSha: value.reviewedHeadSha,
    runtimeDigest: value.runtimeDigest as string,
    providerDigest: value.providerDigest as string,
    modelDigest: value.modelDigest as string,
    resourceDigest: value.resourceDigest as string,
    repositoryContextBundleDigest: value.repositoryContextBundleDigest as string,
  };
}

function classifyFailure(meta: AttemptMetadata | undefined, facts: ArtifactFacts): {
  taxonomyDomain: string | null;
  domain: string;
  code: string;
  detailCode: string | null;
  stage: string;
  retryable: boolean | null;
} | null {
  const diagnostic = facts.terminalOk === false && facts.terminalDiagnostic
    ? facts.terminalDiagnostic
    : meta?.runtimeDiagnostic ?? null;
  if (diagnostic) return failureFromRuntime(diagnostic);
  if (facts.terminalOk === false) return unknownFailure("runtime-terminal");
  if (facts.validationStatus === "failed-checks") {
    return { taxonomyDomain: "deterministic", domain: "validation", code: "validation_failed", detailCode: "validation_failed", stage: "review-validation", retryable: false };
  }
  if (facts.validationStatus === "infrastructure-error") {
    return { taxonomyDomain: "acceptance", domain: "validation", code: "validation_infrastructure", detailCode: "validation_infrastructure", stage: "review-validation", retryable: false };
  }
  if (meta?.resultStatus === "failed" || meta?.resultStatus === "blocked") {
    return {
      taxonomyDomain: "execution",
      domain: "model",
      code: meta.resultStatus === "failed" ? "model_failed" : "model_blocked",
      detailCode: meta.resultStatus,
      stage: meta.lane === "reviewer" ? "review-axis" : "result-validation",
      retryable: false,
    };
  }
  if (meta?.incidentClass) return failureFromIncident(meta.incidentClass, meta.lane);
  if (facts.corruptArtifacts.includes("terminal.json") || facts.corruptArtifacts.includes("validation-receipt.json")) {
    return unknownFailure("corrupt-receipt");
  }
  return null;
}

function failureFromRuntime(diagnostic: SafeRuntimeDiagnostic) {
  return {
    taxonomyDomain: diagnostic.domain ?? null,
    domain: failureSource(diagnostic.failureDomain),
    code: diagnostic.code ?? diagnostic.failureCode,
    detailCode: diagnostic.failureCode,
    stage: diagnostic.stage ?? diagnostic.failureStage ?? "unknown",
    retryable: diagnostic.retryable,
  };
}

function failureFromIncident(incident: string, lane: Lane) {
  if (["agent_decision", "agent_blocked", "review_uncertain"].includes(incident)) {
    return { taxonomyDomain: "execution", domain: "model", code: incident, detailCode: incident, stage: lane === "reviewer" ? "review-axis" : "result-validation", retryable: false };
  }
  if (incident === "validation_infrastructure") {
    return { taxonomyDomain: "acceptance", domain: "validation", code: incident, detailCode: incident, stage: "review-validation", retryable: false };
  }
  return { taxonomyDomain: "execution", domain: "harness_policy", code: incident, detailCode: incident, stage: "controller", retryable: false };
}

function unknownFailure(stage: string) {
  return { taxonomyDomain: null, domain: "unknown", code: "unknown", detailCode: null, stage, retryable: null };
}

function failureSource(value: SafeRuntimeDiagnostic["failureDomain"]): string {
  if (value === "rpc_protocol" || value === "rpc_transport") return "rpc";
  if (value === "policy" || value === "tool") return "harness_policy";
  if (value === "runner_internal") return "runtime";
  return value;
}

function mergeMetadata(target: Map<string, AttemptMetadata>, incoming: AttemptMetadata): void {
  const key = attemptKey(incoming.jobId, incoming.attemptId);
  const current = target.get(key);
  if (!current) {
    target.set(key, incoming);
    return;
  }
  target.set(key, {
    ...current,
    issueNumber: incoming.issueNumber ?? current.issueNumber,
    startedAt: incoming.startedAt ?? current.startedAt,
    completedAt: incoming.completedAt ?? current.completedAt,
    savedAt: latestTime(current.savedAt, incoming.savedAt),
    runtimeAdapter: incoming.runtimeAdapter ?? current.runtimeAdapter,
    provider: incoming.provider ?? current.provider,
    model: incoming.model ?? current.model,
    piVersion: incoming.piVersion ?? current.piVersion,
    resultPresent: incoming.resultPresent ?? current.resultPresent,
    resultStatus: incoming.resultStatus ?? current.resultStatus,
    incidentClass: incoming.incidentClass ?? current.incidentClass,
    runtimeDiagnostic: incoming.runtimeDiagnostic ?? current.runtimeDiagnostic,
    automaticRecoveryCount: maxNullable(current.automaticRecoveryCount, incoming.automaticRecoveryCount),
    jobOutcome: incoming.jobOutcome ?? current.jobOutcome,
    hasDurableMetadata: current.hasDurableMetadata || incoming.hasDurableMetadata,
  });
}

function mergeJobFacts(target: Map<string, JobFacts>, jobId: string, incoming: JobFacts): void {
  const current = target.get(jobId);
  target.set(jobId, current ? {
    issueNumber: incoming.issueNumber ?? current.issueNumber,
    outcome: incoming.outcome ?? current.outcome,
    finishedAt: latestTime(current.finishedAt, incoming.finishedAt),
    automaticRecoveryCount: maxNullable(current.automaticRecoveryCount, incoming.automaticRecoveryCount),
  } : incoming);
}

function counts<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const result = new Map<string, number>();
  for (const value of values) {
    const name = key(value);
    result.set(name, (result.get(name) ?? 0) + 1);
  }
  return Object.fromEntries([...result].sort(([left], [right]) => left.localeCompare(right)));
}

function emptyArtifacts(): ArtifactFacts {
  return {
    lane: null,
    terminalPresent: false,
    terminalValid: false,
    terminalOk: null,
    terminalDiagnostic: null,
    runtimeAdapter: null,
    agentSettled: null,
    resultPresent: null,
    progressPresent: false,
    lastProgressAt: null,
    lastProgressType: null,
    elapsedMs: null,
    transcriptSizeBucket: null,
    toolCount: null,
    toolErrorCount: null,
    validationStatus: null,
    validationDurationMs: null,
    validationOutputBytes: null,
    axisOutputBytes: null,
    compactionCount: null,
    compactionFailure: null,
    latestMtime: null,
    corruptArtifacts: [],
  };
}

function attemptKey(jobId: string, attemptId: string): string {
  return `${jobId}\0${attemptId}`;
}

function observedAt(
  meta: AttemptMetadata | undefined,
  facts: ArtifactFacts,
  job: JobFacts | undefined,
): { value: string; source: "durable" | "filesystem" } | null {
  for (const value of [meta?.completedAt, meta?.savedAt, facts.lastProgressAt, job?.finishedAt, meta?.startedAt]) {
    const time = validTime(value);
    if (time) return { value: time, source: "durable" };
  }
  return facts.latestMtime ? { value: facts.latestMtime, source: "filesystem" } : null;
}

function elapsedBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function elapsedBucket(milliseconds: number | null): string {
  if (milliseconds === null) return "unknown";
  if (milliseconds < 60_000) return "lt1m";
  if (milliseconds < 5 * 60_000) return "1m_5m";
  if (milliseconds < 15 * 60_000) return "5m_15m";
  if (milliseconds < 60 * 60_000) return "15m_60m";
  return "gte60m";
}

function sizeBucket(bytes: number | null): string {
  if (bytes === null) return "unknown";
  if (bytes < 64 * 1024) return "lt64k";
  if (bytes < 256 * 1024) return "64k_256k";
  if (bytes < 1024 * 1024) return "256k_1m";
  return "gte1m";
}

function safeDirectories(path: string, issues: string[], issue: string): string[] {
  if (!existsSync(path)) return [];
  try {
    if (!lstatSync(path).isDirectory()) throw new Error("not a directory");
    const directories: string[] = [];
    for (const entry of readdirSync(path)) {
      try {
        if (!SAFE_ID.test(entry) || !lstatSync(join(path, entry)).isDirectory()) {
          issues.push(issue);
          continue;
        }
        directories.push(entry);
      } catch {
        issues.push(issue);
      }
    }
    return directories.sort();
  } catch {
    issues.push(issue);
    return [];
  }
}

type JsonArtifact =
  | { status: "missing" }
  | { status: "corrupt"; mtime: string | null }
  | { status: "ok"; value: unknown; mtime: string };

function readJsonArtifact(path: string, maxBytes: number): JsonArtifact {
  if (!existsSync(path)) return { status: "missing" };
  let mtime: string | null = null;
  try {
    if (!lstatSync(path).isFile()) return { status: "corrupt", mtime };
    const stat = statSync(path);
    mtime = new Date(stat.mtimeMs).toISOString();
    if (stat.size > maxBytes) return { status: "corrupt", mtime };
    return { status: "ok", value: JSON.parse(readFileSync(path, "utf8")) as unknown, mtime };
  } catch {
    return { status: "corrupt", mtime };
  }
}

type FileTail =
  | { status: "missing" }
  | { status: "corrupt" }
  | { status: "ok"; text: string; truncated: boolean };

function readFileTail(path: string, maxBytes: number): FileTail {
  if (!existsSync(path)) return { status: "missing" };
  let descriptor: number | null = null;
  try {
    if (!lstatSync(path).isFile()) return { status: "corrupt" };
    const stat = statSync(path);
    if (stat.size <= maxBytes) return { status: "ok", text: readFileSync(path, "utf8"), truncated: false };
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(maxBytes);
    readSync(descriptor, buffer, 0, maxBytes, stat.size - maxBytes);
    const text = buffer.toString("utf8");
    const firstNewline = text.indexOf("\n");
    return { status: "ok", text: firstNewline < 0 ? "" : text.slice(firstNewline + 1), truncated: true };
  } catch {
    return { status: "corrupt" };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function objectOrNull(value: unknown): value is Record<string, unknown> | null {
  return value === null || (typeof value === "object" && !Array.isArray(value));
}

function safeId(value: unknown): string | null {
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

function safeLane(value: unknown): Lane | null {
  return value === "worker" || value === "reviewer" ? value : null;
}

function safeAdapter(value: unknown): AttemptFailureDiagnostic["runtimeAdapter"] {
  return value === "herdr-pi-cli" || value === "pi-rpc" ? value : null;
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function boundedCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  const count = safeInteger(value);
  return count !== null && count <= maximum ? count : null;
}

function boundedLabel(value: unknown, maxBytes: number): string | null {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !/[\0\r\n]/.test(value)
    ? value
    : null;
}

function runtimeIdentity(value: unknown, kind: "provider" | "model"): string | null {
  const label = boundedLabel(value, 256);
  return label === null ? null : `sha256:${digest({ kind, value: label })}`;
}

function storedRuntimeIdentity(value: unknown): string | null {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value) ? value : null;
}

function validTime(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null;
}

function jobOutcome(value: unknown): string | null {
  return typeof value === "string" && JOB_STATES.has(value as JobState) ? value : null;
}

function attemptResultStatus(attempt: Attempt): string | null {
  return boundedLabel(attempt.result?.status, 64);
}

function latestTime(left: string | null | undefined, right: string | null | undefined): string | null {
  const first = validTime(left);
  const second = validTime(right);
  if (!first) return second;
  if (!second) return first;
  return Date.parse(second) > Date.parse(first) ? second : first;
}

function maxNullable(left: number | null, right: number | null): number | null {
  return left === null ? right : right === null ? left : Math.max(left, right);
}
