import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { publishResult } from "./reviewer-tools.js";

const DESCRIPTOR_ENV = "HERDR_HARNESS_WORKER_DESCRIPTOR";

export default function workerTools(pi) {
  const descriptor = readDescriptor();
  let submitted = false;

  pi.registerTool({
    name: "worker_submit",
    label: "Submit bound Worker result",
    description: "Write the one Harness-bound Worker result with Harness-resolved Git provenance.",
    parameters: {
      type: "object",
      required: ["status", "summary", "failedCommands"],
      properties: {
        status: { enum: ["completed", "blocked", "failed"] },
        summary: { type: "string", minLength: 1, maxLength: 4000 },
        failedCommands: {
          type: "array",
          maxItems: 64,
          items: { type: "string", minLength: 1, maxLength: 4000 },
        },
      },
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      if (submitted) throw new Error("Worker result was already submitted");
      if (!Array.isArray(params.failedCommands) || params.failedCommands.some((value) => typeof value !== "string")) {
        throw new Error("Worker failedCommands must be an array of strings");
      }
      const headSha = params.status === "completed" ? resolveHeadSha(descriptor.worktreePath) : null;
      const result = {
        version: 1,
        jobId: descriptor.jobId,
        attemptId: descriptor.attemptId,
        lane: "worker",
        status: params.status,
        summary: params.summary,
        headSha,
        failedCommands: params.failedCommands,
      };
      publishResult(descriptor.resultPath, `${JSON.stringify(result)}\n`);
      submitted = true;
      return { content: [{ type: "text", text: JSON.stringify({ submitted: true, status: params.status }) }] };
    },
  });
}

function resolveHeadSha(worktreePath) {
  const result = spawnSync("git", ["-C", worktreePath, "rev-parse", "--verify", "HEAD^{commit}"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const headSha = result.stdout?.trim().toLowerCase() ?? "";
  if (result.error || result.status !== 0 || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("Harness could not resolve the Worker worktree HEAD");
  }
  return headSha;
}

function readDescriptor() {
  const path = process.env[DESCRIPTOR_ENV];
  if (!path || !isAbsolute(path)) throw new Error(`${DESCRIPTOR_ENV} must name an absolute descriptor path`);
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    value?.version !== 1
    || typeof value.jobId !== "string" || !value.jobId
    || typeof value.attemptId !== "string" || !value.attemptId
    || !isAbsolute(value.worktreePath ?? "")
    || !isAbsolute(value.resultPath ?? "")
  ) throw new Error("invalid Harness Worker descriptor");
  return value;
}
