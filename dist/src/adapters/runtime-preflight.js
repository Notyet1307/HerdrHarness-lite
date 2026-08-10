import { SyncCommandRunner } from "./command.js";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { preparePiRpcAgentDirAt, SUPPORTED_PI_RPC_VERSION } from "../pi-rpc-spool.js";
import { executionResourceDigest } from "../attempt-plan.js";
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
    async inspectPi(input) {
        const executable = resolveExecutable(input.piBin, input.cwd, this.environment.PATH);
        const result = this.runner.run(executable, ["--version"], { cwd: input.cwd, timeoutMs: DOCKER_TIMEOUT_MS });
        if (!result.ok || !result.stdout.trim())
            throw new Error(`Pi runtime inspection failed: ${diagnostic(result)}`);
        return { executable, version: result.stdout.trim() };
    }
    async assertNoAmbientSystemPrompt(input) {
        const configured = this.environment.PI_CODING_AGENT_DIR?.trim();
        const unresolvedAgentDir = configured === "~"
            ? homedir()
            : configured?.startsWith("~/")
                ? join(homedir(), configured.slice(2))
                : configured || join(homedir(), ".pi", "agent");
        if (!isAbsolute(unresolvedAgentDir))
            throw new Error("PI_CODING_AGENT_DIR must resolve to an absolute lock identity");
        const agentDir = resolve(unresolvedAgentDir);
        for (const path of [join(agentDir, "SYSTEM.md"), join(resolve(input.cwd), ".pi", "SYSTEM.md")]) {
            if (existsSync(path))
                throw new Error(`ambient Pi system prompt is not allowed: ${path}`);
        }
        return { agentDir };
    }
    async probeProvider(input) {
        const agentDir = input.agentDir === undefined
            ? undefined
            : preparePiRpcAgentDirAt(input.agentDir);
        if (agentDir && !input.oauthAgentDir)
            throw new Error("RPC Provider probe requires the canonical OAuth agent directory");
        if (agentDir && (input.rpcHost?.kind !== "runtime"
            || basename(input.rpcHost.path) !== "pi-rpc-sdk-entry.js"
            || executionResourceDigest(dirname(input.rpcHost.path)) !== input.rpcHost.digest))
            throw new Error("RPC Provider probe requires the bound Pi SDK host");
        const probeArgs = [
            "--no-session",
            "--no-approve",
            "--no-skills",
            "--no-extensions",
            "--no-context-files",
            "--no-prompt-templates",
            "--no-themes",
            "--no-tools",
            ...runtimeSelectors(input.roleArgv),
        ];
        const result = this.runner.run(agentDir ? process.execPath : input.piBin, agentDir ? [
            input.rpcHost.path,
            "--pi-executable", input.piBin,
            "--expected-version", SUPPORTED_PI_RPC_VERSION,
            "--oauth-agent-dir", input.oauthAgentDir,
            "--private-agent-dir", agentDir,
            "--probe-message", `Reply with exactly ${PROVIDER_MARKER}`,
            "--",
            ...probeArgs,
        ] : [
            ...probeArgs,
            "-p",
            `Reply with exactly ${PROVIDER_MARKER}`,
        ], {
            cwd: input.cwd,
            timeoutMs: PROVIDER_TIMEOUT_MS,
            ...(agentDir ? { env: { ...this.environment, PI_CODING_AGENT_DIR: agentDir } } : {}),
        });
        if (!result.ok) {
            throw new Error(`${input.lane} Provider probe failed: ${diagnostic(result)}`);
        }
        if (!result.stdout.split(/\r?\n/).some((line) => line.trim() === PROVIDER_MARKER)) {
            throw new Error(`${input.lane} Provider probe returned no success marker`);
        }
        if (agentDir)
            preparePiRpcAgentDirAt(agentDir);
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
function resolveExecutable(piBin, cwd, pathValue) {
    const candidates = piBin.includes("/")
        ? [isAbsolute(piBin) ? piBin : resolve(cwd, piBin)]
        : (pathValue ?? "").split(delimiter).filter(Boolean).map((directory) => resolve(directory, piBin));
    for (const candidate of candidates) {
        try {
            accessSync(candidate, constants.X_OK);
            return realpathSync(candidate);
        }
        catch {
            // Try the next PATH entry.
        }
    }
    throw new Error(`Pi executable not found or not executable: ${piBin}`);
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