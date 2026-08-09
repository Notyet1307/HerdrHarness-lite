import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimePreflightCli } from "../src/adapters/runtime-preflight.js";
import type { CommandResult, CommandRunner } from "../src/adapters/command.js";

class RecordingRunner implements CommandRunner {
  calls: Array<{
    command: string;
    args: string[];
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
  }> = [];

  constructor(
    private readonly responses: CommandResult[],
    private readonly onRun?: () => void,
  ) {}

  run(command: string, args: string[], options: {
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
  } = {}): CommandResult {
    this.calls.push({ command, args: [...args], ...options });
    this.onRun?.();
    const response = this.responses.shift();
    if (!response) throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    return response;
  }
}

test("Pi inspection resolves and versions one exact executable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-pi-"));
  const executable = join(directory, "pi-test");
  writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  const runner = new RecordingRunner([ok("0.84.0\n")]);
  const result = await new RuntimePreflightCli(runner, { PATH: directory }).inspectPi({ cwd: "/repo", piBin: "pi-test" });

  assert.deepEqual(result, { executable: realpathSync(executable), version: "0.84.0" });
  assert.equal(runner.calls[0]?.command, realpathSync(executable));
  assert.deepEqual(runner.calls[0]?.args, ["--version"]);
});

test("ambient Pi SYSTEM prompts fail closed while an empty bound agent directory is accepted", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-pi-context-"));
  const cwd = join(root, "repo");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const preflight = new RuntimePreflightCli(new RecordingRunner([]), { PI_CODING_AGENT_DIR: agentDir });
  assert.deepEqual(await preflight.assertNoAmbientSystemPrompt({ cwd }), { agentDir: realpathSync(agentDir) });

  writeFileSync(join(agentDir, "SYSTEM.md"), "ambient\n");
  await assert.rejects(() => preflight.assertNoAmbientSystemPrompt({ cwd }), /ambient Pi system prompt is not allowed/);
});

test("RPC Provider preflight excludes ambient auth and uses the Attempt-private agent directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-pi-rpc-preflight-"));
  const sourceAgentDir = join(root, "source-agent");
  const isolatedAgentDir = join(root, "runtime", "pi-agent");
  mkdirSync(sourceAgentDir);
  writeFileSync(join(sourceAgentDir, "auth.json"), '{"oauth":"must-not-share"}\n', { mode: 0o600 });
  writeFileSync(join(sourceAgentDir, "models.json"), "{}\n", { mode: 0o600 });
  const runner = new RecordingRunner([ok("HERDR_HARNESS_PROVIDER_OK\n")]);
  try {
    await new RuntimePreflightCli(runner, {
      STATIC_API_KEY: "available",
      PI_CODING_AGENT_DIR: sourceAgentDir,
    }).probeProvider({
      lane: "worker",
      cwd: "/repo",
      piBin: "/opt/pi",
      agentDir: isolatedAgentDir,
      roleArgv: [
        "--no-approve",
        "--skill", "/private/implement",
        "--provider", "provider-a",
        "--model", "model-a",
        "--tools", "read,bash,write",
        "--thinking", "max",
      ],
    });

    assert.deepEqual(runner.calls, [{
      command: "/opt/pi",
      args: [
        "--no-session", "--no-approve", "--no-skills", "--no-extensions",
        "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-tools",
        "--provider", "provider-a", "--model", "model-a", "--thinking", "max",
        "-p", "Reply with exactly HERDR_HARNESS_PROVIDER_OK",
      ],
      cwd: "/repo",
      timeoutMs: 120_000,
      env: { STATIC_API_KEY: "available", PI_CODING_AGENT_DIR: isolatedAgentDir },
    }]);
    assert.equal(readFileSync(join(sourceAgentDir, "auth.json"), "utf8"), '{"oauth":"must-not-share"}\n');
    assert.equal(lstatSync(join(isolatedAgentDir, "auth.json")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(isolatedAgentDir, "auth.json"), "utf8").trim(), "{}");
    assert.equal(existsSync(join(isolatedAgentDir, "models.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Provider preflight rejects a successful process with no model marker", async () => {
  const runner = new RecordingRunner([ok("provider banner only\n")]);
  await assert.rejects(() => new RuntimePreflightCli(runner, {}).probeProvider({
    lane: "reviewer",
    cwd: "/repo",
    piBin: "pi",
    roleArgv: ["--thinking", "max"],
  }), /no success marker/);
});

test("RPC Provider preflight rejects credentials persisted into private auth", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-pi-rpc-auth-write-"));
  const isolatedAgentDir = join(root, "runtime", "pi-agent");
  const runner = new RecordingRunner([ok("HERDR_HARNESS_PROVIDER_OK\n")], () => {
    const authPath = join(isolatedAgentDir, "auth.json");
    chmodSync(authPath, 0o600);
    writeFileSync(authPath, '{"oauth":"persisted"}\n');
  });
  try {
    await assert.rejects(() => new RuntimePreflightCli(runner, {}).probeProvider({
      lane: "worker",
      cwd: "/repo",
      piBin: "/opt/pi",
      agentDir: isolatedAgentDir,
      roleArgv: ["--provider", "provider-a", "--model", "model-a"],
    }), /isolated auth must remain empty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docker preflight binds the active local Unix socket and proves daemon plus Compose V2", async () => {
  const runner = new RecordingRunner([
    ok('[{"Endpoints":{"docker":{"Host":"unix:///tmp/docker.sock"}}}]\n'),
    ok("28.3.2\n"),
    ok("2.39.1\n"),
  ]);
  const result = await new RuntimePreflightCli(runner, {}).probeDocker({ cwd: "/repo" });

  assert.deepEqual(result, { host: "unix:///tmp/docker.sock" });
  assert.deepEqual(runner.calls.map(({ command, args }) => ({ command, args })), [
    { command: "docker", args: ["context", "inspect"] },
    { command: "docker", args: ["--host", "unix:///tmp/docker.sock", "version", "--format", "{{.Server.Version}}"] },
    { command: "docker", args: ["--host", "unix:///tmp/docker.sock", "compose", "version", "--short"] },
  ]);
});

test("Docker preflight refuses remote contexts that would need unbound credentials", async () => {
  const runner = new RecordingRunner([
    ok('[{"Endpoints":{"docker":{"Host":"tcp://example.test:2376"}}}]\n'),
  ]);
  await assert.rejects(
    () => new RuntimePreflightCli(runner, {}).probeDocker({ cwd: "/repo" }),
    /requires a local Unix socket/,
  );
  assert.equal(runner.calls.length, 1);
});

function ok(stdout: string): CommandResult {
  return { ok: true, code: 0, stdout, stderr: "", error: null };
}
