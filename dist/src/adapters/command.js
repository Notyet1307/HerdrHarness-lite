import { spawnSync } from "node:child_process";
export class SyncCommandRunner {
    run(command, args, options = {}) {
        const spawnOptions = {
            encoding: "utf8",
            maxBuffer: 20 * 1024 * 1024,
            env: options.env ?? process.env,
        };
        if (options.cwd !== undefined)
            spawnOptions.cwd = options.cwd;
        if (options.input !== undefined)
            spawnOptions.input = options.input;
        if (options.timeoutMs !== undefined)
            spawnOptions.timeout = options.timeoutMs;
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
export function requireSuccess(result, label) {
    if (!result.ok) {
        throw new Error(`${label} failed: ${(result.error ?? result.stderr.trim()) || result.stdout.trim() || `exit ${result.code}`}`);
    }
    return result.stdout;
}
//# sourceMappingURL=command.js.map