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
    description: "Write the one Harness-bound Worker result without model-supplied task identity.",
    parameters: {
      type: "object",
      required: ["status", "summary", "headSha", "failedCommands"],
      properties: {
        status: { enum: ["completed", "blocked", "failed"] },
        summary: { type: "string", minLength: 1, maxLength: 4000 },
        headSha: { anyOf: [{ type: "string", pattern: "^[0-9a-fA-F]{40}$" }, { type: "null" }] },
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
      if (params.status === "completed" && !/^[0-9a-f]{40}$/i.test(params.headSha ?? "")) {
        throw new Error("Completed Worker result requires a 40-character headSha");
      }
      if (params.headSha !== null && !/^[0-9a-f]{40}$/i.test(params.headSha ?? "")) {
        throw new Error("Worker headSha must be null or a 40-character SHA");
      }
      if (!Array.isArray(params.failedCommands) || params.failedCommands.some((value) => typeof value !== "string")) {
        throw new Error("Worker failedCommands must be an array of strings");
      }
      const result = {
        version: 1,
        jobId: descriptor.jobId,
        attemptId: descriptor.attemptId,
        lane: "worker",
        status: params.status,
        summary: params.summary,
        headSha: params.headSha,
        failedCommands: params.failedCommands,
      };
      publishResult(descriptor.resultPath, `${JSON.stringify(result)}\n`);
      submitted = true;
      return { content: [{ type: "text", text: JSON.stringify({ submitted: true, status: params.status }) }] };
    },
  });
}

function readDescriptor() {
  const path = process.env[DESCRIPTOR_ENV];
  if (!path || !isAbsolute(path)) throw new Error(`${DESCRIPTOR_ENV} must name an absolute descriptor path`);
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    value?.version !== 1
    || typeof value.jobId !== "string" || !value.jobId
    || typeof value.attemptId !== "string" || !value.attemptId
    || !isAbsolute(value.resultPath ?? "")
  ) throw new Error("invalid Harness Worker descriptor");
  return value;
}
