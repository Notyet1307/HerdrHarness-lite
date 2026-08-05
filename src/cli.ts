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
import { HarnessController } from "./controller.js";
import { approveRecovery } from "./recovery.js";
import type { Clock, HarnessConfig, IdGenerator } from "./ports.js";

const usage = `Usage:
  herdr-harness-lite tick --config /absolute/harness.config.json
  herdr-harness-lite run --config /absolute/harness.config.json [--poll-ms 15000] [--max-cycles N]
  herdr-harness-lite status --config /absolute/harness.config.json
  herdr-harness-lite approve --config /absolute/harness.config.json --revision N --incident ID --analysis ID --actor TEXT --reason TEXT
`;

type FileConfig = HarnessConfig & {
  stateDir: string;
  herdr: { bin?: string; session: string };
  analyst: { command: string; argv?: string[] };
};

class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

class UuidIds implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }
}

async function main(argv: string[]): Promise<number> {
  const command = argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage);
    return 0;
  }
  const configPath = flag(argv, "--config");
  if (!configPath) throw new Error("--config is required");
  const config = loadConfig(configPath);
  const store = new JsonStateStore(config.stateDir);
  const clock = new SystemClock();
  const ids = new UuidIds();

  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await store.load(), null, 2)}\n`);
    return 0;
  }
  if (command === "approve") {
    const revision = integerFlag(argv, "--revision");
    const incidentId = requiredFlag(argv, "--incident");
    const analysisId = requiredFlag(argv, "--analysis");
    const actor = requiredFlag(argv, "--actor");
    const reason = requiredFlag(argv, "--reason");
    const approval = await approveRecovery(
      store,
      { expectedRevision: revision, incidentId, analysisId, actor, reason },
      { clock, ids },
    );
    process.stdout.write(`${JSON.stringify(approval, null, 2)}\n`);
    return 0;
  }
  if (command !== "tick" && command !== "run") throw new Error(`unknown command: ${command}`);

  const controller = new HarnessController({
    config,
    store,
    github: new GitHubGh(new SyncCommandRunner(), config.autoMerge === true),
    git: new GitCli(),
    herdr: new HerdrCli(config.herdr),
    analyst: new JsonCommandAnalyst(config.analyst.command, config.analyst.argv ?? []),
    evidence: new LocalEvidence(),
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
  if (pollMs < 100) throw new Error("--poll-ms must be at least 100");
  let cycle = 0;
  for (;;) {
    cycle += 1;
    const output = await controller.tick();
    process.stdout.write(`${JSON.stringify({ cycle, ...output })}\n`);
    if (maxCycles !== null && cycle >= maxCycles) return output.ok ? 0 : 1;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
  }
}

function loadConfig(path: string): FileConfig {
  const absolute = resolve(path);
  const parsed = JSON.parse(readFileSync(absolute, "utf8")) as FileConfig;
  if (!parsed || typeof parsed !== "object" || !parsed.stateDir || !parsed.herdr?.session?.trim() || !parsed.analyst?.command) {
    throw new Error("invalid Harness config: stateDir, herdr.session and analyst.command are required");
  }
  if (parsed.autoMerge !== undefined && typeof parsed.autoMerge !== "boolean") {
    throw new Error("invalid Harness config: autoMerge must be boolean");
  }
  return parsed;
}

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
}

function requiredFlag(argv: string[], name: string): string {
  const value = flag(argv, name);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function integerFlag(argv: string[], name: string): number {
  const value = optionalIntegerFlag(argv, name);
  if (value === null) throw new Error(`${name} is required`);
  return value;
}

function optionalIntegerFlag(argv: string[], name: string): number | null {
  const raw = flag(argv, name);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
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
