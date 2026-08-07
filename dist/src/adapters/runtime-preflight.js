import { SyncCommandRunner } from "./command.js";
const PROVIDER_MARKER = "HERDR_HARNESS_PROVIDER_OK";
const PROVIDER_TIMEOUT_MS = 120_000;
const DOCKER_TIMEOUT_MS = 15_000;
export class RuntimePreflightCli {
    runner;
    environment;
    constructor(runner = new SyncCommandRunner(), environment = process.env) {
        this.runner = runner;
        this.environment = environment;
    }
    async probeProvider(input) {
        const result = this.runner.run(input.piBin, [
            "--no-session",
            "--no-approve",
            "--no-skills",
            "--no-extensions",
            "--no-context-files",
            "--no-prompt-templates",
            "--no-themes",
            "--no-tools",
            ...runtimeSelectors(input.roleArgv),
            "-p",
            `Reply with exactly ${PROVIDER_MARKER}.`,
        ], { cwd: input.cwd, timeoutMs: PROVIDER_TIMEOUT_MS });
        if (!result.ok) {
            throw new Error(`${input.lane} Provider probe failed: ${diagnostic(result)}`);
        }
        if (!result.stdout.split(/\r?\n/).some((line) => line.trim() === PROVIDER_MARKER)) {
            throw new Error(`${input.lane} Provider probe returned no success marker`);
        }
    }
    async probeDocker(input) {
        const configuredHost = this.environment.DOCKER_HOST?.trim();
        const host = configuredHost || dockerContextHost(this.runner, input.cwd);
        if (!safeLocalDockerHost(host)) {
            throw new Error(`Docker preflight requires a local Unix socket, got: ${host || "missing"}`);
        }
        const version = this.runner.run("docker", [
            "--host",
            host,
            "version",
            "--format",
            "{{.Server.Version}}",
        ], { cwd: input.cwd, timeoutMs: DOCKER_TIMEOUT_MS });
        if (!version.ok || !version.stdout.trim()) {
            throw new Error(`Docker daemon preflight failed: ${diagnostic(version)}`);
        }
        const compose = this.runner.run("docker", [
            "--host",
            host,
            "compose",
            "version",
            "--short",
        ], { cwd: input.cwd, timeoutMs: DOCKER_TIMEOUT_MS });
        if (!compose.ok || !compose.stdout.trim()) {
            throw new Error(`Docker Compose V2 preflight failed: ${diagnostic(compose)}`);
        }
        return { host };
    }
}
function runtimeSelectors(argv) {
    const selected = [];
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (!["--provider", "--model", "--thinking"].includes(flag))
            continue;
        const value = argv[index + 1];
        if (!value)
            throw new Error(`${flag} has no value`);
        selected.push(flag, value);
        index += 1;
    }
    return selected;
}
function dockerContextHost(runner, cwd) {
    const result = runner.run("docker", ["context", "inspect"], { cwd, timeoutMs: DOCKER_TIMEOUT_MS });
    if (!result.ok)
        throw new Error(`Docker context preflight failed: ${diagnostic(result)}`);
    try {
        const contexts = JSON.parse(result.stdout);
        const host = contexts[0]?.Endpoints?.docker?.Host;
        return typeof host === "string" ? host.trim() : "";
    }
    catch {
        throw new Error("Docker context preflight returned invalid JSON");
    }
}
function safeLocalDockerHost(host) {
    if (!host.startsWith("unix:///"))
        return false;
    return !/[\0\r\n]/.test(host);
}
function diagnostic(result) {
    const detail = (result.error ?? result.stderr.trim()) || result.stdout.trim() || `exit ${result.code}`;
    return detail.length <= 4_000 ? detail : `[truncated]\n${detail.slice(-4_000)}`;
}
//# sourceMappingURL=runtime-preflight.js.map