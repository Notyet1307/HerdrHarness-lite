import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";

const DESCRIPTOR_ENV = "HERDR_HARNESS_REVIEW_DESCRIPTOR";
const OUTPUT_LIMIT = 50_000;

export default function reviewerTools(pi) {
  const descriptor = readDescriptor();
  let validation = null;
  let submitted = false;

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "subagent") return undefined;
    if (!isReviewAxisCall(event.input)) {
      return { block: true, reason: "Reviewer may launch only the two fixed fresh read-only review axes" };
    }
    return undefined;
  });

  pi.registerTool({
    name: "review_validate",
    label: "Run fixed review validation",
    description: "Run the single Harness-configured validation command in the disposable writable validation copy.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      if (validation) return toolResult(validation);
      const env = {
        ...process.env,
        HOME: join(descriptor.scratchPath, "home"),
        TMPDIR: join(descriptor.scratchPath, "tmp"),
        XDG_CACHE_HOME: join(descriptor.scratchPath, "cache"),
        PYTHONPYCACHEPREFIX: join(descriptor.scratchPath, "pycache"),
      };
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
      mkdirSync(dirname(descriptor.resultPath), { recursive: true });
      const fd = openSync(descriptor.resultPath, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(result)}\n`, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      submitted = true;
      return toolResult({ submitted: true, status: params.status, reviewedHeadSha: descriptor.reviewedHeadSha });
    },
  });
}

function isReviewAxisCall(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const keys = Object.keys(input).sort();
  if (keys.join(",") !== "agentScope,artifacts,async,context,tasks") return false;
  if (input.artifacts !== false || input.agentScope !== "user" || input.context !== "fresh" || input.async !== false) return false;
  if (!Array.isArray(input.tasks) || input.tasks.length !== 2) return false;
  return input.tasks.every((task) => (
    task && typeof task === "object" && !Array.isArray(task)
    && Object.keys(task).sort().join(",") === "agent,task"
    && task.agent === "herdr-harness-review-axis"
    && typeof task.task === "string" && task.task.trim().length > 0 && task.task.length <= 50_000
  ));
}

function readDescriptor() {
  const path = process.env[DESCRIPTOR_ENV];
  if (!path || !isAbsolute(path)) throw new Error(`${DESCRIPTOR_ENV} must name an absolute descriptor path`);
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    value?.version !== 1
    || typeof value.jobId !== "string" || !value.jobId
    || typeof value.attemptId !== "string" || !value.attemptId
    || !/^[0-9a-f]{40}$/i.test(value.reviewedHeadSha ?? "")
    || !Array.isArray(value.validationArgv) || value.validationArgv.length < 1
    || value.validationArgv.some((item) => typeof item !== "string" || !item || item.length > 8192)
    || !isAbsolute(value.validationPath ?? "")
    || !isAbsolute(value.scratchPath ?? "")
    || !isAbsolute(value.resultPath ?? "")
  ) {
    throw new Error("invalid Harness Reviewer descriptor");
  }
  return value;
}

function tail(value) {
  return value.length <= OUTPUT_LIMIT ? value : `[truncated]\n${value.slice(-OUTPUT_LIMIT)}`;
}

function toolResult(details) {
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}
