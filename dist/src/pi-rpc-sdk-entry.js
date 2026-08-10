#!/usr/bin/env node
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preparePiRpcAgentDirAt } from "./pi-rpc-spool.js";
async function main(argv) {
    const host = parseHostArgs(argv);
    if (!isAbsolute(host.oauthAgentDir) || !isAbsolute(host.privateAgentDir)) {
        throw new Error("Pi RPC SDK host requires absolute OAuth and private agent directories");
    }
    const runtimeArgs = parseRuntimeArgs(host.piArgv, host.probeMessage !== null);
    const privateAgentDir = preparePiRpcAgentDirAt(host.privateAgentDir);
    if (resolve(process.env.PI_CODING_AGENT_DIR ?? "") !== privateAgentDir) {
        throw new Error("Pi RPC SDK host is not bound to the Attempt-private agent directory");
    }
    // Keep Pi's exact logical path: AuthStorage locks by pathname with realpath:false.
    const oauthAgentDir = resolve(host.oauthAgentDir);
    if (oauthAgentDir === privateAgentDir)
        throw new Error("Pi RPC OAuth and private agent directories must differ");
    const authPath = join(oauthAgentDir, "auth.json");
    assertCanonicalAuthFile(authPath);
    const piIndex = join(dirname(realpathSync(host.piExecutable)), "index.js");
    const pi = await import(pathToFileURL(piIndex).href);
    if (pi.VERSION !== host.expectedVersion) {
        throw new Error(`Pi SDK version changed: expected ${host.expectedVersion}, got ${String(pi.VERSION)}`);
    }
    const http = await import(pathToFileURL(join(dirname(piIndex), "core", "http-dispatcher.js")).href);
    http.configureHttpDispatcher();
    const cwd = process.cwd();
    const createRuntime = async (input) => {
        if (resolve(String(input.cwd)) !== cwd || resolve(String(input.agentDir)) !== privateAgentDir) {
            throw new Error("Pi RPC attempted to replace its bound cwd or agent directory");
        }
        assertCanonicalAuthFile(authPath);
        preparePiRpcAgentDirAt(privateAgentDir);
        const settingsManager = pi.SettingsManager.inMemory({
            retry: { enabled: false },
            compaction: { enabled: false },
        }, { projectTrusted: false });
        const modelRuntime = await pi.ModelRuntime.create({
            authPath,
            modelsPath: null,
            allowModelNetwork: false,
        });
        const model = modelRuntime.getModel(runtimeArgs.provider, runtimeArgs.model);
        if (!model || model.provider !== runtimeArgs.provider || model.id !== runtimeArgs.model) {
            throw new Error(`Pi RPC model is not an exact built-in model: ${runtimeArgs.provider}/${runtimeArgs.model}`);
        }
        const auth = await modelRuntime.getAuth(model, {
            minOAuthValidityMs: 5 * 60_000,
            signal: AbortSignal.timeout(15_000),
        });
        if (!auth || !modelRuntime.isUsingSubscription(runtimeArgs.provider)) {
            throw new Error(`Pi RPC requires canonical subscription OAuth for provider ${runtimeArgs.provider}`);
        }
        const services = await pi.createAgentSessionServices({
            cwd,
            agentDir: privateAgentDir,
            settingsManager,
            modelRuntime,
            resourceLoaderOptions: {
                additionalExtensionPaths: runtimeArgs.extensions,
                additionalSkillPaths: runtimeArgs.skills,
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
                appendSystemPrompt: runtimeArgs.appendSystemPrompt,
            },
        });
        const diagnostics = [
            ...services.diagnostics,
            ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => ({
                type: "error",
                message: `Failed to load extension "${path}": ${error instanceof Error ? error.message : String(error)}`,
            })),
        ];
        const failures = diagnostics.filter(({ type }) => type === "error");
        if (failures.length > 0)
            throw new Error(failures.map(({ message }) => message).join("\n"));
        const created = await pi.createAgentSessionFromServices({
            services,
            sessionManager: input.sessionManager,
            ...(input.sessionStartEvent ? { sessionStartEvent: input.sessionStartEvent } : {}),
            model,
            thinkingLevel: runtimeArgs.thinking,
            ...(runtimeArgs.tools ? { tools: runtimeArgs.tools } : {}),
            ...(runtimeArgs.noTools ? { noTools: "all" } : {}),
        });
        return { ...created, services, diagnostics };
    };
    const runtime = await pi.createAgentSessionRuntime(createRuntime, {
        cwd,
        agentDir: privateAgentDir,
        sessionManager: pi.SessionManager.inMemory(cwd),
    });
    if (host.probeMessage !== null) {
        await runProbe(runtime, host.probeMessage);
        preparePiRpcAgentDirAt(privateAgentDir);
        return;
    }
    await pi.runRpcMode(runtime);
}
async function runProbe(runtime, prompt) {
    const marker = /^Reply with exactly ([A-Z0-9_]{1,100})$/u.exec(prompt)?.[1];
    if (!marker)
        throw new Error("invalid Pi RPC Provider probe");
    try {
        await runtime.session.prompt(prompt);
        const last = runtime.session.state.messages.at(-1);
        const text = Array.isArray(last?.content)
            ? last.content.flatMap((part) => part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("").trim()
            : "";
        if (last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted" || text !== marker) {
            throw new Error("Pi RPC Provider probe failed");
        }
        process.stdout.write(`${marker}\n`);
    }
    finally {
        await runtime.dispose();
    }
}
function parseHostArgs(argv) {
    const separator = argv.indexOf("--");
    if (separator < 0)
        throw new Error("Pi RPC SDK host requires -- before Pi arguments");
    const hostArgv = argv.slice(0, separator);
    const read = (name, required = true) => {
        const indexes = hostArgv.flatMap((value, index) => value === name ? [index] : []);
        if (indexes.length > 1)
            throw new Error(`${name} must appear at most once`);
        if (indexes.length === 0) {
            if (required)
                throw new Error(`${name} is required`);
            return null;
        }
        const value = hostArgv[indexes[0] + 1];
        if (!value || value.startsWith("--"))
            throw new Error(`${name} requires a value`);
        return value;
    };
    const allowed = new Set(["--pi-executable", "--expected-version", "--oauth-agent-dir", "--private-agent-dir", "--probe-message"]);
    for (let index = 0; index < hostArgv.length; index += 2) {
        if (!allowed.has(hostArgv[index]))
            throw new Error(`unsupported Pi RPC SDK host argument: ${hostArgv[index]}`);
    }
    return {
        piExecutable: read("--pi-executable"),
        expectedVersion: read("--expected-version"),
        oauthAgentDir: read("--oauth-agent-dir"),
        privateAgentDir: read("--private-agent-dir"),
        probeMessage: read("--probe-message", false),
        piArgv: argv.slice(separator + 1),
    };
}
function parseRuntimeArgs(argv, probe) {
    const booleans = new Set([
        "--no-approve", "--no-skills", "--no-session", "--no-extensions", "--no-context-files",
        "--no-prompt-templates", "--no-themes", "--no-tools",
    ]);
    const repeatable = new Set(["--extension", "--skill", "--append-system-prompt"]);
    const single = new Set(["--tools", "--thinking", "--provider", "--model", "--mode"]);
    const values = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const name = argv[index];
        if (booleans.has(name)) {
            values.set(name, [...(values.get(name) ?? []), "true"]);
            continue;
        }
        if (!repeatable.has(name) && !single.has(name))
            throw new Error(`unsupported Pi RPC argument: ${name}`);
        const value = argv[++index];
        if (!value || value.startsWith("--"))
            throw new Error(`${name} requires a value`);
        values.set(name, [...(values.get(name) ?? []), value]);
    }
    const one = (name) => {
        const found = values.get(name) ?? [];
        if (found.length !== 1)
            throw new Error(`Pi RPC requires exactly one ${name}`);
        return found[0];
    };
    for (const name of ["--no-approve", "--no-skills", "--no-session", "--no-extensions", "--no-context-files", "--no-prompt-templates", "--no-themes"]) {
        one(name);
    }
    if (!probe && one("--mode") !== "rpc")
        throw new Error("Pi RPC SDK host requires --mode rpc");
    if (probe && values.has("--mode"))
        throw new Error("Pi RPC Provider probe must not select RPC mode");
    const tools = values.has("--tools") ? one("--tools").split(",").map((value) => value.trim()).filter(Boolean) : undefined;
    const noTools = values.has("--no-tools");
    if (probe !== noTools || (!probe && (!tools || tools.length === 0))) {
        throw new Error(probe ? "Pi RPC Provider probe requires --no-tools" : "Pi RPC Worker requires an explicit tool allowlist");
    }
    return {
        provider: one("--provider"),
        model: one("--model"),
        thinking: one("--thinking"),
        tools,
        extensions: values.get("--extension") ?? [],
        skills: values.get("--skill") ?? [],
        appendSystemPrompt: values.get("--append-system-prompt") ?? [],
        noTools,
    };
}
function assertCanonicalAuthFile(path) {
    if (!existsSync(path))
        throw new Error(`Pi subscription OAuth is not logged in: ${path}`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
        throw new Error("Pi subscription OAuth auth.json must be a private regular file at its canonical path");
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch(() => {
        process.stderr.write("FAIL: Pi RPC SDK host failed\n");
        process.exitCode = 1;
    });
}
//# sourceMappingURL=pi-rpc-sdk-entry.js.map