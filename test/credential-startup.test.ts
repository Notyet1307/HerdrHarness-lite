import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireCredentialStartupLease,
  credentialAuthRevisionId,
  credentialLeasePath,
  CredentialStartupError,
  invalidateProbeSuccess,
  probeCacheIsFresh,
  projectCredentialChildEvent,
  recordProbeSuccess,
  resolveCredentialDomain,
} from "../src/credential-startup.js";

test("credential startup lease uses one realpath domain and fails closed on active or malformed owners", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-credential-lease-"));
  const canonicalDir = join(root, "canonical");
  const aliasDir = join(root, "alias");
  mkdirSync(canonicalDir);
  const authPath = join(canonicalDir, "auth.json");
  writeFileSync(authPath, "TOKEN_CONTENT_MUST_NOT_APPEAR\n", { mode: 0o600 });
  symlinkSync(canonicalDir, aliasDir, "dir");
  try {
    const domain = resolveCredentialDomain(authPath);
    const alias = resolveCredentialDomain(join(aliasDir, "auth.json"));
    assert.equal(alias.credentialDomainId, domain.credentialDomainId);
    assert.match(domain.credentialDomainId, /^[0-9a-f]{64}$/);

    const owner = await acquireCredentialStartupLease(domain, "openai-codex", {
      timeoutMs: 100,
      heartbeatMs: 5_000,
    });
    const persisted = readFileSync(owner.path, "utf8");
    assert.equal(persisted.includes(root), false);
    assert.equal(persisted.includes("auth.json"), false);
    assert.equal(persisted.includes("TOKEN_CONTENT"), false);
    const projected = projectCredentialChildEvent({
      type: "agent_end",
      messages: [{ role: "assistant", content: "PRIVATE_TRANSCRIPT", errorMessage: "access_token_SENTINEL" }],
    });
    assert.deepEqual(projected.event, { type: "agent_end" });
    assert.equal(JSON.stringify(projected).includes("PRIVATE_TRANSCRIPT"), false);
    assert.equal(JSON.stringify(projected).includes("access_token_SENTINEL"), false);
    assert.deepEqual(projectCredentialChildEvent({
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "{\"status\":\"pass\"}" }] },
    }).event, {
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "{\"status\":\"pass\"}" }] },
    });
    const staleHeartbeat = JSON.parse(persisted) as Record<string, unknown>;
    staleHeartbeat.heartbeat = "2026-08-20T00:00:00.000Z";
    writeFileSync(owner.path, `${JSON.stringify(staleHeartbeat)}\n`, { mode: 0o600 });
    await assert.rejects(
      () => acquireCredentialStartupLease(domain, "openai-codex", {
        timeoutMs: 20,
        pollMs: 5,
        staleAfterMs: 1,
        processAlive: (pid) => pid === process.pid,
      }),
      (error) => error instanceof CredentialStartupError && error.code === "credential_lock_timeout",
    );
    assert.equal(existsSync(owner.path), true);
    owner.stop();

    const path = credentialLeasePath(domain, "openai-codex");
    writeFileSync(path, "{}\n", { mode: 0o600 });
    await assert.rejects(
      () => acquireCredentialStartupLease(domain, "openai-codex", { timeoutMs: 20, pollMs: 5 }),
      (error) => error instanceof CredentialStartupError && error.code === "credential_lock_stale",
    );
    assert.equal(readFileSync(path, "utf8"), "{}\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dead expired lease recovers, owner-only release holds, and probe cache stays provider/model/auth bound", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-credential-stale-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const authPath = join(agentDir, "auth.json");
  writeFileSync(authPath, "{}\n", { mode: 0o600 });
  const domain = resolveCredentialDomain(authPath);
  try {
    const seed = await acquireCredentialStartupLease(domain, "openai-codex", { timeoutMs: 50 });
    const path = seed.path;
    seed.stop();
    writeFileSync(path, `${JSON.stringify({
      version: 1,
      provider: "openai-codex",
      credentialDomainId: domain.credentialDomainId,
      instanceId: "dead-owner",
      pid: 999_999,
      acquiredAt: "2026-08-20T00:00:00.000Z",
      heartbeat: "2026-08-20T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    const reclaimPath = `${path}.reclaim.lock`;
    writeFileSync(reclaimPath, "crashed prior reclaimer\n", { mode: 0o600 });
    const recovered = await acquireCredentialStartupLease(domain, "openai-codex", {
      timeoutMs: 50,
      staleAfterMs: 1,
      pollMs: 1,
      processAlive: () => false,
    });
    assert.equal(recovered.instanceId === "dead-owner", false);

    const authRevisionId = credentialAuthRevisionId(domain);
    recordProbeSuccess({
      domain,
      provider: "openai-codex",
      model: "gpt-test",
      authRevisionId,
      leaseInstanceId: recovered.instanceId,
    });
    assert.equal(probeCacheIsFresh({
      domain,
      provider: "openai-codex",
      model: "gpt-test",
      authRevisionId,
      leaseInstanceId: recovered.instanceId,
    }), true);
    assert.equal(probeCacheIsFresh({
      domain,
      provider: "openai-codex",
      model: "other-model",
      authRevisionId,
      leaseInstanceId: recovered.instanceId,
    }), false);
    writeFileSync(authPath, "{\"changed\":true}\n", { mode: 0o600 });
    assert.equal(probeCacheIsFresh({
      domain,
      provider: "openai-codex",
      model: "gpt-test",
      authRevisionId: credentialAuthRevisionId(domain),
      leaseInstanceId: recovered.instanceId,
    }), false);
    invalidateProbeSuccess({
      domain,
      provider: "openai-codex",
      model: "gpt-test",
      leaseInstanceId: recovered.instanceId,
    });
    const authLink = join(root, "auth-link.json");
    linkSync(authPath, authLink);
    assert.throws(
      () => credentialAuthRevisionId(domain),
      (error) => error instanceof CredentialStartupError && error.code === "oauth_missing",
    );
    unlinkSync(authLink);

    const changed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    changed.instanceId = "different-owner";
    writeFileSync(path, `${JSON.stringify(changed)}\n`, { mode: 0o600 });
    assert.throws(
      () => recovered.stop(),
      (error) => error instanceof CredentialStartupError && error.code === "credential_lock_stale",
    );
    assert.equal(existsSync(path), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two credential-bound Pi children serialize authenticated startup then overlap", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-credential-child-"));
  const agentDir = join(root, "agent");
  const fakePi = join(root, "fake-pi");
  const lifecycleLog = join(root, "lifecycle.jsonl");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
  writeFileSync(fakePi, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const log = (type) => appendFileSync(process.env.FAKE_LIFECYCLE_LOG, JSON.stringify({ type, at: Date.now(), pid: process.pid }) + "\\n");
if (process.argv[2] === "--version") { process.stdout.write("0.84.2\\n"); process.exit(0); }
setTimeout(() => { log("agent_start"); process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n"); }, 120);
setTimeout(() => { log("message_start"); process.stdout.write(JSON.stringify({ type: "message_start", message: { role: "assistant" } }) + "\\n"); }, 180);
setTimeout(() => { log("agent_end"); process.stdout.write(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: "PRIVATE" }] }) + "\\n"); }, 500);
`, { mode: 0o700 });
  chmodSync(fakePi, 0o700);
  try {
    const domain = resolveCredentialDomain(join(agentDir, "auth.json"));
    const args = [
      resolve("dist/src/credential-startup.js"),
      "--provider", "openai-codex",
      "--model", "gpt-test",
      "--credential-agent-dir", agentDir,
      "--credential-domain-id", domain.credentialDomainId,
      "--pi-executable", fakePi,
      "--expected-version", "0.84.2",
      "--",
      "--mode", "json", "-p", "Task: review",
    ];
    const childEnv = { FAKE_LIFECYCLE_LOG: lifecycleLog };
    const [first, second] = await Promise.all([runChild(args, agentDir, childEnv), runChild(args, agentDir, childEnv)]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(first.stdout.includes("PRIVATE"), false);
    assert.equal(second.stdout.includes("PRIVATE"), false);
    const events = readFileSync(lifecycleLog, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      type: string;
      at: number;
      pid: number;
    });
    const runs = [...new Set(events.map((event) => event.pid))].map((pid) => events.filter((event) => event.pid === pid));
    const ordered = runs.sort((left, right) => left[0]!.at - right[0]!.at);
    const earlyStart = ordered[0]!.find((event) => event.type === "agent_start")!;
    const earlyReady = ordered[0]!.find((event) => event.type === "message_start")!;
    const earlyEnd = ordered[0]!.find((event) => event.type === "agent_end")!;
    const lateStart = ordered[1]!.find((event) => event.type === "agent_start")!;
    assert.ok(lateStart.at - earlyStart.at >= 100);
    assert.ok(lateStart.at >= earlyReady.at);
    assert.ok(lateStart.at < earlyEnd.at);

    const cacheOwner = await acquireCredentialStartupLease(domain, "openai-codex");
    const authRevisionId = credentialAuthRevisionId(domain);
    recordProbeSuccess({
      domain,
      provider: "openai-codex",
      model: "gpt-test",
      authRevisionId,
      leaseInstanceId: cacheOwner.instanceId,
    });
    cacheOwner.stop();
    writeFileSync(fakePi, `#!/usr/bin/env node
if (process.argv[2] === "--version") { process.stdout.write("0.84.2\\n"); process.exit(0); }
setTimeout(() => process.stdout.write(JSON.stringify({ type: "agent_start", at: Date.now(), pid: process.pid }) + "\\n"), 50);
setTimeout(() => process.stdout.write(JSON.stringify({ type: "message_start", at: Date.now(), pid: process.pid, message: { role: "assistant" } }) + "\\n"), 60);
setTimeout(() => { process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "raw Provider access_token_SENTINEL" } }) + "\\n"); process.stderr.write("raw Provider access_token_SENTINEL\\n"); process.exit(0); }, 100);
`, { mode: 0o700 });
    chmodSync(fakePi, 0o700);
    const failed = await runChild(args, agentDir);
    assert.equal(failed.code, 0);
    assert.equal(failed.stderr.includes("access_token_SENTINEL"), false);
    assert.equal(failed.stdout.includes("access_token_SENTINEL"), false);
    const cacheCheck = await acquireCredentialStartupLease(domain, "openai-codex");
    assert.equal(probeCacheIsFresh({
      domain,
      provider: "openai-codex",
      model: "gpt-test",
      authRevisionId,
      leaseInstanceId: cacheCheck.instanceId,
    }), false);
    cacheCheck.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two stale reclaimers atomically replace once without deleting the new active owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-credential-reclaim-race-"));
  const agentDir = join(root, "agent");
  const helper = join(root, "acquire.mjs");
  mkdirSync(agentDir);
  const authPath = join(agentDir, "auth.json");
  writeFileSync(authPath, "{}\n", { mode: 0o600 });
  const domain = resolveCredentialDomain(authPath);
  try {
    const seed = await acquireCredentialStartupLease(domain, "openai-codex");
    const leasePath = seed.path;
    seed.stop();
    writeFileSync(leasePath, `${JSON.stringify({
      version: 1,
      provider: "openai-codex",
      credentialDomainId: domain.credentialDomainId,
      instanceId: "dead-race-owner",
      pid: 999_999,
      acquiredAt: "2026-08-20T00:00:00.000Z",
      heartbeat: "2026-08-20T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    const moduleUrl = pathToFileURL(resolve("dist/src/credential-startup.js")).href;
    writeFileSync(helper, `import { acquireCredentialStartupLease, resolveCredentialDomain } from ${JSON.stringify(moduleUrl)};
import { join } from "node:path";
const domain = resolveCredentialDomain(process.argv[2]);
const lease = await acquireCredentialStartupLease(domain, "openai-codex", { timeoutMs: 2000, staleAfterMs: 1, pollMs: 1 });
process.stdout.write(lease.instanceId + "\\n");
await new Promise((resolve) => setTimeout(resolve, 10));
lease.stop();
`);
    const [first, second] = await Promise.all([
      runChild([helper, authPath], agentDir),
      runChild([helper, authPath], agentDir),
    ]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(first.stdout.trim() === second.stdout.trim(), false);
    assert.equal(existsSync(leasePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runChild(
  args: string[],
  agentDir: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code: number | null) => resolveExit({ code, stdout, stderr }));
  });
}
