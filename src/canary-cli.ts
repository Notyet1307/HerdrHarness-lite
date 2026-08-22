#!/usr/bin/env node
import { canaryMatrix, aggregateCanaryReport, runCanaryMatrix, writeCanaryReports } from "./canary.js";
import { LiveCanaryExecutor, loadCanaryConfig } from "./canary-live.js";
import { acquireControllerLease } from "./controller-lease.js";

const usage = `Usage:
  herdr-harness-canary matrix --config /absolute/canary.config.json
  herdr-harness-canary run --config /absolute/canary.config.json [--group serial|stress|all] [--json]
  herdr-harness-canary report --config /absolute/canary.config.json [--json]
`;

async function main(argv: string[]): Promise<number> {
  const command = argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage);
    return 0;
  }
  const configPath = requiredFlag(argv, "--config");
  const config = loadCanaryConfig(configPath);
  if (command === "matrix") {
    process.stdout.write(`${JSON.stringify({
      version: 1,
      configDigest: config.configDigest,
      repetitions: config.file.repetitions,
      defaultGroup: "serial",
      cells: canaryMatrix(),
    }, null, 2)}\n`);
    return 0;
  }
  if (command === "report") {
    printReport(writeCanaryReports(config.stateDir, config.configDigest, config.file.repetitions), argv.includes("--json"));
    return 0;
  }
  if (command !== "run") throw new Error(`unknown command: ${command}`);

  const group = flag(argv, "--group") ?? "serial";
  if (!["serial", "stress", "all"].includes(group)) throw new Error("--group must be serial, stress, or all");
  const lease = acquireControllerLease(config.stateDir);
  try {
    const executor = new LiveCanaryExecutor(config);
    let report = group === "stress"
      ? await runCanaryMatrix({
          stateDir: config.stateDir,
          configDigest: config.configDigest,
          repetitions: config.file.repetitions,
          group: "stress",
          stressConcurrency: config.stressConcurrency,
          executor,
        })
      : await runCanaryMatrix({
          stateDir: config.stateDir,
          configDigest: config.configDigest,
          repetitions: config.file.repetitions,
          group: "serial",
          executor,
        });
    if (group === "all") {
      report = await runCanaryMatrix({
        stateDir: config.stateDir,
        configDigest: config.configDigest,
        repetitions: config.file.repetitions,
        group: "stress",
        stressConcurrency: config.stressConcurrency,
        executor,
      });
    }
    printReport(report, argv.includes("--json"));
    return 0;
  } finally {
    lease.stop();
  }
}

function printReport(report: ReturnType<typeof writeCanaryReports>, detailed: boolean): void {
  process.stdout.write(`${JSON.stringify(detailed ? report : aggregateCanaryReport(report), null, 2)}\n`);
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

main(process.argv)
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
