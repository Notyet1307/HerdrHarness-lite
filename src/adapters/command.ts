import { spawnSync } from "node:child_process";

export type CommandResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
};

export interface CommandRunner {
  run(command: string, args: string[], options?: { cwd?: string; input?: string; timeoutMs?: number }): CommandResult;
}

export class SyncCommandRunner implements CommandRunner {
  run(command: string, args: string[], options: { cwd?: string; input?: string; timeoutMs?: number } = {}): CommandResult {
    const spawnOptions: {
      encoding: "utf8";
      maxBuffer: number;
      env: Record<string, string | undefined>;
      cwd?: string;
      input?: string;
      timeout?: number;
    } = {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      env: process.env,
    };
    if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
    if (options.input !== undefined) spawnOptions.input = options.input;
    if (options.timeoutMs !== undefined) spawnOptions.timeout = options.timeoutMs;
    const result = spawnSync(command, args, spawnOptions);
    return {
      ok: !result.error && result.status === 0,
      code: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error?.message ?? null,
    };
  }
}

export function requireSuccess(result: CommandResult, label: string): string {
  if (!result.ok) {
    throw new Error(`${label} failed: ${(result.error ?? result.stderr.trim()) || result.stdout.trim() || `exit ${result.code}`}`);
  }
  return result.stdout;
}
