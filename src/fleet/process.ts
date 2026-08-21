import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

export type ProcessResult = {
  code: number | null;
  signal: string | null;
  startedAt: string;
  completedAt: string;
  stdout: string;
  stderr: string;
  error: string | null;
};

export async function runBoundedProcess(input: {
  command: string;
  argv: string[];
  cwd?: string;
  maxBytes: number;
  timeoutMs?: number;
}): Promise<ProcessResult> {
  const startedAt = new Date().toISOString();
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeout: unknown = null;
    const child = spawn(input.command, input.argv, {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    if (input.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, input.timeoutMs);
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: unknown) => { stdout = appendTail(stdout, String(chunk), input.maxBytes); });
    child.stderr.on("data", (chunk: unknown) => { stderr = appendTail(stderr, String(chunk), input.maxBytes); });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      resolveResult({
        code: null,
        signal: null,
        startedAt,
        completedAt: new Date().toISOString(),
        stdout,
        stderr,
        error: error.message,
      });
    });
    child.on("exit", (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      resolveResult({
        code,
        signal,
        startedAt,
        completedAt: new Date().toISOString(),
        stdout,
        stderr,
        error: timedOut ? `process timed out after ${String(input.timeoutMs)}ms` : null,
      });
    });
  });
}

export function appendTail(current: string, chunk: string, maxBytes: number): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  const characters = Array.from(combined);
  let start = characters.length;
  let bytes = 0;
  while (start > 0) {
    const nextBytes = Buffer.byteLength(characters[start - 1]!, "utf8");
    if (bytes + nextBytes > maxBytes) break;
    start -= 1;
    bytes += nextBytes;
  }
  return characters.slice(start).join("");
}
