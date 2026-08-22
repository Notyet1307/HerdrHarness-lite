import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "./model.js";
import {
  classifyProviderContinuationLost,
  classifyProviderFailure,
  isSafePiRpcDiagnostic,
  type SafeRuntimeDiagnostic,
} from "./pi-rpc-diagnostics.js";
import { readJsonIfExists, sameJson, writeAtomicJson, writeExclusiveJson } from "./pi-rpc-spool.js";

export const CANARY_TASKS = [
  "short-change",
  "medium-change",
  "long-tools",
  "reviewer-exact-head",
  "validation-long",
  "validation-large-output",
  "provider-network-fault",
  "provider-continuation-lost",
] as const;

export type CanaryTask = typeof CANARY_TASKS[number];
export type CanaryGroup = "serial" | "stress";
export type CanaryProvider = "openai-oauth" | "custom-api-key";
export type CanaryExecution = "live" | "simulated" | "unsupported";

export type CanaryCell = {
  group: CanaryGroup;
  lane: "worker" | "reviewer";
  runtime: "herdr-pi-cli" | "pi-rpc";
  provider: CanaryProvider;
  credentialMode: "canonical-oauth" | "canonical-model-config";
  axisConcurrency: 1 | 2 | null;
  compaction: "runtime-default" | "disabled" | "controlled-threshold";
  task: CanaryTask;
  execution: CanaryExecution;
  unsupportedReason: string | null;
};

export type CanaryUnit = CanaryCell & {
  id: string;
  repetition: number;
};

export type CanaryFailure = SafeRuntimeDiagnostic & Required<Pick<SafeRuntimeDiagnostic, "domain" | "code" | "stage">>;

export type CanaryUnitResult = {
  version: 1;
  unit: CanaryUnit;
  evidence: "measured" | "simulated" | "unsupported";
  outcome: "passed" | "failed" | "simulated-failure" | "unsupported";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  resultPresent: boolean | null;
  terminalObserved: boolean | null;
  validationRan: boolean;
  validationDurationMs: number | null;
  validationOutputBytes: number | null;
  compactionCount: number | null;
  failure: CanaryFailure | null;
};

export interface CanaryExecutor {
  execute(unit: CanaryUnit, unitDir: string): Promise<CanaryUnitResult>;
}

export type BinomialRate = {
  numerator: number;
  denominator: number;
  rate: number | null;
  confidence95: { low: number; high: number } | null;
};

export type CanaryComparison = {
  baseline: { label: string; failures: BinomialRate; duration: DurationSummary };
  candidate: { label: string; failures: BinomialRate; duration: DurationSummary };
  incrementalFailure: number | null;
  confidence95: { low: number; high: number } | null;
};

export type DurationSummary = {
  samples: number;
  medianMs: number | null;
  p90Ms: number | null;
};

export type CanaryReport = {
  version: 1;
  generatedAt: string;
  configDigest: string;
  repetitions: number;
  partial: boolean;
  totals: {
    planned: number;
    completed: number;
    measured: number;
    passed: number;
    failed: number;
    simulated: number;
    unsupported: number;
  };
  assumptions: string[];
  observations: {
    workerVsReviewer: {
      worker: BinomialRate;
      reviewer: BinomialRate;
      observedHigherFailureLane: "worker" | "reviewer" | "tie" | "insufficient";
    };
    rpcVsInteractive: CanaryComparison;
    oauthVsCustomProvider: CanaryComparison;
    validationContinuationFailures: BinomialRate;
    resultPresentObservationFailures: BinomialRate;
    compactionOnLongTasks: CanaryComparison;
    controlledCompactionTriggered: BinomialRate;
    oauthAxisConcurrency: {
      supported: false;
      reason: string;
    };
    customAxisConcurrency: CanaryComparison;
    stressFailures: BinomialRate;
    failureTaxonomy: Record<string, number>;
  };
  recommendations: string[];
  units: CanaryUnitResult[];
};

type RunInput = {
  stateDir: string;
  configDigest: string;
  repetitions: number;
  group?: CanaryGroup;
  stressConcurrency?: number;
  executor: CanaryExecutor;
};

const MATRIX_VERSION = 1;
const MAX_REPORT_BYTES = 32 * 1024 * 1024;

export function canaryMatrix(): CanaryCell[] {
  const cells: CanaryCell[] = [];
  const add = (cell: CanaryCell): void => {
    if (!cells.some((candidate) => sameJson(candidate, cell))) cells.push(cell);
  };

  for (const runtime of ["herdr-pi-cli", "pi-rpc"] as const) {
    for (const task of ["short-change", "medium-change", "long-tools"] as const) {
      add(workerCell(runtime, task, runtime === "pi-rpc" ? "disabled" : "runtime-default"));
    }
    if (runtime === "pi-rpc") add(workerCell(runtime, "long-tools", "controlled-threshold"));

    for (const task of ["reviewer-exact-head", "validation-long", "validation-large-output"] as const) {
      add(reviewerCell(runtime, task, "openai-oauth", 1));
    }
    add(reviewerCell(runtime, "reviewer-exact-head", "custom-api-key", 1));
    add(reviewerCell(runtime, "reviewer-exact-head", "custom-api-key", 2));

    for (const task of ["provider-network-fault", "provider-continuation-lost"] as const) {
      add({ ...workerCell(runtime, task, runtime === "pi-rpc" ? "disabled" : "runtime-default"), execution: "simulated" });
      add({ ...reviewerCell(runtime, task, "openai-oauth", 1), execution: "simulated" });
      add({ ...reviewerCell(runtime, task, "custom-api-key", 1), execution: "simulated" });
    }

    add({
      ...workerCell(runtime, "short-change", runtime === "pi-rpc" ? "disabled" : "runtime-default"),
      provider: "custom-api-key",
      credentialMode: "canonical-model-config",
      execution: "unsupported",
      unsupportedReason: "Worker custom Provider is outside the current identity contract",
    });
    add({
      ...reviewerCell(runtime, "reviewer-exact-head", "openai-oauth", 2),
      execution: "unsupported",
      unsupportedReason: "canonical OAuth openai-codex Reviewer axes are policy-forced to 1",
    });
  }
  add({
    ...workerCell("herdr-pi-cli", "long-tools", "controlled-threshold"),
    execution: "unsupported",
    unsupportedReason: "controlled compaction is supported only by the qualified pi-rpc Worker",
  });

  for (const runtime of ["herdr-pi-cli", "pi-rpc"] as const) {
    add({ ...workerCell(runtime, "short-change", runtime === "pi-rpc" ? "disabled" : "runtime-default"), group: "stress" });
    add({ ...reviewerCell(runtime, "reviewer-exact-head", "openai-oauth", 1), group: "stress" });
    add({ ...reviewerCell(runtime, "reviewer-exact-head", "custom-api-key", 2), group: "stress" });
  }
  return cells;
}

export function canaryUnits(repetitions: number): CanaryUnit[] {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) {
    throw new Error("canary repetitions must be an integer between 1 and 100");
  }
  return canaryMatrix().flatMap((cell) => Array.from({ length: repetitions }, (_, index) => {
    const repetition = index + 1;
    return { ...cell, repetition, id: digest({ version: MATRIX_VERSION, cell, repetition }).slice(0, 24) };
  }));
}

export async function runCanaryMatrix(input: RunInput): Promise<CanaryReport> {
  const group = input.group ?? "serial";
  const concurrency = group === "serial" ? 1 : input.stressConcurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("canary stress concurrency must be between 1 and 16");
  }
  ensureRunManifest(input.stateDir, input.configDigest);
  const selected = canaryUnits(input.repetitions).filter((unit) => unit.group === group);
  await runBounded(selected, concurrency, async (unit) => {
    await executeUnit(input, unit);
  });
  return writeCanaryReports(input.stateDir, input.configDigest, input.repetitions);
}

export function writeCanaryReports(stateDir: string, configDigest: string, repetitions: number): CanaryReport {
  ensureRunManifest(stateDir, configDigest);
  const results = canaryUnits(repetitions).flatMap((unit) => {
    const value = readJsonIfExists<CanaryUnitResult>(unitResultPath(stateDir, unit.id));
    if (!value) return [];
    assertUnitResult(value, unit);
    return [value];
  });
  const report = buildCanaryReport(configDigest, repetitions, results);
  writeAtomicJson(join(stateDir, "report.json"), report);
  writeAtomicText(join(stateDir, "report.md"), renderCanaryMarkdown(report));
  return report;
}

export function readCanaryReport(path: string): CanaryReport {
  const size = statSync(path).size;
  if (size > MAX_REPORT_BYTES) throw new Error("canary report exceeds the bounded input size");
  const value = JSON.parse(readFileSync(path, "utf8")) as CanaryReport;
  if (
    value?.version !== 1
    || !/^[0-9a-f]{64}$/.test(value.configDigest)
    || !Array.isArray(value.units)
    || !Array.isArray(value.assumptions)
    || !Array.isArray(value.recommendations)
  ) throw new Error("invalid canary report");
  for (const row of value.units) assertUnitResult(row, row.unit);
  return value;
}

export function aggregateCanaryReport(report: CanaryReport): Omit<CanaryReport, "units"> {
  const { units: _units, ...aggregate } = report;
  return aggregate;
}

function workerCell(
  runtime: CanaryCell["runtime"],
  task: Extract<CanaryTask, "short-change" | "medium-change" | "long-tools" | "provider-network-fault" | "provider-continuation-lost">,
  compaction: CanaryCell["compaction"],
): CanaryCell {
  return {
    group: "serial",
    lane: "worker",
    runtime,
    provider: "openai-oauth",
    credentialMode: "canonical-oauth",
    axisConcurrency: null,
    compaction,
    task,
    execution: "live",
    unsupportedReason: null,
  };
}

function reviewerCell(
  runtime: CanaryCell["runtime"],
  task: Extract<CanaryTask, "reviewer-exact-head" | "validation-long" | "validation-large-output" | "provider-network-fault" | "provider-continuation-lost">,
  provider: CanaryProvider,
  axisConcurrency: 1 | 2,
): CanaryCell {
  return {
    group: "serial",
    lane: "reviewer",
    runtime,
    provider,
    credentialMode: provider === "openai-oauth" ? "canonical-oauth" : "canonical-model-config",
    axisConcurrency,
    compaction: runtime === "pi-rpc" ? "disabled" : "runtime-default",
    task,
    execution: "live",
    unsupportedReason: null,
  };
}

async function executeUnit(input: RunInput, unit: CanaryUnit): Promise<CanaryUnitResult> {
  const unitDir = join(input.stateDir, "units", unit.id);
  mkdirSync(unitDir, { recursive: true, mode: 0o700 });
  const manifestPath = join(unitDir, "unit.json");
  const manifest = { version: 1, configDigest: input.configDigest, unit };
  const existingManifest = readJsonIfExists<typeof manifest>(manifestPath);
  if (existingManifest && !sameJson(existingManifest, manifest)) throw new Error(`canary unit identity drifted: ${unit.id}`);
  if (!existingManifest) writeExclusiveJson(manifestPath, manifest);

  const resultPath = unitResultPath(input.stateDir, unit.id);
  const existing = readJsonIfExists<CanaryUnitResult>(resultPath);
  if (existing) {
    assertUnitResult(existing, unit);
    return existing;
  }
  const result = unit.execution === "unsupported"
    ? unsupportedResult(unit)
    : unit.execution === "simulated"
      ? simulatedResult(unit)
      : await input.executor.execute(unit, unitDir);
  assertUnitResult(result, unit);
  writeExclusiveJson(resultPath, result);
  return result;
}

function unsupportedResult(unit: CanaryUnit): CanaryUnitResult {
  const now = new Date().toISOString();
  return {
    version: 1,
    unit,
    evidence: "unsupported",
    outcome: "unsupported",
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    resultPresent: null,
    terminalObserved: null,
    validationRan: false,
    validationDurationMs: null,
    validationOutputBytes: null,
    compactionCount: null,
    failure: null,
  };
}

function simulatedResult(unit: CanaryUnit): CanaryUnitResult {
  const now = new Date().toISOString();
  const context = {
    providerApi: unit.provider === "openai-oauth" ? "openai-codex-responses" as const : "unknown" as const,
    phase: unit.task === "provider-continuation-lost" ? "tool_continuation" as const : "initial_generation" as const,
    turnCount: unit.task === "provider-continuation-lost" ? 2 : 1,
    assistantMessageCount: 1,
    toolExecutionCount: unit.task === "provider-continuation-lost" ? 1 : 0,
    toolErrorCount: 0,
    transcriptBytes: unit.task === "provider-continuation-lost" ? 128 * 1024 : 4 * 1024,
  };
  const diagnostic = unit.task === "provider-continuation-lost"
    ? classifyProviderContinuationLost(context, { code: 1, signal: null })
    : classifyProviderFailure("error", "ECONNRESET", context);
  return {
    version: 1,
    unit,
    evidence: "simulated",
    outcome: "simulated-failure",
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    resultPresent: false,
    terminalObserved: true,
    validationRan: unit.lane === "reviewer" && unit.task === "provider-continuation-lost",
    validationDurationMs: null,
    validationOutputBytes: null,
    compactionCount: 0,
    failure: canaryFailureFromDiagnostic(diagnostic),
  };
}

function buildCanaryReport(configDigest: string, repetitions: number, units: CanaryUnitResult[]): CanaryReport {
  const planned = canaryUnits(repetitions).length;
  const serial = units.filter((unit) => unit.unit.group === "serial" && unit.evidence === "measured");
  const failures = serial.filter((unit) => unit.outcome === "failed");
  const worker = failureRate(serial.filter((unit) => unit.unit.lane === "worker"));
  const reviewer = failureRate(serial.filter((unit) => unit.unit.lane === "reviewer"));
  const validationRows = serial.filter((unit) => unit.validationRan);
  const resultFailures = failures.filter((unit) => unit.resultPresent === true);
  const controlledLong = serial.filter(compactionComparable)
    .filter((unit) => unit.unit.compaction === "controlled-threshold");
  const report: CanaryReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    configDigest,
    repetitions,
    partial: units.length !== planned,
    totals: {
      planned,
      completed: units.length,
      measured: units.filter((unit) => unit.evidence === "measured").length,
      passed: units.filter((unit) => unit.outcome === "passed").length,
      failed: units.filter((unit) => unit.outcome === "failed").length,
      simulated: units.filter((unit) => unit.evidence === "simulated").length,
      unsupported: units.filter((unit) => unit.evidence === "unsupported").length,
    },
    assumptions: [
      "Primary comparisons use serial measured units only; simulated faults never enter failure-rate estimates.",
      "Worker custom Provider and OAuth axisConcurrency=2 remain unsupported by current safety contracts.",
      "Local canary Git checks are delivery-gate evidence, but no GitHub publication or merge fixed point is claimed.",
      "Rates use Wilson 95% intervals and rate differences use Newcombe score 95% intervals; small or unmatched samples remain inconclusive.",
    ],
    observations: {
      workerVsReviewer: {
        worker,
        reviewer,
        observedHigherFailureLane: higherFailureLane(worker, reviewer),
      },
      rpcVsInteractive: comparison(
        "herdr-pi-cli",
        serial.filter(runtimeComparable).filter((unit) => unit.unit.runtime === "herdr-pi-cli"),
        "pi-rpc",
        serial.filter(runtimeComparable).filter((unit) => unit.unit.runtime === "pi-rpc"),
      ),
      oauthVsCustomProvider: comparison(
        "custom-api-key",
        serial.filter(comparableProvider).filter((unit) => unit.unit.provider === "custom-api-key"),
        "openai-oauth",
        serial.filter(comparableProvider).filter((unit) => unit.unit.provider === "openai-oauth"),
      ),
      validationContinuationFailures: rate(
        validationRows.filter((unit) => unit.failure?.code === "provider_continuation_lost").length,
        validationRows.length,
      ),
      resultPresentObservationFailures: rate(
        resultFailures.filter((unit) => unit.failure?.domain === "observation").length,
        failures.length,
      ),
      compactionOnLongTasks: comparison(
        "disabled",
        serial.filter(compactionComparable).filter((unit) => unit.unit.compaction === "disabled"),
        "controlled-threshold",
        controlledLong,
      ),
      controlledCompactionTriggered: rate(
        controlledLong.filter((unit) => (unit.compactionCount ?? 0) > 0).length,
        controlledLong.length,
      ),
      oauthAxisConcurrency: {
        supported: false,
        reason: "openai-codex canonical OAuth Reviewer startup is policy-forced to axisConcurrency=1",
      },
      customAxisConcurrency: comparison(
        "custom-axis-1",
        serial.filter(axisComparable).filter((unit) => unit.unit.axisConcurrency === 1),
        "custom-axis-2",
        serial.filter(axisComparable).filter((unit) => unit.unit.axisConcurrency === 2),
      ),
      stressFailures: failureRate(units.filter((unit) => unit.unit.group === "stress" && unit.evidence === "measured")),
      failureTaxonomy: counts(failures.flatMap((unit) => unit.failure?.code ? [unit.failure.code] : [])),
    },
    recommendations: [],
    units: [...units].sort((left, right) => left.unit.id.localeCompare(right.unit.id)),
  };
  report.recommendations = recommendations(report);
  return report;
}

function comparableProvider(unit: CanaryUnitResult): boolean {
  return unit.unit.lane === "reviewer"
    && unit.unit.task === "reviewer-exact-head"
    && unit.unit.axisConcurrency === 1;
}

function runtimeComparable(unit: CanaryUnitResult): boolean {
  return unit.unit.compaction !== "controlled-threshold";
}

function compactionComparable(unit: CanaryUnitResult): boolean {
  return unit.unit.lane === "worker"
    && unit.unit.runtime === "pi-rpc"
    && unit.unit.task === "long-tools";
}

function axisComparable(unit: CanaryUnitResult): boolean {
  return unit.unit.lane === "reviewer"
    && unit.unit.provider === "custom-api-key"
    && unit.unit.task === "reviewer-exact-head";
}

function comparison(
  baselineLabel: string,
  baselineUnits: CanaryUnitResult[],
  candidateLabel: string,
  candidateUnits: CanaryUnitResult[],
): CanaryComparison {
  const baseline = failureRate(baselineUnits);
  const candidate = failureRate(candidateUnits);
  const incrementalFailure = baseline.rate === null || candidate.rate === null ? null : candidate.rate - baseline.rate;
  return {
    baseline: { label: baselineLabel, failures: baseline, duration: durationSummary(baselineUnits) },
    candidate: { label: candidateLabel, failures: candidate, duration: durationSummary(candidateUnits) },
    incrementalFailure,
    confidence95: differenceConfidence95(baseline, candidate),
  };
}

/** Newcombe score interval for the difference between two independent proportions. */
function differenceConfidence95(
  baseline: BinomialRate,
  candidate: BinomialRate,
): { low: number; high: number } | null {
  if (
    baseline.rate === null
    || candidate.rate === null
    || baseline.confidence95 === null
    || candidate.confidence95 === null
  ) return null;
  const difference = candidate.rate - baseline.rate;
  return {
    low: Math.max(-1, difference - Math.sqrt(
      (candidate.rate - candidate.confidence95.low) ** 2
      + (baseline.confidence95.high - baseline.rate) ** 2,
    )),
    high: Math.min(1, difference + Math.sqrt(
      (candidate.confidence95.high - candidate.rate) ** 2
      + (baseline.rate - baseline.confidence95.low) ** 2,
    )),
  };
}

function durationSummary(units: CanaryUnitResult[]): DurationSummary {
  const durations = units.map((unit) => unit.durationMs).sort((left, right) => left - right);
  return {
    samples: durations.length,
    medianMs: percentile(durations, 0.5),
    p90Ms: percentile(durations, 0.9),
  };
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  return values[Math.ceil(percentileValue * values.length) - 1]!;
}

function counts(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function failureRate(units: CanaryUnitResult[]): BinomialRate {
  return rate(units.filter((unit) => unit.outcome === "failed").length, units.length);
}

function rate(numerator: number, denominator: number): BinomialRate {
  if (denominator === 0) return { numerator, denominator, rate: null, confidence95: null };
  const observed = numerator / denominator;
  const z = 1.959963984540054;
  const z2 = z * z;
  const scale = 1 + z2 / denominator;
  const center = (observed + z2 / (2 * denominator)) / scale;
  const margin = z * Math.sqrt((observed * (1 - observed) + z2 / (4 * denominator)) / denominator) / scale;
  return {
    numerator,
    denominator,
    rate: observed,
    confidence95: { low: Math.max(0, center - margin), high: Math.min(1, center + margin) },
  };
}

function higherFailureLane(
  worker: BinomialRate,
  reviewer: BinomialRate,
): "worker" | "reviewer" | "tie" | "insufficient" {
  if (worker.rate === null || reviewer.rate === null) return "insufficient";
  if (worker.rate === reviewer.rate) return "tie";
  return worker.rate > reviewer.rate ? "worker" : "reviewer";
}

function recommendations(report: CanaryReport): string[] {
  if (report.partial) return ["Matrix is incomplete; do not change production Provider, runtime, compaction, axis, or recovery policy."];
  const comparisons = [
    ["RPC runtime", report.observations.rpcVsInteractive],
    ["OAuth Provider", report.observations.oauthVsCustomProvider],
    ["controlled compaction", report.observations.compactionOnLongTasks],
    ["custom axis concurrency", report.observations.customAxisConcurrency],
  ] as const;
  return comparisons.map(([label, value]) => {
    if (!value.confidence95) return `${label}: insufficient measured samples; keep the current production setting.`;
    if (value.confidence95.low <= 0 && value.confidence95.high >= 0) {
      return `${label}: the 95% incremental-failure interval crosses zero; collect more matched repetitions.`;
    }
    return `${label}: the measured incremental-failure interval excludes zero; verify the matched-cell assumption before any rollout change.`;
  });
}

function renderCanaryMarkdown(report: CanaryReport): string {
  const comparisonRow = (name: string, value: CanaryComparison): string => (
    `| ${name} | ${formatRate(value.baseline.failures)} / ${formatDuration(value.baseline.duration)} | ${formatRate(value.candidate.failures)} / ${formatDuration(value.candidate.duration)} | ${formatDelta(value)} |`
  );
  return [
    "# Provider / Runtime A/B Canary",
    "",
    `Generated: ${report.generatedAt}`,
    `Config digest: \`${report.configDigest}\``,
    `Completed: ${report.totals.completed}/${report.totals.planned}; measured ${report.totals.measured}; simulated ${report.totals.simulated}; unsupported ${report.totals.unsupported}.`,
    "",
    "## Measured answers",
    "",
    `- Worker failure: ${formatRate(report.observations.workerVsReviewer.worker)}; Reviewer failure: ${formatRate(report.observations.workerVsReviewer.reviewer)}; observed higher lane: ${report.observations.workerVsReviewer.observedHigherFailureLane}.`,
    `- Validation-followed continuation failure: ${formatRate(report.observations.validationContinuationFailures)}.`,
    `- Result-present observation failure among failures: ${formatRate(report.observations.resultPresentObservationFailures)}.`,
    `- Controlled compaction actually triggered: ${formatRate(report.observations.controlledCompactionTriggered)}.`,
    `- OAuth axis concurrency effect: unsupported — ${report.observations.oauthAxisConcurrency.reason}.`,
    `- Measured failure taxonomy: ${Object.entries(report.observations.failureTaxonomy).map(([code, count]) => `${code}=${count}`).join(", ") || "none"}.`,
    "",
    "| Comparison | Baseline failures / duration | Candidate failures / duration | Incremental failure |",
    "| --- | ---: | ---: | ---: |",
    comparisonRow("RPC vs interactive", report.observations.rpcVsInteractive),
    comparisonRow("OAuth vs custom Provider", report.observations.oauthVsCustomProvider),
    comparisonRow("Controlled vs disabled compaction (long RPC Worker)", report.observations.compactionOnLongTasks),
    comparisonRow("Custom axis 2 vs 1", report.observations.customAxisConcurrency),
    "",
    "## Assumptions",
    "",
    ...report.assumptions.map((value) => `- ${value}`),
    "",
    "## Recommendations",
    "",
    ...report.recommendations.map((value) => `- ${value}`),
    "",
  ].join("\n");
}

function formatRate(value: BinomialRate): string {
  if (value.rate === null || value.confidence95 === null) return `n=0`;
  return `${percent(value.rate)} (n=${value.denominator}, 95% ${percent(value.confidence95.low)}..${percent(value.confidence95.high)})`;
}

function formatDelta(value: CanaryComparison): string {
  if (value.incrementalFailure === null || value.confidence95 === null) return "insufficient";
  return `${signedPercent(value.incrementalFailure)} (95% ${signedPercent(value.confidence95.low)}..${signedPercent(value.confidence95.high)})`;
}

function formatDuration(value: DurationSummary): string {
  if (value.medianMs === null || value.p90Ms === null) return "n=0";
  return `median ${value.medianMs}ms, p90 ${value.p90Ms}ms`;
}

function percent(value: number): string {
  return `${(100 * value).toFixed(1)}%`;
}

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${(100 * value).toFixed(1)}pp`;
}

export function canaryFailureFromDiagnostic(value: SafeRuntimeDiagnostic): CanaryFailure {
  if (!isSafePiRpcDiagnostic(value) || !value.domain || !value.code || !value.stage) {
    throw new Error("canary failure is not a current safe taxonomy value");
  }
  return { ...value, domain: value.domain, code: value.code, stage: value.stage };
}

function assertUnitResult(value: CanaryUnitResult, unit: CanaryUnit): void {
  if (
    value?.version !== 1
    || !sameJson(value.unit, unit)
    || !["measured", "simulated", "unsupported"].includes(value.evidence)
    || !["passed", "failed", "simulated-failure", "unsupported"].includes(value.outcome)
    || !Number.isFinite(Date.parse(value.startedAt))
    || !Number.isFinite(Date.parse(value.completedAt))
    || !Number.isSafeInteger(value.durationMs)
    || value.durationMs < 0
    || (value.failure !== null && !isCanaryFailure(value.failure))
  ) throw new Error(`invalid canary unit result: ${unit.id}`);
}

function isCanaryFailure(value: CanaryFailure): boolean {
  return isSafePiRpcDiagnostic(value) && !!value.domain && !!value.code && !!value.stage;
}

function ensureRunManifest(stateDir: string, configDigest: string): void {
  if (!/^[0-9a-f]{64}$/.test(configDigest)) throw new Error("canary config digest must be SHA-256");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, "matrix.json");
  const manifest = { version: MATRIX_VERSION, configDigest, matrix: canaryMatrix() };
  const existing = readJsonIfExists<typeof manifest>(path);
  if (existing && !sameJson(existing, manifest)) throw new Error("canary state belongs to a different config or matrix");
  if (!existing) writeExclusiveJson(path, manifest);
}

function unitResultPath(stateDir: string, unitId: string): string {
  return join(stateDir, "units", unitId, "result.json");
}

async function runBounded<T>(values: T[], concurrency: number, run: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      await run(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
}

function writeAtomicText(path: string, value: string): void {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, value, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
