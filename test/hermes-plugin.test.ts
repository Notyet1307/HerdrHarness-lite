import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PYTHON = `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("harness_ops", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(module._handle(os.environ["HARNESS_TEST_ARGS"]))
`;

test("Hermes plugin keeps status read-only and requires one exact Telegram operator for approval", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-hermes-plugin-"));
  try {
    const config = join(root, "bridge.json");
    const script = join(root, "script.js");
    writeFileSync(script, "// fake\n", { encoding: "utf8", mode: 0o600 });
    writeFileSync(config, JSON.stringify({
      nodeBin: "/bin/echo",
      statusScript: script,
      approvalScript: script,
      telegramAllowedUser: "123456789",
    }), { encoding: "utf8", mode: 0o600 });

    const status = invoke(config, "status", "");
    assert.equal(status.status, 0);
    assert.match(status.stdout, /script\.js status --config/);

    const denied = invoke(config, "approve", "987654321");
    assert.equal(denied.status, 0);
    assert.match(denied.stdout, /审批身份门禁不满足/);

    const allowAllDenied = invoke(config, "approve", "123456789", "true");
    assert.match(allowAllDenied.stdout, /审批身份门禁不满足/);

    const allowed = invoke(config, "approve", "123456789");
    assert.equal(allowed.status, 0);
    assert.match(allowed.stdout, /script\.js request --config/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function invoke(config: string, args: string, allowedUser: string, allowAll = "") {
  return spawnSync("python3", ["-c", PYTHON, resolve("integrations/hermes-telegram/plugin/__init__.py")], {
    encoding: "utf8",
    timeout: 5_000,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      HERDR_HARNESS_TELEGRAM_CONFIG: config,
      HARNESS_TEST_ARGS: args,
      TELEGRAM_ALLOWED_USERS: allowedUser,
      TELEGRAM_ALLOW_ALL_USERS: allowAll,
      GATEWAY_ALLOW_ALL_USERS: "",
      GATEWAY_ALLOWED_USERS: "",
    },
  });
}
