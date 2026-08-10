#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SyncCommandRunner } from "./adapters/command.js";
import { GitCli } from "./adapters/git-cli.js";
import { GitHubGh } from "./adapters/github-gh.js";
import { HerdrCli } from "./adapters/herdr-cli.js";
import { JsonCommandAnalyst } from "./adapters/json-command-analyst.js";
import { JsonStateStore } from "./adapters/json-store.js";
import { LocalEvidence } from "./adapters/local-evidence.js";
import { PiRpcRuntime } from "./adapters/pi-rpc-runtime.js";
import { RuntimePreflightCli } from "./adapters/runtime-preflight.js";
import { HarnessController } from "./controller.js";
import { startControllerHeartbeat } from "./controller-heartbeat.js";
import { acquireControllerLease } from "./controller-lease.js";
import { projectOperatorState } from "./policy.js";
import { approveRecovery, cancelHeldJob, reassessIncident, resolveDecision } from "./recovery.js";
const usage = `Usage:
  herdr-harness-lite tick --config /absolute/harness.config.json
  herdr-harness-lite run --config /absolute/harness.config.json [--poll-ms 15000] [--max-cycles N]
  herdr-harness-lite status --config /absolute/harness.config.json [--operator]
  herdr-harness-lite decide --config /absolute/harness.config.json --option ID --actor TEXT --reason TEXT
  herdr-harness-lite approve --config /absolute/harness.config.json --revision N --incident ID --analysis ID --actor TEXT --reason TEXT
  herdr-harness-lite reassess --config /absolute/harness.config.json --revision N --incident ID --analysis ID --actor TEXT --reason TEXT
  herdr-harness-lite resolve-decision --config /absolute/harness.config.json --revision N --incident ID --analysis ID --actor TEXT --reason TEXT
  herdr-harness-lite cancel --config /absolute/harness.config.json --revision N --incident ID --analysis ID --actor TEXT --reason TEXT
`;
class SystemClock {
    now() {
        return new Date().toISOString();
    }
}
class UuidIds {
    next(prefix) {
        return `${prefix}-${randomUUID()}`;
    }
}
async function main(argv) {
    const command = argv[2];
    if (!command || command === "help" || command === "--help" || command === "-h") {
        process.stdout.write(usage);
        return 0;
    }
    const configPath = flag(argv, "--config");
    if (!configPath)
        throw new Error("--config is required");
    const config = loadConfig(configPath);
    const store = new JsonStateStore(config.stateDir);
    const clock = new SystemClock();
    const ids = new UuidIds();
    if (command === "status") {
        const state = await store.load();
        process.stdout.write(`${JSON.stringify(argv.includes("--operator") ? projectOperatorState(state) : state, null, 2)}\n`);
        return 0;
    }
    if (command === "decide") {
        const optionId = requiredFlag(argv, "--option");
        const option = projectOperatorState(await store.load()).actions.find((candidate) => candidate.id === optionId);
        if (!option)
            throw new Error("operator option is stale or unavailable");
        const request = {
            expectedRevision: option.binding.revision,
            incidentId: option.binding.incidentId,
            analysisId: option.binding.analysisId,
            actor: requiredFlag(argv, "--actor"),
            reason: requiredFlag(argv, "--reason"),
        };
        const record = option.kind === "approve_retry"
            ? await approveRecovery(store, request, { clock, ids })
            : option.kind === "reassess"
                ? await reassessIncident(store, request, { clock, ids })
                : option.kind === "resolve_decision"
                    ? await resolveDecision(store, request, { clock, ids })
                    : await cancelHeldJob(store, request, { clock, ids });
        process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
        return 0;
    }
    if (command === "approve" || command === "reassess" || command === "resolve-decision" || command === "cancel") {
        const request = {
            expectedRevision: integerFlag(argv, "--revision"),
            incidentId: requiredFlag(argv, "--incident"),
            analysisId: requiredFlag(argv, "--analysis"),
            actor: requiredFlag(argv, "--actor"),
            reason: requiredFlag(argv, "--reason"),
        };
        const record = command === "approve"
            ? await approveRecovery(store, request, { clock, ids })
            : command === "reassess"
                ? await reassessIncident(store, request, { clock, ids })
                : command === "resolve-decision"
                    ? await resolveDecision(store, request, { clock, ids })
                    : await cancelHeldJob(store, request, { clock, ids });
        process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
        return 0;
    }
    if (command !== "tick" && command !== "run")
        throw new Error(`unknown command: ${command}`);
    const lease = acquireControllerLease(config.stateDir);
    try {
        const herdr = new HerdrCli(config.herdr);
        const controller = new HarnessController({
            config,
            store,
            github: new GitHubGh(new SyncCommandRunner(), config.autoMerge === true),
            git: new GitCli(),
            herdr,
            piRpc: new PiRpcRuntime(herdr),
            analyst: new JsonCommandAnalyst(config.analyst.command, config.analyst.argv ?? []),
            evidence: new LocalEvidence(),
            preflight: new RuntimePreflightCli(),
            clock,
            ids,
        });
        if (command === "tick") {
            const output = await controller.tick();
            process.stdout.write(`${JSON.stringify(output)}\n`);
            return output.ok ? 0 : 1;
        }
        const pollMs = optionalIntegerFlag(argv, "--poll-ms") ?? 15_000;
        const maxCycles = optionalIntegerFlag(argv, "--max-cycles");
        if (pollMs < 100)
            throw new Error("--poll-ms must be at least 100");
        const heartbeat = startControllerHeartbeat(config.stateDir);
        try {
            let cycle = 0;
            for (;;) {
                cycle += 1;
                const output = await controller.tick();
                process.stdout.write(`${JSON.stringify({ cycle, ...output })}\n`);
                if (maxCycles !== null && cycle >= maxCycles)
                    return output.ok ? 0 : 1;
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
            }
        }
        finally {
            heartbeat.stop();
        }
    }
    finally {
        lease.stop();
    }
}
function loadConfig(path) {
    const absolute = resolve(path);
    const parsed = JSON.parse(readFileSync(absolute, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.stateDir || !parsed.herdr?.session?.trim() || !parsed.analyst?.command) {
        throw new Error("invalid Harness config: stateDir, herdr.session and analyst.command are required");
    }
    if (parsed.autoMerge !== undefined && typeof parsed.autoMerge !== "boolean") {
        throw new Error("invalid Harness config: autoMerge must be boolean");
    }
    if (parsed.preflight !== undefined && (!parsed.preflight
        || typeof parsed.preflight !== "object"
        || (parsed.preflight.piBin !== undefined && typeof parsed.preflight.piBin !== "string")
        || (parsed.preflight.dockerRequired !== undefined && typeof parsed.preflight.dockerRequired !== "boolean"))) {
        throw new Error("invalid Harness config: preflight must contain optional piBin and dockerRequired values");
    }
    return parsed;
}
function flag(argv, name) {
    const index = argv.indexOf(name);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}
function requiredFlag(argv, name) {
    const value = flag(argv, name);
    if (!value?.trim())
        throw new Error(`${name} is required`);
    return value;
}
function integerFlag(argv, name) {
    const value = optionalIntegerFlag(argv, name);
    if (value === null)
        throw new Error(`${name} is required`);
    return value;
}
function optionalIntegerFlag(argv, name) {
    const raw = flag(argv, name);
    if (raw === null)
        return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0)
        throw new Error(`${name} must be a non-negative integer`);
    return value;
}
main(process.argv)
    .then((code) => {
    process.exitCode = code;
})
    .catch((error) => {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map