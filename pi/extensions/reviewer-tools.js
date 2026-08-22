import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { CANONICAL_AGENT_DIR_ENV, ORIGINAL_AGENT_DIR_ENV, PI_PACKAGE_ROOT_ENV } from "./reviewer-subagent-config.js";

const DESCRIPTOR_ENV = "HERDR_HARNESS_REVIEW_DESCRIPTOR";
const AXIS_OUTPUT_LIMIT = 12 * 1024;
const AXIS_SUMMARY_LIMIT = 2 * 1024;
const AXIS_FINDING_LIMIT = 32;
const AXIS_EVIDENCE_LIMIT = 64;
const AXIS_EVIDENCE_REF_LIMIT = 512;
const GENERIC_TOOL_OUTPUT_LIMIT = 16 * 1024;
const CONTEXT_BUDGET_EXCEEDED = "reviewer_context_budget_exceeded";
const VALIDATION_OUTPUT_REDACTED = "[redacted validation output]";
const BOUNDED_TOP_LEVEL_TOOLS = new Set(["read", "grep", "find", "ls", "subagent"]);
const SAFE_SUBAGENT_CONFIG = {
  asyncByDefault: false,
  forceTopLevelAsync: false,
  fleetView: false,
  intercomBridge: { mode: "off" },
  turnBudget: { maxTurns: 10, graceTurns: 2 },
  toolBudget: { soft: 16, hard: 24, block: ["read", "grep", "find", "ls"] },
};
const CHECKPOINT_IDENTITY_KEYS = [
  "baseSha",
  "jobId",
  "jobRevision",
  "modelDigest",
  "providerDigest",
  "repositoryContextBundleDigest",
  "resourceDigest",
  "reviewedHeadSha",
  "runtimeDigest",
  "sourceAttemptId",
  "taskDigest",
];

export default function reviewerTools(pi) {
  const descriptor = readDescriptor();
  restorePiAgentDirectory(descriptor);
  assertReviewRuntime(descriptor);
  const checkpointInputs = readCheckpointInputs(descriptor);
  let environmentPreflight = null;
  let submitted = false;
  const axisFailures = new Map();
  const axesCalls = new Map();
  const axisTasks = new Map();
  const axisLaunchCounts = new Map();
  const retryAvailableAxes = new Set();
  const axisResults = {
    Standards: checkpointInputs.get("standards-axis")?.result ?? null,
    Spec: checkpointInputs.get("spec-axis")?.result ?? null,
  };
  let axesCompleted = completedAxes(axisResults);
  const reusedFinal = checkpointInputs.get("reviewer-final")?.result ?? null;
  let finalProposal = reusedFinal;
  const contextBudget = { used: descriptor.initialContextBytes, exceeded: false };
  const respond = (details, options) => budgetedToolResult(details, descriptor, contextBudget, options);

  pi.on("tool_call", async (event) => {
    if (contextBudget.exceeded) {
      if (event.toolName === "review_submit" && ["blocked", "failed"].includes(event.input?.status)) return undefined;
      return { block: true, reason: CONTEXT_BUDGET_EXCEEDED, terminate: true };
    }
    if (event.toolName !== "subagent") return undefined;
    if (!environmentPreflight?.ok) {
      return { block: true, reason: "Reviewer must complete review_preflight successfully before launching review axes" };
    }
    try {
      assertReviewRuntime(descriptor);
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
    const reviewCall = reviewAxisTasks(event.input, descriptor);
    if (!reviewCall) {
      return { block: true, reason: "Reviewer may launch only fixed fresh read-only review axes" };
    }
    const tasks = reviewCall.tasks;
    const axes = tasks.map((task) => reviewAxis(task));
    if (!reviewerAxisStartupAllowed(descriptor.axisConcurrency, Boolean(axisResults.Standards), axes)) {
      return { block: true, reason: `Reviewer axis startup policy requires concurrency=${descriptor.axisConcurrency} and Standards before Spec` };
    }
    if (axes.some((axis) => !axis || axisResults[axis]
      || ((axisLaunchCounts.get(axis) ?? 0) > 0 && !retryAvailableAxes.has(axis)))) {
      return { block: true, reason: "Reviewer may launch each missing review axis once plus one Harness-authorized retry" };
    }
    if (tasks.some((task, index) => axisTasks.has(axes[index]) && axisTasks.get(axes[index]) !== task)) {
      return { block: true, reason: "Reviewer axis retry must preserve the exact initial brief" };
    }
    event.input.workflowScript = reviewCall.workflowScript;
    event.input.cwd = descriptor.runtimePath;
    event.input.foregroundOnly = true;
    axes.forEach((axis, index) => {
      if (!axisTasks.has(axis)) axisTasks.set(axis, tasks[index]);
      retryAvailableAxes.delete(axis);
      axisLaunchCounts.set(axis, (axisLaunchCounts.get(axis) ?? 0) + 1);
    });
    axesCalls.set(event.toolCallId, tasks);
    return undefined;
  });

  pi.on("tool_result", async (event) => {
    const expectedTasks = axesCalls.get(event.toolCallId);
    if (event.toolName === "subagent" && expectedTasks) {
      let projected;
      try {
        projected = projectReviewAxes(event, expectedTasks, descriptor);
      } catch {
        projected = {
          completed: false,
          results: {},
          details: { error: "Attempt-private Review Axis evidence capture failed" },
          retryableAxes: new Set(),
        };
      }
      for (const [axis, axisResult] of Object.entries(projected.results)) {
        if (axisResult.status === "blocked") {
          if (axisResult.failure) axisFailures.set(axis, axisResult.failure);
          if (projected.retryableAxes.has(axis) && axisLaunchCounts.get(axis) === 1) retryAvailableAxes.add(axis);
          continue;
        }
        axisFailures.delete(axis);
        publishReviewerCheckpoint(descriptor, axis === "Standards" ? "standards-axis" : "spec-axis", axisResult);
        axisResults[axis] = axisResult;
      }
      axesCalls.delete(event.toolCallId);
      axesCompleted = completedAxes(axisResults);
      if (axesCompleted && environmentPreflight?.ok && !finalProposal) {
        finalProposal = aggregateFinalResult(axisResults, environmentPreflight.validationReceipt, descriptor);
        publishReviewerCheckpoint(descriptor, "reviewer-final", finalProposal);
        projected.details = { ...projected.details, reviewerFinal: finalProposal };
        environmentPreflight.reviewerFinal = finalProposal;
      }
      if (retryAvailableAxes.size > 0) {
        projected.details = { ...projected.details, retryAvailable: [...retryAvailableAxes] };
      }
      const result = respond(projected.details, { isError: !projected.completed });
      if (contextBudget.exceeded) axesCompleted = false;
      return result;
    }
    if (BOUNDED_TOP_LEVEL_TOOLS.has(event.toolName)) {
      try {
        return respond(projectGenericToolResult(event), { isError: event.isError });
      } catch {
        contextBudget.exceeded = true;
        return respond({ error: CONTEXT_BUDGET_EXCEEDED }, { isError: true, reserved: true });
      }
    }
    return undefined;
  });

  pi.registerTool({
    name: "review_preflight",
    label: "Preflight Reviewer environment",
    description: "Verify the read-only Reviewer runtime and read the exact-HEAD Controller validation receipt before review axes start.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      if (environmentPreflight) return respond(environmentPreflight);
      try {
        if (!existsSync(process.cwd())) throw new Error("read-only Reviewer source is missing");
        assertReviewRuntime(descriptor);
        const validationReceipt = readBoundValidationReceipt(descriptor);
        if (validationReceipt.status === "infrastructure-error") throw new Error("Controller validation infrastructure did not produce reviewable evidence");
        const reusedPreflight = checkpointInputs.get("reviewer-preflight");
        if (reusedPreflight && (
          reusedPreflight.result.validationReceiptDigest !== descriptor.validationReceiptDigest
          || reusedPreflight.result.validationStatus !== validationReceipt.status
        )) throw new Error("Reused Reviewer preflight checkpoint is bound to different validation evidence");
        if (!reusedPreflight) publishReviewerCheckpoint(descriptor, "reviewer-preflight", {
          status: "passed",
          validationReceiptDigest: descriptor.validationReceiptDigest,
          validationStatus: validationReceipt.status,
        });
        const reusedStages = [...checkpointInputs.keys()];
        environmentPreflight = {
          ok: true,
          validationReceipt,
          validationFindings: validationFindings(validationReceipt, descriptor),
          reusedStages,
          missingAxes: ["Standards", "Spec"].filter((axis) => !axisResults[axis]),
          reusedAxes: Object.fromEntries(Object.entries(axisResults).filter(([, value]) => value)),
          axisConcurrency: descriptor.axisConcurrency,
          axisTurnBudget: { ...SAFE_SUBAGENT_CONFIG.turnBudget },
          axisToolBudget: {
            ...SAFE_SUBAGENT_CONFIG.toolBudget,
            block: [...SAFE_SUBAGENT_CONFIG.toolBudget.block],
          },
        };
        if (axesCompleted) {
          const aggregated = aggregateFinalResult(axisResults, validationReceipt, descriptor);
          if (finalProposal && JSON.stringify(finalProposal) !== JSON.stringify(aggregated)) {
            throw new Error("Reused Reviewer final checkpoint contradicts its bound stage inputs");
          }
          if (!finalProposal) {
            finalProposal = aggregated;
            publishReviewerCheckpoint(descriptor, "reviewer-final", finalProposal);
          }
          environmentPreflight.reviewerFinal = finalProposal;
        }
      } catch (error) {
        environmentPreflight = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          failure: failure("acceptance", "validation_infrastructure", "review-preflight", true),
        };
      }
      return respond(environmentPreflight);
    },
  });

  pi.registerTool({
    name: "review_submit",
    label: "Submit bound review result",
    description: "Write the one Harness-bound Reviewer result. A pass requires successful fixed validation.",
    parameters: {
      type: "object",
      required: ["status", "summary", "findings"],
      properties: {
        status: { enum: ["pass", "changes", "blocked", "failed"] },
        summary: { type: "string", minLength: 1, maxLength: 4000 },
        findings: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            required: ["severity", "summary", "evidence"],
            properties: {
              severity: { enum: ["critical", "major", "minor"] },
              summary: { type: "string", minLength: 1, maxLength: 1000 },
              evidence: { type: "string", minLength: 1, maxLength: 4000 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      if (submitted) throw new Error("Reviewer result was already submitted");
      if ((params.status === "pass" || params.status === "changes") && contextBudget.exceeded) {
        throw new Error(`Reviewer pass or changes is forbidden after ${CONTEXT_BUDGET_EXCEEDED}`);
      }
      if ((params.status === "pass" || params.status === "changes") && !axesCompleted) {
        throw new Error("Reviewer pass or changes requires one completed Standards and Spec subagent run");
      }
      if (params.status === "pass" && Object.values(axisResults ?? {}).some((axis) => axis.status !== "pass")) {
        throw new Error("Reviewer pass requires pass from both Standards and Spec axes");
      }
      const validationReceipt = params.status === "pass" || params.status === "changes"
        ? readBoundValidationReceipt(descriptor)
        : null;
      const boundValidationFindings = validationReceipt ? validationFindings(validationReceipt, descriptor) : [];
      if (params.status === "changes"
        && !Object.values(axisResults ?? {}).some((axis) => axis.status === "changes")
        && boundValidationFindings.length === 0) throw new Error("Reviewer changes requires an axis or deterministic validation finding");
      if ((params.status === "pass" || params.status === "changes")
        && !sameFindingIdentity(params.findings, [...submittedAxisFindings(axisResults), ...boundValidationFindings])) {
        throw new Error("Reviewer result findings must preserve every Review Axis and validation finding identity");
      }
      if ((params.status === "pass" || params.status === "changes") && !environmentPreflight?.ok) {
        throw new Error("Reviewer pass or changes requires a successful review_preflight run");
      }
      if (params.status === "pass" && validationReceipt?.status !== "passed") {
        throw new Error("Reviewer pass requires a passed Controller validation receipt");
      }
      const summary = params.status === "blocked"
        ? blockedReviewerSummary(params.summary, axisFailures)
        : params.summary;
      const finalResult = { status: params.status, summary, findings: params.findings };
      if ((params.status === "pass" || params.status === "changes")
        && (!finalProposal || JSON.stringify(finalResult) !== JSON.stringify(finalProposal))) {
        throw new Error("Reviewer final submission must preserve the durable final aggregation exactly");
      }
      const result = {
        version: 1,
        jobId: descriptor.jobId,
        attemptId: descriptor.attemptId,
        lane: "reviewer",
        status: params.status,
        summary,
        reviewedHeadSha: descriptor.reviewedHeadSha,
        findings: params.findings,
      };
      if (!finalProposal) publishReviewerCheckpoint(descriptor, "reviewer-final", finalResult);
      publishResult(descriptor.resultPath, `${JSON.stringify(result)}\n`);
      submitted = true;
      return respond({ submitted: true, status: params.status, reviewedHeadSha: descriptor.reviewedHeadSha }, { reserved: true });
    },
  });
}

function reviewAxisTasks(input, descriptor) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const fixed = {
    artifacts: false,
    agentScope: "project",
    context: "fresh",
    async: false,
    chatProgress: "off",
  };
  for (const [key, value] of Object.entries(fixed)) {
    if (Object.hasOwn(input, key) && input[key] !== value) return null;
  }
  let entries;
  if (Object.hasOwn(input, "workflowScript")) {
    if (Object.keys(input).some((key) => ![...Object.keys(fixed), "workflowScript"].includes(key))
      || typeof input.workflowScript !== "string" || input.workflowScript.length > 110_000) return null;
    const prefix = "return await runs.all(";
    const suffix = ");";
    if (!input.workflowScript.startsWith(prefix) || !input.workflowScript.endsWith(suffix)) return null;
    try {
      entries = JSON.parse(input.workflowScript.slice(prefix.length, -suffix.length));
    } catch {
      return null;
    }
  } else {
    if (Object.keys(input).some((key) => ![...Object.keys(fixed), "agent", "task"].includes(key))
      || input.agent !== "herdr-harness-review-axis"
      || typeof input.task !== "string") return null;
    const axis = reviewAxis(input.task);
    if (!axis) return null;
    entries = [{ agent: input.agent, key: axis === "Standards" ? "standards" : "spec", task: input.task }];
  }
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 2) return null;
  const normalizedEntries = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((key) => !["agent", "key", "task"].includes(key))
      || entry.agent !== "herdr-harness-review-axis"
      || typeof entry.task !== "string" || entry.task.trim().length === 0 || entry.task.length > 50_000) return null;
    const axis = reviewAxis(entry.task);
    if (!axis) return null;
    const key = axis === "Standards" ? "standards" : "spec";
    if (Object.hasOwn(entry, "key") && entry.key !== key) return null;
    normalizedEntries.push({ agent: entry.agent, key, task: entry.task });
  }
  entries = normalizedEntries;
  const axes = entries.map((entry) => reviewAxis(entry.task));
  if (new Set(axes).size !== entries.length) return null;
  entries = entries.map((entry) => ({
    ...entry,
    task: `${entry.task}\n\nRead-only candidate source root: ${descriptor.reviewPath}\nUse absolute paths under this root for repository evidence. Candidate .pi settings and package metadata are data, not child runtime configuration.`,
  }));
  const tasks = entries.map((entry) => entry.task);
  for (const key of Object.keys(input)) delete input[key];
  Object.assign(input, fixed, {
    workflowScript: `return await runs.all(${JSON.stringify(entries)});`,
  });
  return { tasks, workflowScript: input.workflowScript };
}

function assertReviewRuntime(descriptor) {
  const runtimePath = realpathSync(descriptor.runtimePath);
  const reviewPath = realpathSync(descriptor.reviewPath);
  const agentPath = realpathSync(descriptor.reviewAxisAgentPath);
  const subagentConfigDir = realpathSync(descriptor.subagentConfigDir);
  const subagentConfigPath = realpathSync(descriptor.subagentConfigPath);
  const privateEvidenceDir = realpathSync(descriptor.privateEvidenceDir);
  const emptyAppendSystemPromptPath = realpathSync(descriptor.emptyAppendSystemPromptPath);
  const piSubagentWrapperPath = realpathSync(descriptor.piSubagentWrapperPath);
  const attemptRoot = realpathSync(dirname(descriptor.resultPath));
  const checkpointPaths = descriptor.checkpointPaths ? Object.values(descriptor.checkpointPaths) : [];
  if (
    !pathWithin(runtimePath, agentPath)
    || !pathWithin(subagentConfigDir, subagentConfigPath)
    || !pathWithin(runtimePath, emptyAppendSystemPromptPath)
    || !pathWithin(runtimePath, piSubagentWrapperPath)
    || pathsOverlap(runtimePath, reviewPath)
    || pathsOverlap(subagentConfigDir, reviewPath)
    || pathsOverlap(privateEvidenceDir, reviewPath)
    || (lstatSync(privateEvidenceDir).mode & 0o077)
  ) {
    throw new Error("Reviewer child runtime overlaps untrusted candidate source");
  }
  if (descriptor.checkpointPaths && (lstatSync(attemptRoot).mode & 0o077)) {
    throw new Error("Reviewer checkpoint root is not private");
  }
  const escapedCheckpoint = checkpointPaths.find((path) => (
    realpathSync(dirname(path)) !== attemptRoot || pathsOverlap(reviewPath, join(attemptRoot, basename(path)))
  ));
  if (escapedCheckpoint) throw new Error(`Reviewer checkpoint path escaped private state: ${escapedCheckpoint}`);
  if (existsSync(join(runtimePath, ".pi", "settings.json"))) {
    throw new Error("Reviewer child runtime must not contain mutable project subagent settings");
  }
  const content = readFileSync(agentPath, "utf8");
  if (sha256(content) !== descriptor.reviewAxisAgentDigest || (lstatSync(agentPath).mode & 0o222)) {
    throw new Error("Reviewer child agent snapshot changed after Attempt preparation");
  }
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
  if (!/^name:\s*["']?herdr-harness-review-axis["']?\s*$/m.test(frontmatter)) {
    throw new Error("Reviewer child agent snapshot has an unexpected identity");
  }
  const configContent = readFileSync(subagentConfigPath, "utf8");
  if (sha256(configContent) !== descriptor.subagentConfigDigest || (lstatSync(subagentConfigPath).mode & 0o222)) {
    throw new Error("Reviewer subagent config snapshot changed after Attempt preparation");
  }
  if (JSON.stringify(JSON.parse(configContent)) !== JSON.stringify(SAFE_SUBAGENT_CONFIG)) {
    throw new Error("Reviewer subagent config does not disable ambient async, Fleet UI, and intercom behavior");
  }
  if (
    readFileSync(emptyAppendSystemPromptPath, "utf8") !== ""
    || sha256(readFileSync(emptyAppendSystemPromptPath)) !== descriptor.emptyAppendSystemPromptDigest
    || (lstatSync(emptyAppendSystemPromptPath).mode & 0o222)
  ) {
    throw new Error("Reviewer child append-system prompt override changed after Attempt preparation");
  }
  if (
    sha256(readFileSync(piSubagentWrapperPath)) !== descriptor.piSubagentWrapperDigest
    || (lstatSync(piSubagentWrapperPath).mode & 0o222)
    || !(lstatSync(piSubagentWrapperPath).mode & 0o111)
    || realpathSync(process.env.PI_SUBAGENT_PI_BINARY ?? "") !== piSubagentWrapperPath
    || process.env[PI_PACKAGE_ROOT_ENV] !== undefined
  ) {
    throw new Error("Reviewer child Pi wrapper changed after Attempt preparation");
  }
  const piExecutable = realpathSync(descriptor.piExecutable ?? "");
  const runtimeVersion = typeof descriptor.piRuntimeVersion === "string" ? descriptor.piRuntimeVersion : "";
  const inspected = spawnSync(piExecutable, ["--version"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  if (inspected.error || inspected.status !== 0 || !runtimeVersion || inspected.stdout.trim() !== runtimeVersion) {
    throw new Error("Reviewer child Pi runtime version changed after Attempt preparation");
  }
}

function restorePiAgentDirectory(descriptor) {
  const original = process.env[ORIGINAL_AGENT_DIR_ENV];
  const isolated = process.env.PI_CODING_AGENT_DIR;
  if (!original || !isAbsolute(original) || !isolated || realpathSync(isolated) !== realpathSync(descriptor.subagentConfigDir)) {
    throw new Error("Reviewer extensions did not load through the isolated subagent config directory");
  }
  process.env.PI_CODING_AGENT_DIR = original;
  process.env[CANONICAL_AGENT_DIR_ENV] = original;
  delete process.env[ORIGINAL_AGENT_DIR_ENV];
}

function pathWithin(root, target) {
  const value = relative(root, target);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function pathsOverlap(left, right) {
  return pathWithin(left, right) || pathWithin(right, left);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function reviewAxis(task) {
  const match = /^Axis: (Standards|Spec)\r?\n[\s\S]*\S$/.exec(task.trimEnd());
  return match?.[1] ?? null;
}

export function reviewerAxisStartupAllowed(axisConcurrency, standardsComplete, axes) {
  const expectedNextAxis = standardsComplete ? "Spec" : "Standards";
  return [1, 2].includes(axisConcurrency)
    && Array.isArray(axes)
    && axes.length >= 1
    && axes.length <= axisConcurrency
    && axes[0] === expectedNextAxis
    && (axes.length !== 2 || (axes[0] === "Standards" && axes[1] === "Spec"));
}

function projectReviewAxes(event, expectedTasks, descriptor) {
  const details = event.details;
  const rawResults = details && typeof details === "object" && !Array.isArray(details)
    && details.mode === "workflow" && Array.isArray(details.results) && details.results.length === expectedTasks.length
    ? details.results
    : [];
  const results = {};
  const retryableAxes = new Set();
  let completed = rawResults.length === expectedTasks.length;
  for (const [index, task] of expectedTasks.entries()) {
    const axis = reviewAxis(task) ?? (index === 0 ? "Standards" : "Spec");
    const matches = rawResults.filter((result) => result && typeof result === "object" && !Array.isArray(result) && result.task === task);
    const result = matches.length === 1 ? matches[0] : null;
    if (!result
      || result.agent !== "herdr-harness-review-axis"
      || result.exitCode !== 0 || result.error
      || result.interrupted || result.timedOut || result.stopped || result.detached
      || typeof result.finalOutput !== "string" || !result.finalOutput.trim()) {
      completed = false;
      const raw = typeof result?.finalOutput === "string" ? Buffer.from(result.finalOutput, "utf8") : Buffer.alloc(0);
      const failure = reviewAxisFailureProjection(result);
      results[axis] = invalidAxisProjection(
        "Review axis did not return one successful structured result",
        raw,
        failure,
      );
      if (failure.retryable) retryableAxes.add(axis);
      continue;
    }
    const projected = projectAxisOutput(axis, result.finalOutput, descriptor);
    if (!projected.valid) {
      completed = false;
      if (projected.retryable) retryableAxes.add(axis);
    }
    results[axis] = projected.value;
  }
  return { completed, results, details: results, retryableAxes };
}

function projectAxisOutput(axis, output, descriptor) {
  const raw = Buffer.from(output, "utf8");
  const digest = sha256(raw);
  persistPrivateEvidence(descriptor, `axis-${axis.toLowerCase()}-${digest.slice(0, 16)}.json`, raw);
  const parsed = parseReviewAxisJson(output);
  if (parsed === undefined) {
    return { valid: false, retryable: true, value: invalidAxisProjection("Review axis output is not JSON or one unique JSON fence", raw) };
  }
  const normalized = normalizeReviewAxisResult(parsed);
  if (!validAxisResult(normalized)) {
    return { valid: false, retryable: true, value: invalidAxisProjection("Review axis output does not match the structured contract", raw) };
  }
  const summary = boundedHeadTail(normalized.summary, AXIS_SUMMARY_LIMIT);
  const value = {
    status: normalized.status,
    summary: summary.text,
    findings: normalized.findings,
    evidenceRefs: normalized.evidenceRefs,
    outputByteCount: raw.length,
    outputDigest: digest,
    truncated: summary.truncated,
  };
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > AXIS_OUTPUT_LIMIT) {
    return { valid: false, retryable: true, value: invalidAxisProjection("Review axis structured projection exceeds 12 KiB", raw) };
  }
  return { valid: normalized.status !== "blocked", retryable: false, value };
}

function normalizeReviewAxisResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "acceptanceReport")) return value;
  const { acceptanceReport: _ignored, ...normalized } = value;
  return normalized;
}

export function parseReviewAxisJson(output) {
  if (typeof output !== "string") return undefined;
  try {
    return JSON.parse(output);
  } catch {
    const fences = [...output.matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/giu)];
    if (fences.length !== 1) return undefined;
    try {
      return JSON.parse(fences[0][1]);
    } catch {
      return undefined;
    }
  }
}

function validAxisResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "evidenceRefs,findings,status,summary"
    || !["pass", "changes", "blocked"].includes(value.status)
    || typeof value.summary !== "string" || !value.summary.trim()
    || !validEvidenceRefs(value.evidenceRefs, AXIS_EVIDENCE_LIMIT)
    || !Array.isArray(value.findings) || value.findings.length > AXIS_FINDING_LIMIT) return false;
  for (const finding of value.findings) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)
      || Object.keys(finding).sort().join(",") !== "evidenceRefs,severity,summary"
      || !["critical", "major", "minor"].includes(finding.severity)
      || typeof finding.summary !== "string" || !finding.summary.trim()
      || Buffer.byteLength(finding.summary, "utf8") > 1_000
      || !validEvidenceRefs(finding.evidenceRefs, 16, 1)
      || Buffer.byteLength(finding.evidenceRefs.join("\n"), "utf8") > 4_000) return false;
  }
  return value.status === "changes" ? value.findings.length > 0 : value.status !== "pass" || value.findings.length === 0;
}

function validEvidenceRefs(value, limit, minimum = 0) {
  return Array.isArray(value) && value.length >= minimum && value.length <= limit && value.every((ref) => (
    typeof ref === "string" && ref.trim() && !/[\r\n]/.test(ref) && Buffer.byteLength(ref, "utf8") <= AXIS_EVIDENCE_REF_LIMIT
  ));
}

function submittedAxisFindings(axisResults) {
  return [axisResults?.Standards, axisResults?.Spec].flatMap((axis) => axis?.findings ?? []).map((finding) => ({
    severity: finding.severity,
    summary: finding.summary,
    evidence: finding.evidenceRefs.join("\n"),
  }));
}

function aggregateFinalResult(axisResults, validationReceipt, descriptor) {
  const findings = [...submittedAxisFindings(axisResults), ...validationFindings(validationReceipt, descriptor)];
  const changes = findings.length > 0 || Object.values(axisResults).some((axis) => axis?.status === "changes")
    || validationReceipt.status === "failed-checks";
  return {
    status: changes ? "changes" : "pass",
    summary: changes
      ? `Reviewer aggregation produced ${findings.length} actionable finding${findings.length === 1 ? "" : "s"}.`
      : "Standards and Spec passed; deterministic validation passed.",
    findings,
  };
}

function sameFindingIdentity(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const canonical = (finding) => JSON.stringify({
    severity: finding?.severity,
    summary: finding?.summary,
    evidence: finding?.evidence,
  });
  const actualIdentities = actual.map(canonical).sort();
  const expectedIdentities = expected.map(canonical).sort();
  return actualIdentities.every((finding, index) => finding === expectedIdentities[index]);
}

function invalidAxisProjection(summary, raw, failureDetails) {
  return {
    status: "blocked",
    summary,
    findings: [],
    evidenceRefs: [],
    outputByteCount: raw.length,
    outputDigest: sha256(raw),
    truncated: raw.length > 0,
    ...(failureDetails ? { failure: failureDetails } : {}),
  };
}

export function reviewAxisFailureProjection(result) {
  const raw = typeof result?.finalOutput === "string" ? Buffer.from(result.finalOutput, "utf8") : Buffer.alloc(0);
  const providerNetwork = childProviderNetworkFailure(result?.messages);
  const emptyResponse = result?.error === "Subagent produced no output (possible model cold-start or empty response).";
  const code = providerNetwork
    ? "review_axis_provider_network"
    : result?.timedOut === true
      ? "review_axis_timeout"
      : result?.turnBudgetExceeded === true
        ? "review_axis_turn_budget"
        : result?.toolBudgetBlocked === true
          ? "review_axis_tool_budget"
          : result?.interrupted === true
            ? "review_axis_interrupted"
            : result?.stopped === true
              ? "review_axis_stopped"
              : result?.detached === true
                ? "review_axis_detached"
                : emptyResponse
                  ? "review_axis_empty_response"
                  : result
                    ? "review_axis_execution_failed"
                    : "review_axis_result_missing";
  const exitCode = Number.isInteger(result?.exitCode) && result.exitCode >= -2 && result.exitCode <= 255
    ? result.exitCode
    : null;
  const toolCount = Number.isSafeInteger(result?.progressSummary?.toolCount)
    && result.progressSummary.toolCount >= 0 && result.progressSummary.toolCount <= 1_000_000
    ? result.progressSummary.toolCount
    : null;
  const durationMs = Number.isSafeInteger(result?.progressSummary?.durationMs)
    && result.progressSummary.durationMs >= 0 && result.progressSummary.durationMs <= 86_400_000
    ? result.progressSummary.durationMs
    : null;
  return {
    domain: "execution",
    code,
    stage: "review-axis",
    retryable: providerNetwork || result?.timedOut === true || emptyResponse,
    exitCode,
    errorPresent: typeof result?.error === "string" && result.error.length > 0,
    interrupted: result?.interrupted === true,
    timedOut: result?.timedOut === true,
    stopped: result?.stopped === true,
    detached: result?.detached === true,
    turnBudgetExceeded: result?.turnBudgetExceeded === true,
    toolBudgetBlocked: result?.toolBudgetBlocked === true,
    toolCount,
    durationMs,
    outputByteCount: raw.length,
    outputDigest: sha256(raw),
  };
}

function childProviderNetworkFailure(messages) {
  if (!Array.isArray(messages)) return false;
  for (const message of messages.slice(-64)) {
    if (!message || typeof message !== "object" || Array.isArray(message) || message.role !== "assistant"
      || !Array.isArray(message.diagnostics)) continue;
    for (const entry of message.diagnostics.slice(-16)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || entry.type !== "provider_transport_failure"
        || !entry.details || typeof entry.details !== "object" || Array.isArray(entry.details)) continue;
      if (entry.details.eventsEmitted === true && entry.details.phase === "after_message_stream_start") return true;
    }
  }
  return false;
}

function blockedReviewerSummary(summary, axisFailures) {
  if (axisFailures.size === 0) return summary;
  const audit = [...axisFailures].map(([axis, details]) => (
    `axis=${axis} code=${details.code} exit=${details.exitCode ?? "unknown"} timedOut=${details.timedOut} interrupted=${details.interrupted} stopped=${details.stopped} detached=${details.detached} turnBudgetExceeded=${details.turnBudgetExceeded} toolBudgetBlocked=${details.toolBudgetBlocked} tools=${details.toolCount ?? "unknown"} durationMs=${details.durationMs ?? "unknown"} outputBytes=${details.outputByteCount}`
  )).join("; ");
  const record = `Harness Review Axis failure: ${audit}`;
  const prefix = summary.slice(0, Math.max(0, 4_000 - record.length - 1));
  return prefix ? `${prefix}\n${record}` : record.slice(0, 4_000);
}

function completedAxes(results) {
  return [results.Standards, results.Spec].every((axis) => axis && axis.status !== "blocked");
}

function publishReviewerCheckpoint(descriptor, stage, result) {
  if (!descriptor.checkpointIdentity) return;
  const path = stage === "reviewer-preflight"
    ? descriptor.checkpointPaths.reviewerPreflight
    : stage === "standards-axis"
      ? descriptor.checkpointPaths.standardsAxis
      : stage === "spec-axis"
        ? descriptor.checkpointPaths.specAxis
        : descriptor.checkpointPaths.reviewerFinal;
  const checkpoint = {
    version: 1,
    ...descriptor.checkpointIdentity,
    stage,
    createdAt: new Date().toISOString(),
    result,
    resultDigest: stableDigest(result),
  };
  if (!validReviewerCheckpoint(checkpoint, descriptor.checkpointIdentity, false)) {
    throw new Error(`Reviewer ${stage} checkpoint does not match the structured contract`);
  }
  publishCheckpoint(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

function publishCheckpoint(path, body) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(temporary, 0o400);
    linkSync(temporary, path);
    unlinkSync(temporary);
    syncDirectory(dirname(path));
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readCheckpointInputs(descriptor) {
  const inputs = new Map();
  if (!descriptor.checkpointIdentity) return inputs;
  if (descriptor.checkpointInputs.length > 5) throw new Error("Reviewer checkpoint input limit exceeded");
  for (const record of descriptor.checkpointInputs) {
    const binding = record?.binding;
    const checkpoint = record?.checkpoint;
    if (!binding || typeof binding !== "object" || Array.isArray(binding)
      || Object.keys(binding).sort().join(",") !== "digest,path,sourceAttemptId,stage"
      || !isAbsolute(binding.path ?? "")
      || !/^[0-9a-f]{64}$/i.test(binding.digest ?? "")
      || typeof binding.sourceAttemptId !== "string" || !binding.sourceAttemptId
      || binding.stage !== checkpoint?.stage
      || binding.sourceAttemptId !== checkpoint?.sourceAttemptId
      || inputs.has(binding.stage)
      || !validReviewerCheckpoint(checkpoint, descriptor.checkpointIdentity, true)) {
      throw new Error("Reviewer checkpoint input descriptor is invalid");
    }
    const raw = readFileSync(binding.path);
    const stat = lstatSync(binding.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o222)
      || sha256(raw) !== binding.digest
      || JSON.stringify(JSON.parse(raw.toString("utf8"))) !== JSON.stringify(checkpoint)) {
      throw new Error("Reviewer checkpoint input changed after Attempt preparation");
    }
    inputs.set(binding.stage, checkpoint);
  }
  return inputs;
}

function validReviewerCheckpoint(checkpoint, expectedIdentity, ignoreSource) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)
    || Object.keys(checkpoint).sort().join(",") !== [...CHECKPOINT_IDENTITY_KEYS, "createdAt", "result", "resultDigest", "stage", "version"].sort().join(",")
    || !validCheckpointIdentity(checkpoint, true)
    || !Number.isFinite(Date.parse(checkpoint.createdAt))
    || checkpoint.resultDigest !== stableDigest(checkpoint.result)) return false;
  if (expectedIdentity && !CHECKPOINT_IDENTITY_KEYS.every((key) => (
    (ignoreSource && (key === "sourceAttemptId" || key === "jobRevision")) || checkpoint[key] === expectedIdentity[key]
  ))) return false;
  if (checkpoint.stage === "reviewer-preflight") return checkpoint.version === 1 && validPreflightCheckpointResult(checkpoint.result);
  if (checkpoint.stage === "standards-axis" || checkpoint.stage === "spec-axis") {
    return checkpoint.version === 1 && validProjectedAxisResult(checkpoint.result);
  }
  if (checkpoint.stage === "validation") return checkpoint.version === 2 && validValidationResult(checkpoint.result);
  return checkpoint.stage === "reviewer-final" && checkpoint.version === 1 && validFinalCheckpointResult(checkpoint.result);
}

function validCheckpointIdentity(value, allowExtra = false) {
  return value && typeof value === "object" && !Array.isArray(value)
    && CHECKPOINT_IDENTITY_KEYS.every((key) => Object.hasOwn(value, key))
    && (allowExtra || Object.keys(value).sort().join(",") === [...CHECKPOINT_IDENTITY_KEYS].sort().join(","))
    && typeof value.jobId === "string" && value.jobId.length > 0
    && typeof value.sourceAttemptId === "string" && value.sourceAttemptId.length > 0
    && Number.isSafeInteger(value.jobRevision) && value.jobRevision >= 0
    && /^[0-9a-f]{64}$/i.test(value.taskDigest ?? "")
    && /^[0-9a-f]{40}$/i.test(value.baseSha ?? "")
    && /^[0-9a-f]{40}$/i.test(value.reviewedHeadSha ?? "")
    && ["runtimeDigest", "providerDigest", "modelDigest", "resourceDigest", "repositoryContextBundleDigest"]
      .every((key) => /^[0-9a-f]{64}$/i.test(value[key] ?? ""));
}

function validPreflightCheckpointResult(result) {
  return result && typeof result === "object" && !Array.isArray(result)
    && Object.keys(result).sort().join(",") === "status,validationReceiptDigest,validationStatus"
    && result.status === "passed"
    && /^[0-9a-f]{64}$/i.test(result.validationReceiptDigest ?? "")
    && ["passed", "failed-checks"].includes(result.validationStatus);
}

function validProjectedAxisResult(result) {
  return result && typeof result === "object" && !Array.isArray(result)
    && Object.keys(result).sort().join(",") === "evidenceRefs,findings,outputByteCount,outputDigest,status,summary,truncated"
    && ["pass", "changes"].includes(result.status)
    && typeof result.summary === "string" && result.summary.trim() && Buffer.byteLength(result.summary, "utf8") <= AXIS_SUMMARY_LIMIT
    && validEvidenceRefs(result.evidenceRefs, AXIS_EVIDENCE_LIMIT)
    && Array.isArray(result.findings) && result.findings.length <= AXIS_FINDING_LIMIT
    && result.findings.every((finding) => finding && typeof finding === "object" && !Array.isArray(finding)
      && Object.keys(finding).sort().join(",") === "evidenceRefs,severity,summary"
      && ["critical", "major", "minor"].includes(finding.severity)
      && typeof finding.summary === "string" && finding.summary.trim()
      && Buffer.byteLength(finding.summary, "utf8") <= 1_000
      && validEvidenceRefs(finding.evidenceRefs, 16, 1))
    && Number.isSafeInteger(result.outputByteCount) && result.outputByteCount >= 0
    && /^[0-9a-f]{64}$/i.test(result.outputDigest ?? "")
    && typeof result.truncated === "boolean"
    && (result.status === "changes" ? result.findings.length > 0 : result.findings.length === 0);
}

function validFinalCheckpointResult(result) {
  return result && typeof result === "object" && !Array.isArray(result)
    && Object.keys(result).sort().join(",") === "findings,status,summary"
    && ["pass", "changes", "blocked", "failed"].includes(result.status)
    && typeof result.summary === "string" && result.summary.trim() && result.summary.length <= 4_000
    && Array.isArray(result.findings) && result.findings.length <= 64
    && result.findings.every((finding) => finding && typeof finding === "object" && !Array.isArray(finding)
      && Object.keys(finding).sort().join(",") === "evidence,severity,summary"
      && ["critical", "major", "minor"].includes(finding.severity)
      && typeof finding.summary === "string" && finding.summary.trim() && finding.summary.length <= 1_000
      && typeof finding.evidence === "string" && finding.evidence.trim() && finding.evidence.length <= 4_000)
    && (result.status === "pass" ? result.findings.length === 0 : result.status !== "changes" || result.findings.length > 0);
}

function validValidationResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)
    || Object.keys(result).sort().join(",") !== "completedAt,dockerHost,durationMs,error,exitCode,relevantEnvironmentDigest,signal,sourceSnapshotDigest,startedAt,status,stderr,stdout,timeout,validationArgv,validationArgvDigest"
    || !["passed", "failed-checks", "infrastructure-error"].includes(result.status)
    || !Array.isArray(result.validationArgv) || result.validationArgv.length < 1 || result.validationArgv.length > 32
    || result.validationArgv.some((item) => typeof item !== "string" || !item || item.length > 8192)
    || result.validationArgvDigest !== sha256(JSON.stringify(result.validationArgv))
    || !Number.isFinite(Date.parse(result.startedAt)) || !Number.isFinite(Date.parse(result.completedAt))
    || !Number.isSafeInteger(result.durationMs) || result.durationMs < 0
    || (result.exitCode !== null && (!Number.isInteger(result.exitCode) || result.exitCode < 0))
    || (result.signal !== null && (typeof result.signal !== "string" || !result.signal.trim() || result.signal.length > 64))
    || typeof result.timeout !== "boolean"
    || (result.error !== null && (typeof result.error !== "string" || !result.error.trim() || result.error.length > 4_000))
    || (result.dockerHost !== null && (typeof result.dockerHost !== "string" || !result.dockerHost.startsWith("unix:///") || /[\0\r\n]/.test(result.dockerHost)))
    || !/^[0-9a-f]{64}$/i.test(result.relevantEnvironmentDigest ?? "")
    || !/^[0-9a-f]{64}$/i.test(result.sourceSnapshotDigest ?? "")
    || !validValidationOutput(result.stdout) || !validValidationOutput(result.stderr)) return false;
  const deterministic = result.signal === null && result.timeout === false && result.error === null;
  return (result.status === "passed" && deterministic && result.exitCode === 0)
    || (result.status === "failed-checks" && deterministic && result.exitCode !== null && result.exitCode !== 0)
    || (result.status === "infrastructure-error" && !deterministic);
}

function stableDigest(value) {
  return sha256(stableStringify(value));
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function publishResult(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    linkSync(temporary, path);
    unlinkSync(temporary);
    syncDirectory(dirname(path));
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function syncDirectory(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readDescriptor() {
  const path = process.env[DESCRIPTOR_ENV];
  if (!path || !isAbsolute(path)) throw new Error(`${DESCRIPTOR_ENV} must name an absolute descriptor path`);
  const value = JSON.parse(readFileSync(path, "utf8"));
  const checkpointing = value?.checkpointIdentity !== undefined
    || value?.checkpointInputs !== undefined
    || value?.checkpointPaths !== undefined;
  const attemptRoot = dirname(value?.resultPath ?? "");
  if (
    value?.version !== 1
    || typeof value.jobId !== "string" || !value.jobId
    || typeof value.attemptId !== "string" || !value.attemptId
    || !/^[0-9a-f]{40}$/i.test(value.reviewedHeadSha ?? "")
    || !isAbsolute(value.validationReceiptPath ?? "")
    || !/^[0-9a-f]{64}$/i.test(value.validationReceiptDigest ?? "")
    || !["passed", "failed-checks"].includes(value.validationStatus)
    || !isAbsolute(value.reviewPath ?? "")
    || !isAbsolute(value.runtimePath ?? "")
    || !isAbsolute(value.reviewAxisAgentPath ?? "")
    || !/^[0-9a-f]{64}$/i.test(value.reviewAxisAgentDigest ?? "")
    || !isAbsolute(value.subagentConfigDir ?? "")
    || !isAbsolute(value.subagentConfigPath ?? "")
    || !/^[0-9a-f]{64}$/i.test(value.subagentConfigDigest ?? "")
    || !isAbsolute(value.resultPath ?? "")
    || ![1, 2].includes(value.axisConcurrency)
    || !(value.credentialDomainId === null || /^[0-9a-f]{64}$/i.test(value.credentialDomainId ?? ""))
    || value.privateEvidenceDir !== join(dirname(value.resultPath ?? ""), "evidence")
    || !Number.isSafeInteger(value.initialContextBytes) || value.initialContextBytes < 0
    || !Number.isSafeInteger(value.contextBudgetBytes) || value.contextBudgetBytes < 1
    || !Number.isSafeInteger(value.contextBudgetReserveBytes) || value.contextBudgetReserveBytes < 1
    || value.initialContextBytes > value.contextBudgetBytes - value.contextBudgetReserveBytes
    || (checkpointing && (
      !validCheckpointIdentity(value.checkpointIdentity)
      || value.checkpointIdentity.jobId !== value.jobId
      || value.checkpointIdentity.sourceAttemptId !== value.attemptId
      || value.checkpointIdentity.reviewedHeadSha !== value.reviewedHeadSha
      || !Array.isArray(value.checkpointInputs)
      || !value.checkpointPaths || typeof value.checkpointPaths !== "object" || Array.isArray(value.checkpointPaths)
      || Object.keys(value.checkpointPaths).sort().join(",") !== "reviewerFinal,reviewerPreflight,specAxis,standardsAxis"
      || value.checkpointPaths.reviewerPreflight !== join(attemptRoot, "reviewer-preflight.json")
      || value.checkpointPaths.standardsAxis !== join(attemptRoot, "standards-axis.json")
      || value.checkpointPaths.specAxis !== join(attemptRoot, "spec-axis.json")
      || value.checkpointPaths.reviewerFinal !== join(attemptRoot, "reviewer-final.json")
    ))
  ) {
    throw new Error("invalid Harness Reviewer descriptor");
  }
  return value;
}

function readBoundValidationReceipt(descriptor) {
  const stat = lstatSync(descriptor.validationReceiptPath);
  const raw = readFileSync(descriptor.validationReceiptPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o222)
    || sha256(raw) !== descriptor.validationReceiptDigest) {
    throw new Error("Controller validation receipt changed after Reviewer preparation");
  }
  const receipt = JSON.parse(raw.toString("utf8"));
  const result = validationReceiptResult(receipt, descriptor);
  if (!result) throw new Error("Controller validation receipt is invalid");
  return result;
}

function validationReceiptResult(receipt, descriptor) {
  if (receipt?.version === 2 && receipt.stage === "validation") {
    if (!validReviewerCheckpoint(receipt, descriptor.checkpointIdentity, true)
      || receipt.jobId !== descriptor.jobId
      || receipt.reviewedHeadSha !== descriptor.reviewedHeadSha
      || receipt.result.status !== descriptor.validationStatus
      || !validValidationResult(receipt.result)) return null;
    return receipt.result;
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || receipt.version !== 1
    || receipt.jobId !== descriptor.jobId
    || receipt.attemptId !== descriptor.attemptId
    || receipt.reviewedHeadSha !== descriptor.reviewedHeadSha
    || receipt.status !== descriptor.validationStatus
    || !["passed", "failed-checks"].includes(receipt.status)
    || !/^[0-9a-f]{64}$/i.test(receipt.taskDigest ?? "")
    || !/^[0-9a-f]{40}$/i.test(receipt.baseSha ?? "")
    || !Array.isArray(receipt.validationArgv) || receipt.validationArgv.length < 1 || receipt.validationArgv.length > 32
    || receipt.validationArgv.some((item) => typeof item !== "string" || !item || item.length > 8192)
    || receipt.validationArgvDigest !== sha256(JSON.stringify(receipt.validationArgv))
    || !Number.isFinite(Date.parse(receipt.startedAt)) || !Number.isFinite(Date.parse(receipt.completedAt))
    || !Number.isSafeInteger(receipt.durationMs) || receipt.durationMs < 0
    || !Number.isInteger(receipt.exitCode) || receipt.exitCode < 0
    || receipt.signal !== null || receipt.timeout !== false || receipt.error !== null
    || (receipt.dockerHost !== null && (typeof receipt.dockerHost !== "string" || !receipt.dockerHost.startsWith("unix:///") || /[\0\r\n]/.test(receipt.dockerHost)))
    || !/^[0-9a-f]{64}$/i.test(receipt.relevantEnvironmentDigest ?? "")
    || !/^[0-9a-f]{64}$/i.test(receipt.resourceDigest ?? "")
    || !/^[0-9a-f]{64}$/i.test(receipt.sourceSnapshotDigest ?? "")
    || !validValidationOutput(receipt.stdout)
    || !validValidationOutput(receipt.stderr)) return null;
  return receipt.status === "passed" ? receipt.exitCode === 0 ? receipt : null : receipt.exitCode !== 0 ? receipt : null;
}

function validValidationOutput(output) {
  if (!output || typeof output !== "object" || Array.isArray(output) || typeof output.text !== "string") return false;
  return typeof output.truncated === "boolean"
    && typeof output.redacted === "boolean"
    && Number.isSafeInteger(output.byteCount) && output.byteCount >= 0
    && /^[0-9a-f]{64}$/i.test(output.sha256 ?? "")
    && (output.byteCount === 0
      ? output.text === "" && !output.truncated && !output.redacted
      : output.text === VALIDATION_OUTPUT_REDACTED && output.truncated && output.redacted);
}

function validationFindings(receipt, descriptor) {
  if (receipt.status !== "failed-checks") return [];
  return [{
    severity: "major",
    summary: `Deterministic validation failed with exit code ${receipt.exitCode}`,
    evidence: [
      `validation receipt: ${descriptor.validationReceiptPath}`,
      `receipt sha256: ${descriptor.validationReceiptDigest}`,
      `argv sha256: ${receipt.validationArgvDigest}`,
      `stdout: ${receipt.stdout.byteCount} bytes sha256 ${receipt.stdout.sha256}`,
      `stderr: ${receipt.stderr.byteCount} bytes sha256 ${receipt.stderr.sha256}`,
    ].join("\n"),
  }];
}

function projectGenericToolResult(event) {
  const serialized = JSON.stringify(event.content ?? []);
  const visible = (event.content ?? []).flatMap((item) => item?.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n");
  const projection = boundedHeadTail(visible, GENERIC_TOOL_OUTPUT_LIMIT);
  return {
    tool: event.toolName,
    isError: event.isError === true,
    output: projection.text,
    outputByteCount: Buffer.byteLength(serialized, "utf8"),
    digest: sha256(serialized),
    truncated: projection.truncated || (event.content ?? []).some((item) => item?.type !== "text"),
  };
}

function persistPrivateEvidence(descriptor, name, raw) {
  const path = join(descriptor.privateEvidenceDir, name);
  if (!pathWithin(descriptor.privateEvidenceDir, path)) throw new Error("Reviewer private evidence path escaped its directory");
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o222)
      || sha256(readFileSync(path)) !== sha256(raw)) {
      throw new Error("Reviewer private evidence file changed");
    }
    return;
  }
  writeFileSync(path, raw, { flag: "wx", mode: 0o400 });
}

function boundedHeadTail(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  const marker = "\n...[truncated]...\n";
  const remaining = maxBytes - Buffer.byteLength(marker, "utf8");
  const headBytes = Math.ceil(remaining / 2);
  const tailBytes = Math.floor(remaining / 2);
  return {
    text: `${utf8Prefix(value, headBytes)}${marker}${utf8Suffix(value, tailBytes)}`,
    truncated: true,
  };
}

function utf8Prefix(value, maxBytes) {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const last = value.charCodeAt(low - 1);
  return value.slice(0, last >= 0xD800 && last <= 0xDBFF ? low - 1 : low);
}

function utf8Suffix(value, maxBytes) {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(value.slice(middle), "utf8") <= maxBytes) high = middle;
    else low = middle + 1;
  }
  const first = value.charCodeAt(low);
  return value.slice(first >= 0xDC00 && first <= 0xDFFF ? low + 1 : low);
}

function budgetedToolResult(details, descriptor, budget, options = {}) {
  const makeResult = (value, isError = false) => {
    const text = JSON.stringify(value, null, 2);
    return { text, bytes: Buffer.byteLength(text, "utf8"), result: { content: [{ type: "text", text }], details: value, ...(isError ? { isError: true } : {}) } };
  };
  const normal = makeResult(details, options.isError === true);
  const ceiling = options.reserved ? descriptor.contextBudgetBytes : descriptor.contextBudgetBytes - descriptor.contextBudgetReserveBytes;
  if ((!budget.exceeded || options.reserved) && budget.used + normal.bytes <= ceiling) {
    budget.used += normal.bytes;
    return normal.result;
  }
  budget.exceeded = true;
  const failureDetails = {
    error: CONTEXT_BUDGET_EXCEEDED,
    failure: failure("acceptance", CONTEXT_BUDGET_EXCEEDED, "review-context", false),
    contextBudgetBytes: descriptor.contextBudgetBytes,
    contextBytesBeforeResult: budget.used,
    rejectedResultBytes: normal.bytes,
  };
  const rejected = makeResult(failureDetails, true);
  if (budget.used + rejected.bytes <= descriptor.contextBudgetBytes) budget.used += rejected.bytes;
  return rejected.result;
}

function failure(domain, code, stage, retryable) {
  return { domain, code, stage, retryable };
}
