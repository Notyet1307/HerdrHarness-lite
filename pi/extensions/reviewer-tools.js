import { accessSync, chmodSync, closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ORIGINAL_AGENT_DIR_ENV, PI_PACKAGE_ROOT_ENV } from "./reviewer-subagent-config.js";

const DESCRIPTOR_ENV = "HERDR_HARNESS_REVIEW_DESCRIPTOR";
const VALIDATION_OUTPUT_LIMIT = 8 * 1024;
const AXIS_OUTPUT_LIMIT = 12 * 1024;
const AXIS_SUMMARY_LIMIT = 2 * 1024;
const AXIS_FINDING_LIMIT = 32;
const AXIS_EVIDENCE_LIMIT = 64;
const AXIS_EVIDENCE_REF_LIMIT = 512;
const GENERIC_TOOL_OUTPUT_LIMIT = 16 * 1024;
const CONTEXT_BUDGET_EXCEEDED = "reviewer_context_budget_exceeded";
const BOUNDED_TOP_LEVEL_TOOLS = new Set(["read", "grep", "find", "ls", "subagent"]);
const SAFE_SUBAGENT_CONFIG = {
  asyncByDefault: false,
  forceTopLevelAsync: false,
  fleetView: false,
  intercomBridge: { mode: "off" },
};

export default function reviewerTools(pi) {
  const descriptor = readDescriptor();
  restorePiAgentDirectory(descriptor);
  assertReviewRuntime(descriptor);
  let environmentPreflight = null;
  let validation = null;
  let submitted = false;
  let axesCall = null;
  let axesCompleted = false;
  let axisResults = null;
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
    if (axesCall) {
      return { block: true, reason: "Reviewer may launch the two review axes only once" };
    }
    try {
      assertReviewRuntime(descriptor);
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
    const tasks = reviewAxisTasks(event.input, descriptor);
    if (!tasks) {
      return { block: true, reason: "Reviewer may launch only the two fixed fresh read-only review axes" };
    }
    axesCall = { id: event.toolCallId, tasks };
    return undefined;
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "subagent" && axesCall?.id === event.toolCallId) {
      let projected;
      try {
        projected = projectReviewAxes(event, axesCall.tasks, descriptor);
      } catch {
        const empty = Buffer.alloc(0);
        const failed = invalidAxisProjection("Attempt-private Review Axis evidence capture failed", empty);
        projected = { completed: false, results: { Standards: failed, Spec: failed }, details: { Standards: failed, Spec: failed } };
      }
      axesCompleted = projected.completed;
      axisResults = projected.results;
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
    description: "Verify the actual Reviewer source, validation copy, command path, and required Docker daemon before review axes start.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      if (environmentPreflight) return respond(environmentPreflight);
      try {
        const env = reviewerEnv(descriptor);
        if (!existsSync(process.cwd())) throw new Error("read-only Reviewer source is missing");
        if (!existsSync(descriptor.validationPath)) throw new Error("Reviewer validation copy is missing");
        if (!existsSync(descriptor.scratchPath)) throw new Error("Reviewer scratch directory is missing");
        assertReviewRuntime(descriptor);
        const executables = validationExecutables(descriptor.validationArgv)
          .map((command) => resolveExecutable(command, descriptor.validationPath, env.PATH));
        proveWritable(descriptor.validationPath);

        let docker = null;
        if (descriptor.dockerHost) {
          const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
            cwd: descriptor.validationPath,
            env,
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
            timeout: 15_000,
          });
          if (version.error || version.status !== 0 || !version.stdout.trim()) {
            throw new Error(`Docker daemon is unavailable: ${processFailure(version)}`);
          }
          const compose = spawnSync("docker", ["compose", "version", "--short"], {
            cwd: descriptor.validationPath,
            env,
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
            timeout: 15_000,
          });
          if (compose.error || compose.status !== 0 || !compose.stdout.trim()) {
            throw new Error(`Docker Compose V2 is unavailable: ${processFailure(compose)}`);
          }
          docker = { host: descriptor.dockerHost, serverVersion: version.stdout.trim(), composeVersion: compose.stdout.trim() };
        }
        environmentPreflight = { ok: true, validationExecutable: executables.at(-1), docker };
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
    name: "review_validate",
    label: "Run fixed review validation",
    description: "Run the single Harness-configured validation command in the disposable writable validation copy.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      if (!environmentPreflight?.ok) throw new Error("review_validate requires a successful review_preflight run");
      if (validation) return respond(validation);
      const env = reviewerEnv(descriptor);
      const [command, ...args] = descriptor.validationArgv;
      const output = await runValidation(command, args, descriptor, env);
      const validationFailure = output.error || output.status === null
        ? failure("acceptance", "validation_infrastructure", "review-validation", true)
        : output.status === 0
          ? null
          : failure("deterministic", "validation_failed", "review-validation", false);
      try {
        if (!output.stdout || !output.stderr) throw new Error("validation evidence capture failed");
        const stdout = output.stdout;
        const stderr = output.stderr;
        validation = {
          command: descriptor.validationArgv,
          exitCode: output.status,
          signal: output.signal,
          error: output.error,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutByteCount: stdout.byteCount,
          stderrByteCount: stderr.byteCount,
          stdoutSha256: stdout.digest,
          stderrSha256: stderr.digest,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          stdoutEvidenceRef: stdout.evidenceRef,
          stderrEvidenceRef: stderr.evidenceRef,
          ...(validationFailure ? { failure: validationFailure } : {}),
        };
      } catch {
        validation = {
          command: descriptor.validationArgv,
          exitCode: output.status,
          signal: output.signal,
          error: "Attempt-private validation evidence capture failed",
          failure: failure("acceptance", "validation_infrastructure", "review-validation", false),
        };
      }
      return respond(validation);
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
      if (params.status === "changes" && !Object.values(axisResults ?? {}).some((axis) => axis.status === "changes")) {
        throw new Error("Reviewer changes requires changes from at least one review axis");
      }
      if ((params.status === "pass" || params.status === "changes")
        && !sameFindingIdentity(params.findings, submittedAxisFindings(axisResults))) {
        throw new Error("Reviewer result findings must preserve every Review Axis finding identity");
      }
      if ((params.status === "pass" || params.status === "changes") && !environmentPreflight?.ok) {
        throw new Error("Reviewer pass or changes requires a successful review_preflight run");
      }
      if ((params.status === "pass" || params.status === "changes") && !validation) {
        throw new Error("Reviewer pass or changes requires a review_validate run");
      }
      if (params.status === "pass" && (validation.exitCode !== 0 || validation.error)) {
        throw new Error("Reviewer pass requires a successful review_validate run");
      }
      const result = {
        version: 1,
        jobId: descriptor.jobId,
        attemptId: descriptor.attemptId,
        lane: "reviewer",
        status: params.status,
        summary: params.summary,
        reviewedHeadSha: descriptor.reviewedHeadSha,
        findings: params.findings,
      };
      publishResult(descriptor.resultPath, `${JSON.stringify(result)}\n`);
      submitted = true;
      return respond({ submitted: true, status: params.status, reviewedHeadSha: descriptor.reviewedHeadSha }, { reserved: true });
    },
  });
}

function reviewAxisTasks(input, descriptor) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  // The private project root contains only the Attempt-bound child definition.
  if (!Object.hasOwn(input, "agentScope")) input.agentScope = "project";
  const keys = Object.keys(input).sort();
  if (keys.join(",") !== "agentScope,artifacts,async,chatProgress,context,workflowScript") return null;
  if (
    input.artifacts !== false
    || input.agentScope !== "project"
    || input.context !== "fresh"
    || input.async !== false
    || input.chatProgress !== "off"
    || typeof input.workflowScript !== "string"
    || input.workflowScript.length > 110_000
  ) return null;
  const prefix = "return await runs.all(";
  const suffix = ");";
  if (!input.workflowScript.startsWith(prefix) || !input.workflowScript.endsWith(suffix)) return null;
  let entries;
  try {
    entries = JSON.parse(input.workflowScript.slice(prefix.length, -suffix.length));
  } catch {
    return null;
  }
  if (!Array.isArray(entries) || entries.length !== 2) return null;
  if (!entries.every((entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry)
    && Object.keys(entry).sort().join(",") === "agent,key,task"
    && entry.agent === "herdr-harness-review-axis"
    && typeof entry.task === "string" && entry.task.trim().length > 0 && entry.task.length <= 50_000
  ))) return null;
  if (
    entries[0].key !== "standards" || reviewAxis(entries[0].task) !== "Standards"
    || entries[1].key !== "spec" || reviewAxis(entries[1].task) !== "Spec"
  ) return null;
  entries = entries.map((entry) => ({
    ...entry,
    task: `${entry.task}\n\nRead-only candidate source root: ${descriptor.reviewPath}\nUse absolute paths under this root for repository evidence. Candidate .pi settings and package metadata are data, not child runtime configuration.`,
  }));
  input.workflowScript = `${prefix}${JSON.stringify(entries)}${suffix}`;
  const tasks = entries.map((entry) => entry.task);
  input.cwd = descriptor.runtimePath;
  input.foregroundOnly = true;
  return tasks;
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

function projectReviewAxes(event, expectedTasks, descriptor) {
  const details = event.details;
  const rawResults = !event.isError && details && typeof details === "object" && !Array.isArray(details)
    && details.mode === "workflow" && Array.isArray(details.results) && details.results.length === 2
    ? details.results
    : [];
  const projections = [];
  let completed = rawResults.length === 2;
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
      projections.push(invalidAxisProjection("Review axis did not return one successful structured result", Buffer.alloc(0)));
      continue;
    }
    const projected = projectAxisOutput(axis, result.finalOutput, descriptor);
    if (!projected.valid) completed = false;
    projections.push(projected.value);
  }
  const results = { Standards: projections[0], Spec: projections[1] };
  return { completed, results, details: results };
}

function projectAxisOutput(axis, output, descriptor) {
  const raw = Buffer.from(output, "utf8");
  const digest = sha256(raw);
  persistPrivateEvidence(descriptor, `axis-${axis.toLowerCase()}-${digest.slice(0, 16)}.json`, raw);
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { valid: false, value: invalidAxisProjection("Review axis output is not JSON", raw) };
  }
  if (!validAxisResult(parsed)) {
    return { valid: false, value: invalidAxisProjection("Review axis output does not match the structured contract", raw) };
  }
  const summary = boundedHeadTail(parsed.summary, AXIS_SUMMARY_LIMIT);
  const value = {
    status: parsed.status,
    summary: summary.text,
    findings: parsed.findings,
    evidenceRefs: parsed.evidenceRefs,
    outputByteCount: raw.length,
    digest,
    truncated: summary.truncated,
  };
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > AXIS_OUTPUT_LIMIT) {
    return { valid: false, value: invalidAxisProjection("Review axis structured projection exceeds 12 KiB", raw) };
  }
  return { valid: parsed.status !== "blocked", value };
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

function invalidAxisProjection(summary, raw) {
  return {
    status: "blocked",
    summary,
    findings: [],
    evidenceRefs: [],
    outputByteCount: raw.length,
    digest: sha256(raw),
    truncated: raw.length > 0,
  };
}

function reviewerEnv(descriptor) {
  const env = validationEnv({
    HOME: join(descriptor.scratchPath, "home"),
    TMPDIR: join(descriptor.scratchPath, "tmp"),
    TMP: join(descriptor.scratchPath, "tmp"),
    TEMP: join(descriptor.scratchPath, "tmp"),
    XDG_CACHE_HOME: join(descriptor.scratchPath, "cache"),
    PYTHONPYCACHEPREFIX: join(descriptor.scratchPath, "pycache"),
  }, descriptor.dockerHost);
  const wrapped = envAssignments(descriptor.validationArgv);
  const configuredHost = wrapped.get("DOCKER_HOST");
  if (configuredHost && configuredHost !== descriptor.dockerHost) {
    throw new Error("Reviewer validation argv attempts to override the bound Docker host");
  }
  const dockerConfig = wrapped.get("DOCKER_CONFIG");
  if (dockerConfig) {
    if (!isAbsolute(dockerConfig) || /[\0\r\n]/.test(dockerConfig)) {
      throw new Error("Reviewer validation DOCKER_CONFIG must be an absolute safe path");
    }
    env.DOCKER_CONFIG = dockerConfig;
  }
  return env;
}

function validationEnv(scratch, dockerHost) {
  const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...scratch };
  if (dockerHost) env.DOCKER_HOST = dockerHost;
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function envAssignments(argv) {
  const values = new Map();
  if (basename(argv[0] ?? "") !== "env") return values;
  for (const argument of argv.slice(1)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([^\0\r\n]*)$/.exec(argument);
    if (!match) break;
    values.set(match[1], match[2]);
  }
  return values;
}

function validationExecutables(argv) {
  const commands = [argv[0]];
  if (basename(argv[0] ?? "") !== "env") return commands;
  const target = argv.slice(1).find((argument) => !/^[A-Za-z_][A-Za-z0-9_]*=[^\0\r\n]*$/.test(argument));
  if (!target || target.startsWith("-")) throw new Error("Reviewer validation env wrapper has no supported command");
  commands.push(target);
  return commands;
}

function resolveExecutable(command, cwd, pathValue) {
  const candidates = command.includes("/")
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : (pathValue ?? "").split(delimiter).filter(Boolean).map((entry) => join(entry, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`Reviewer validation executable is unavailable: ${command}`);
}

function proveWritable(path) {
  const probe = join(path, `.herdr-harness-preflight-${randomUUID()}`);
  let fd = null;
  try {
    fd = openSync(probe, "wx", 0o600);
    closeSync(fd);
    fd = null;
    unlinkSync(probe);
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(probe)) unlinkSync(probe);
  }
}

function processFailure(output) {
  const detail = (output.error?.message ?? output.stderr?.trim()) || output.stdout?.trim() || `exit ${output.status}`;
  return detail.length <= 4_000 ? detail : `[truncated]\n${detail.slice(-4_000)}`;
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
  if (value?.dockerHost === undefined) value.dockerHost = null;
  if (
    value?.version !== 1
    || typeof value.jobId !== "string" || !value.jobId
    || typeof value.attemptId !== "string" || !value.attemptId
    || !/^[0-9a-f]{40}$/i.test(value.reviewedHeadSha ?? "")
    || !Array.isArray(value.validationArgv) || value.validationArgv.length < 1
    || value.validationArgv.some((item) => typeof item !== "string" || !item || item.length > 8192)
    || !isAbsolute(value.reviewPath ?? "")
    || !isAbsolute(value.validationPath ?? "")
    || !isAbsolute(value.scratchPath ?? "")
    || !isAbsolute(value.runtimePath ?? "")
    || !isAbsolute(value.reviewAxisAgentPath ?? "")
    || !/^[0-9a-f]{64}$/i.test(value.reviewAxisAgentDigest ?? "")
    || !isAbsolute(value.subagentConfigDir ?? "")
    || !isAbsolute(value.subagentConfigPath ?? "")
    || !/^[0-9a-f]{64}$/i.test(value.subagentConfigDigest ?? "")
    || !isAbsolute(value.resultPath ?? "")
    || value.privateEvidenceDir !== join(dirname(value.resultPath ?? ""), "evidence")
    || !Number.isSafeInteger(value.initialContextBytes) || value.initialContextBytes < 0
    || !Number.isSafeInteger(value.contextBudgetBytes) || value.contextBudgetBytes < 1
    || !Number.isSafeInteger(value.contextBudgetReserveBytes) || value.contextBudgetReserveBytes < 1
    || value.initialContextBytes > value.contextBudgetBytes - value.contextBudgetReserveBytes
    || (value.dockerHost !== null && (typeof value.dockerHost !== "string" || !safeDockerHost(value.dockerHost)))
  ) {
    throw new Error("invalid Harness Reviewer descriptor");
  }
  return value;
}

function safeDockerHost(host) {
  return host.startsWith("unix:///") && !/[\0\r\n]/.test(host);
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

async function runValidation(command, args, descriptor, env) {
  let stdout;
  let stderr;
  try {
    stdout = openOutputCapture(descriptor, "validation-stdout.log");
    stderr = openOutputCapture(descriptor, "validation-stderr.log");
  } catch {
    stdout?.abort();
    stderr?.abort();
    return { status: null, signal: null, error: "Attempt-private validation evidence capture failed", stdout: null, stderr: null };
  }
  let child;
  try {
    child = spawn(command, args, { cwd: descriptor.validationPath, env, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    stdout.abort();
    stderr.abort();
    return { status: null, signal: null, error: "Reviewer validation process could not start", stdout: null, stderr: null };
  }
  return await new Promise((resolveRun) => {
    let runtimeError = null;
    let captureFailed = false;
    let timedOut = false;
    let forceTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, 30 * 60 * 1000);
    const capture = (target, chunk) => {
      if (captureFailed) return;
      try {
        target.write(chunk);
      } catch {
        captureFailed = true;
        child.kill("SIGKILL");
      }
    };
    const failCapture = () => {
      captureFailed = true;
      child.kill("SIGKILL");
    };
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.stdout.on("error", failCapture);
    child.stderr.on("error", failCapture);
    child.on("error", (error) => { runtimeError = error; });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (captureFailed) {
        stdout.abort();
        stderr.abort();
        resolveRun({ status, signal, error: "Attempt-private validation evidence capture failed", stdout: null, stderr: null });
        return;
      }
      try {
        const stdoutResult = stdout.finish();
        const stderrResult = stderr.finish();
        resolveRun({
          status,
          signal,
          error: timedOut
            ? "Reviewer validation timed out"
            : runtimeError instanceof Error ? runtimeError.message : null,
          stdout: stdoutResult,
          stderr: stderrResult,
        });
      } catch {
        stdout.abort();
        stderr.abort();
        resolveRun({ status, signal, error: "Attempt-private validation evidence capture failed", stdout: null, stderr: null });
      }
    });
  });
}

function openOutputCapture(descriptor, evidenceRef) {
  const path = join(descriptor.privateEvidenceDir, evidenceRef);
  if (!pathWithin(descriptor.privateEvidenceDir, path) || existsSync(path)) {
    throw new Error("Reviewer validation evidence path is unavailable");
  }
  const fd = openSync(path, "wx", 0o600);
  const hash = createHash("sha256");
  let byteCount = 0;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let closed = false;
  return {
    write(value) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let offset = 0;
      while (offset < chunk.length) {
        const written = writeSync(fd, chunk, offset, chunk.length - offset);
        if (written < 1) throw new Error("Reviewer validation evidence write made no progress");
        offset += written;
      }
      hash.update(chunk);
      byteCount += chunk.length;
      if (head.length < VALIDATION_OUTPUT_LIMIT) {
        head = Buffer.concat([head, chunk]).subarray(0, VALIDATION_OUTPUT_LIMIT);
      }
      tail = Buffer.concat([tail, chunk]).subarray(-VALIDATION_OUTPUT_LIMIT);
    },
    finish() {
      fsyncSync(fd);
      closeSync(fd);
      closed = true;
      chmodSync(path, 0o400);
      const source = byteCount <= VALIDATION_OUTPUT_LIMIT ? head : Buffer.concat([head, tail]);
      const projection = boundedHeadTail(source.toString("utf8"), VALIDATION_OUTPUT_LIMIT);
      return {
        text: projection.text,
        truncated: byteCount > VALIDATION_OUTPUT_LIMIT || projection.truncated,
        byteCount,
        digest: hash.digest("hex"),
        evidenceRef,
      };
    },
    abort() {
      if (!closed) {
        try { closeSync(fd); } catch {}
        closed = true;
      }
      if (existsSync(path)) unlinkSync(path);
    },
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
