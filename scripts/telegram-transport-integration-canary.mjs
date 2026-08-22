#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const harnessRoot = resolve(import.meta.dirname, "..");
const bridgeRoot = resolve(process.argv[2] ?? resolve(harnessRoot, "../harness-telegram-bridge"));
const bridgeModule = await import(pathToFileURL(resolve(bridgeRoot, "src/bridge.js")).href);
run(process.execPath, ["--test", resolve(harnessRoot, "dist/test/project-observer-v2.test.js"), resolve(harnessRoot, "dist/test/fleet-observer.test.js")]);
run(process.execPath, [resolve(harnessRoot, "scripts/check-telegram-transport-contract.mjs"), bridgeRoot]);

const root = mkdtempSync(join(tmpdir(), "telegram-transport-canary-"));
try {
  const stateDir = join(root, "harness-state");
  const ledgerPath = join(stateDir, "state.json");
  const harnessConfig = join(root, "harness.json");
  const observerConfig = join(root, "observer.json");
  const approvalState = join(root, "approval.json");
  const tokenFile = join(root, "bot.token");
  const bridgeState = join(root, "bridge-state.json");
  const bridgeConfig = join(root, "bridge.json");
  const fleetObserverConfig = join(root, "fleet-observer.json");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(ledgerPath, `${JSON.stringify(blockedState())}\n`, { mode: 0o600 });
  writeFileSync(harnessConfig, JSON.stringify({ stateDir, herdr: { session: "canary" }, analyst: { command: "/usr/bin/false" } }), { mode: 0o600 });
  writeFileSync(fleetObserverConfig, "{}\n", { mode: 0o600 });
  writeFileSync(tokenFile, "123456:FAKE_CANARY_TOKEN\n", { mode: 0o600 });
  writeFileSync(observerConfig, JSON.stringify({
    transportVersion: 2,
    routeId: "exposure",
    projectId: "Exposure-Agent",
    fleetId: "engineering-fleet",
    harnessConfig,
    nodeBin: process.execPath,
    statusScript: resolve(harnessRoot, "dist/src/transport-cli.js"),
    approvalScript: resolve(harnessRoot, "dist/src/hermes-approval.js"),
    harnessCliScript: resolve(harnessRoot, "dist/src/cli.js"),
    approvalState,
    telegramAllowedUser: "123456789",
    deliveryCommand: [process.execPath, resolve(bridgeRoot, "src/bridge.js"), "send-card", "--config", bridgeConfig],
    observerState: join(root, "observer-state.json"),
    controllerLog: join(root, "controller.log"),
    pollMs: 1000,
    heartbeatTimeoutMs: 60000
  }), { mode: 0o600 });
  writeFileSync(bridgeConfig, JSON.stringify({
    version: 2,
    telegramAllowedUser: "123456789",
    telegramTokenFile: tokenFile,
    stateFile: bridgeState,
    pollTimeoutSeconds: 0,
    commandTimeoutMs: 5000,
    fleet: {
      configPath: fleetObserverConfig,
      viewCommand: [process.execPath, resolve(harnessRoot, "dist/src/transport-cli.js"), "fleet"],
      diagnoseCommand: [process.execPath, resolve(harnessRoot, "dist/src/transport-cli.js"), "fleet-diagnose"]
    },
    projects: {
      exposure: {
        projectId: "Exposure-Agent",
        configPath: observerConfig,
        viewCommand: [process.execPath, resolve(harnessRoot, "dist/src/transport-cli.js"), "project"],
        approvalCommand: [process.execPath, resolve(harnessRoot, "dist/src/hermes-approval.js")],
        diagnoseCommand: [process.execPath, resolve(harnessRoot, "dist/src/transport-cli.js"), "project-diagnose"]
      }
    }
  }), { mode: 0o600 });
  chmodSync(bridgeConfig, 0o600);

  const telegram = [];
  const commands = [];
  const bridge = bridgeModule.createBridge(bridgeModule.loadConfig(bridgeConfig), {
    request: async (method, body) => { telegram.push({ method, body }); return true; },
    runCommand: (argv, input, timeout) => {
      commands.push(argv);
      const result = spawnSync(argv[0], argv.slice(1), { input, encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
    }
  });

  for (const name of ["fleet-view.json", "project-view.json", "diagnostic-view.json", "event-provider-transient.json", "event-controller-down.json"]) {
    await bridge.sendCard(fixture(name));
  }
  const controllerUp = { ...fixture("event-controller-down.json"), eventId: "event-controller-up-canary", dedupeKey: "controller.up:canary", category: "controller.up", severity: "info", title: "Controller restored", summary: "Controller lease and heartbeat recovered.", actionRequired: false };
  await bridge.sendCard(controllerUp);
  await bridge.sendCard(fixture("event-provider-transient.json"));
  const sent = telegram.filter((entry) => entry.method === "sendMessage");
  assert(sent.length === 6, `expected 6 deduped messages, got ${sent.length}`);
  assert(sent.some((entry) => entry.body.text.includes("process=adopted") || entry.body.text.includes(" · adopted · ")), "adopted phase missing");
  assert(sent.some((entry) => entry.body.text.includes("backoff")) && sent.some((entry) => entry.body.text.includes("tripped")), "Fleet failure phases missing");
  assert(sent.some((entry) => entry.body.text.includes("workflow=blocked") || entry.body.text.includes("Workflow: blocked")), "workflow blocked missing");
  assert(sent.some((entry) => entry.body.text.includes("PARTIAL/UNKNOWN")), "partial diagnose missing");

  let challenge = createChallenge(observerConfig);
  await bridge.sendCard(challenge.envelope);
  const ledgerBeforeWrong = sha256(readFileSync(ledgerPath));
  await bridge.handleUpdate(callback("0000000000000000"));
  assert(sha256(readFileSync(ledgerPath)) === ledgerBeforeWrong, "wrong token changed ledger");

  const expired = JSON.parse(readFileSync(approvalState, "utf8"));
  expired.expiresAt = "2000-01-01T00:00:00.000Z";
  writeFileSync(approvalState, `${JSON.stringify(expired)}\n`, { mode: 0o600 });
  await bridge.handleUpdate(callback(challenge.envelope.approval.token));
  assert(sha256(readFileSync(ledgerPath)) === ledgerBeforeWrong, "expired token changed ledger");

  challenge = createChallenge(observerConfig);
  const staleLedger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  staleLedger.activeJob.revision += 1;
  writeFileSync(ledgerPath, `${JSON.stringify(staleLedger)}\n`, { mode: 0o600 });
  const staleBaseline = sha256(readFileSync(ledgerPath));
  await bridge.handleUpdate(callback(challenge.envelope.approval.token));
  assert(sha256(readFileSync(ledgerPath)) === staleBaseline, "stale revision challenge changed ledger");
  assert(commands.every((argv) => argv.includes(resolve(harnessRoot, "dist/src/hermes-approval.js"))), "Bridge invoked a non-allowlisted mutation command");
  assert(JSON.stringify(telegram).includes("SECRET_TASK_BODY") === false, "task body leaked to Telegram");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    version: 2,
    fakeTelegramMessages: telegram.filter((entry) => entry.method === "sendMessage").length,
    callbackScenarios: ["wrong-token", "expired-token", "stale-revision"],
    observerTransitionTests: "passed",
    ledgerDirectWritesByBridge: 0
  }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function createChallenge(config) {
  const result = spawnSync(process.execPath, [resolve(harnessRoot, "dist/src/hermes-approval.js"), "request", "--config", config, "--json", "--transport-v2"], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function callback(token) {
  return { callback_query: { id: `query-${token}`, data: `hh:a:exposure:${token}`, from: { id: 123456789 }, message: { message_id: 1, text: "approval", chat: { id: 123456789, type: "private" }, reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: `hh:a:exposure:${token}` }]] } } } };
}

function fixture(name) {
  return JSON.parse(readFileSync(resolve(harnessRoot, "test/fixtures/telegram-transport-v2", name), "utf8"));
}

function run(command, argv) {
  const result = spawnSync(command, argv, { cwd: harnessRoot, encoding: "utf8", timeout: 15000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function sha256(value) {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function blockedState() {
  const attempt = { id: "attempt-001", lane: "reviewer", phase: "settled", round: 1, baseSha: "a".repeat(40), expectedHeadSha: "b".repeat(40), resultPath: "/tmp/review-result.json", promptDigest: "p".repeat(64), handle: null, result: null, startedAt: "2026-08-22T00:00:00.000Z", completedAt: "2026-08-22T00:01:00.000Z" };
  const incident = { id: "incident-001", class: "infrastructure_exhausted", lane: "reviewer", attemptId: attempt.id, summary: "provider unavailable", evidenceDigest: "e".repeat(64), allowedActions: ["retry_fresh_reviewer", "hold"], createdAt: "2026-08-22T00:00:00.000Z" };
  return { version: 1, activeJob: { id: "job-001", revision: 12, state: "blocked", task: { repo: "owner/repo", issueNumber: 48, mapNumber: null, title: "canary", objective: "SECRET_TASK_BODY", labels: [], issueUpdatedAt: "2026-08-22T00:00:00.000Z", digest: "d".repeat(64) }, baseSha: "a".repeat(40), claimConfirmed: true, headSha: "b".repeat(40), branch: "agent/issue-48", worktree: null, analyst: null, activeAttempt: attempt, attempts: [attempt], reviewRound: 1, maxReviewRounds: 3, pendingHandoff: null, incident, analysis: { id: "analysis-001", incidentId: incident.id, evidenceDigest: incident.evidenceDigest, action: "retry_fresh_reviewer", summary: "fresh reviewer", resolutionBrief: "Use a fresh Reviewer.", evidenceRefs: [], unknowns: [], createdAt: "2026-08-22T00:02:00.000Z" }, approval: null, automaticRecoveries: [], pullRequest: null, ciFailure: null, ciReworkCount: 0, lastError: null, createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:02:00.000Z" }, terminalJobs: [] };
}
