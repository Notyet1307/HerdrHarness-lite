import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { publishResult } from "./reviewer-tools.js";

const DESCRIPTOR_ENV = "HERDR_HARNESS_WORKER_DESCRIPTOR";
const MAX_TOOL_RESULT_BYTES = 24 * 1024;

export default function workerTools(pi) {
  const descriptor = readDescriptor();
  let submitted = false;

  pi.on("tool_result", async (event) => {
    const content = boundToolResultContent(event.content);
    return content ? {
      content,
      details: event.details,
      isError: event.isError,
      usage: event.usage,
    } : undefined;
  });

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

function boundToolResultContent(content) {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((part) => part?.type === "text" && typeof part.text === "string" ? [part.text] : [])
    .join("\n");
  const originalBytes = Buffer.byteLength(text);
  if (originalBytes <= MAX_TOOL_RESULT_BYTES) return undefined;
  const marker = `[Harness bounded tool output: originalBytes=${originalBytes}, sha256=${createHash("sha256").update(text).digest("hex")}; re-read a narrower slice if needed]`;
  const separatorBytes = Buffer.byteLength(`\n${marker}\n`);
  const retainedBytes = MAX_TOOL_RESULT_BYTES - separatorBytes;
  const head = sliceUtf8(text, Math.floor(retainedBytes / 2), false);
  const tail = sliceUtf8(text, retainedBytes - Buffer.byteLength(head), true);
  let inserted = false;
  return content.flatMap((part) => {
    if (part?.type !== "text") return [part];
    if (inserted) return [];
    inserted = true;
    return [{ type: "text", text: `${head}\n${marker}\n${tail}` }];
  });
}

function sliceUtf8(value, maxBytes, fromEnd) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = fromEnd ? value.slice(value.length - middle) : value.slice(0, middle);
    if (Buffer.byteLength(candidate) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const slice = fromEnd ? value.slice(value.length - low) : value.slice(0, low);
  if (fromEnd && slice.charCodeAt(0) >= 0xDC00 && slice.charCodeAt(0) <= 0xDFFF) return slice.slice(1);
  const last = slice.charCodeAt(slice.length - 1);
  return !fromEnd && last >= 0xD800 && last <= 0xDBFF ? slice.slice(0, -1) : slice;
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
