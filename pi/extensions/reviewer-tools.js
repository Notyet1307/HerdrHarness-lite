import { accessSync, closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ORIGINAL_AGENT_DIR_ENV, PI_PACKAGE_ROOT_ENV } from "./reviewer-subagent-config.js";

const DESCRIPTOR_ENV = "HERDR_HARNESS_REVIEW_DESCRIPTOR";
const OUTPUT_LIMIT = 50_000;
const SAFE_SUBAGENT_CONFIG = {
  asyncByDefault: false,
  forceTopLevelAsync: false,
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

  pi.on("tool_call", async (event) => {
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
      axesCompleted = completedReviewAxes(event, axesCall.tasks);
    }
    return undefined;
  });

  pi.registerTool({
    name: "review_preflight",
    label: "Preflight Reviewer environment",
    description: "Verify the actual Reviewer source, validation copy, command path, and required Docker daemon before review axes start.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      if (environmentPreflight) return toolResult(environmentPreflight);
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
        environmentPreflight = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      return toolResult(environmentPreflight);
    },
  });

  pi.registerTool({
    name: "review_validate",
    label: "Run fixed review validation",
    description: "Run the single Harness-configured validation command in the disposable writable validation copy.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      if (!environmentPreflight?.ok) throw new Error("review_validate requires a successful review_preflight run");
      if (validation) return toolResult(validation);
      const env = reviewerEnv(descriptor);
      const [command, ...args] = descriptor.validationArgv;
      const output = spawnSync(command, args, {
        cwd: descriptor.validationPath,
        env,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
      });
      validation = {
        command: descriptor.validationArgv,
        exitCode: output.status,
        signal: output.signal,
        error: output.error?.message ?? null,
        stdout: tail(output.stdout ?? ""),
        stderr: tail(output.stderr ?? ""),
      };
      return toolResult(validation);
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
      if ((params.status === "pass" || params.status === "changes") && !axesCompleted) {
        throw new Error("Reviewer pass or changes requires one completed Standards and Spec subagent run");
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
      return toolResult({ submitted: true, status: params.status, reviewedHeadSha: descriptor.reviewedHeadSha });
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
  const emptyAppendSystemPromptPath = realpathSync(descriptor.emptyAppendSystemPromptPath);
  const piSubagentWrapperPath = realpathSync(descriptor.piSubagentWrapperPath);
  if (
    !pathWithin(runtimePath, agentPath)
    || !pathWithin(subagentConfigDir, subagentConfigPath)
    || !pathWithin(runtimePath, emptyAppendSystemPromptPath)
    || !pathWithin(runtimePath, piSubagentWrapperPath)
    || pathsOverlap(runtimePath, reviewPath)
    || pathsOverlap(subagentConfigDir, reviewPath)
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
    throw new Error("Reviewer subagent config does not disable ambient async and intercom behavior");
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

function completedReviewAxes(event, expectedTasks) {
  const details = event.details;
  if (event.isError || !details || typeof details !== "object" || Array.isArray(details)
    || details.mode !== "workflow" || !Array.isArray(details.results) || details.results.length !== 2) return false;
  const tasks = new Set();
  for (const result of details.results) {
    if (!result || typeof result !== "object" || Array.isArray(result)
      || result.agent !== "herdr-harness-review-axis"
      || !expectedTasks.includes(result.task)
      || result.exitCode !== 0 || result.error
      || result.interrupted || result.timedOut || result.stopped || result.detached
      || typeof result.finalOutput !== "string" || !result.finalOutput.trim()) return false;
    tasks.add(result.task);
  }
  return tasks.size === 2;
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
    || (value.dockerHost !== null && (typeof value.dockerHost !== "string" || !safeDockerHost(value.dockerHost)))
  ) {
    throw new Error("invalid Harness Reviewer descriptor");
  }
  return value;
}

function safeDockerHost(host) {
  return host.startsWith("unix:///") && !/[\0\r\n]/.test(host);
}

function tail(value) {
  return value.length <= OUTPUT_LIMIT ? value : `[truncated]\n${value.slice(-OUTPUT_LIMIT)}`;
}

function toolResult(details) {
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}
