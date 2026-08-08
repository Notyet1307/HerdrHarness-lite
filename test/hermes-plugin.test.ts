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

const PYTHON_CARD = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("harness_ops", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
captured = {}
class Response:
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self): return b'{"ok":true}'
def fake_urlopen(request, timeout):
    captured["body"] = json.loads(request.data)
    captured["timeout"] = timeout
    return Response()
module.urlopen = fake_urlopen
module._send_card(json.loads(os.environ["HARNESS_TEST_CARD"]))
print(json.dumps(captured, ensure_ascii=False))
`;

const PYTHON_REGISTER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("harness_ops", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Context:
    profile_name = "harness"
    def __init__(self): self.calls = []
    def register_command(self, name, **kwargs): self.calls.append(["command", name])
    def register_telegram_callback_handler(self, prefix, callback): self.calls.append(["callback", prefix])
    def register_cli_command(self, **kwargs): self.calls.append(["cli", kwargs["name"]])
ctx = Context()
module.register(ctx)
print(json.dumps(ctx.calls))
`;

const PYTHON_CALLBACK = `
import asyncio, importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("harness_ops", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
captured = {}
class Result:
    returncode = 0
    stdout = '{"ok":true,"action":"approved"}'
    stderr = ''
def fake_run_node(config, script_key, args, input_text=None):
    captured["args"] = args
    captured["input"] = json.loads(input_text)
    captured["lane"] = config.get("laneId")
    return Result()
module._run_node = fake_run_node
class User: id = 123456789
class Message:
    text_html = '<b>Harness card</b>'
    text = 'Harness card'
    reply_markup = 'buttons'
class Query:
    from_user = User()
    message = Message()
    async def answer(self, **kwargs): captured["answer"] = kwargs
    async def edit_message_text(self, **kwargs): captured["edit"] = kwargs
asyncio.run(module._handle_callback(Query(), os.environ.get("HARNESS_TEST_CALLBACK", 'hh:a:0123456789ABCDEF')))
print(json.dumps(captured, ensure_ascii=False))
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

test("Hermes plugin registers the callback seam and sends a vertical approval keyboard", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-hermes-card-plugin-"));
  try {
    const config = join(root, "bridge.json");
    writeFileSync(config, JSON.stringify({ telegramAllowedUser: "123456789" }), { encoding: "utf8", mode: 0o600 });
    const plugin = resolve("integrations/hermes-telegram/plugin/__init__.py");
    const registered = spawnSync("python3", ["-c", PYTHON_REGISTER, plugin], {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.equal(registered.status, 0);
    assert.deepEqual(JSON.parse(registered.stdout), [
      ["command", "harness"],
      ["callback", "hh:"],
      ["cli", "harness-card"],
    ]);

    const card = {
      text: "🚨 <b>Harness 需要人工决定</b>",
      approveLabel: "批准：全新 Reviewer",
      approveCallback: "hh:a:0123456789ABCDEF",
      holdCallback: "hh:h:0123456789ABCDEF",
    };
    const sent = spawnSync("python3", ["-c", PYTHON_CARD, plugin], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        HERDR_HARNESS_FLEET_CONFIG: "",
        HERDR_HARNESS_TELEGRAM_CONFIG: config,
        HARNESS_TEST_CARD: JSON.stringify(card),
        TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_WITHOUT_WHITESPACE",
        TELEGRAM_ALLOWED_USERS: "123456789",
        TELEGRAM_ALLOW_ALL_USERS: "",
        GATEWAY_ALLOW_ALL_USERS: "",
        GATEWAY_ALLOWED_USERS: "",
      },
    });
    assert.equal(sent.status, 0, sent.stderr);
    const body = JSON.parse(sent.stdout).body;
    assert.equal(body.chat_id, "123456789");
    assert.equal(body.parse_mode, "HTML");
    assert.equal(body.reply_markup.inline_keyboard.length, 2);
    assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, card.approveCallback);
    assert.equal(body.reply_markup.inline_keyboard[0][0].style, "primary");
    assert.equal(body.reply_markup.inline_keyboard[1][0].text, "保持阻塞");

    const callback = spawnSync("python3", ["-c", PYTHON_CALLBACK, plugin], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        HERDR_HARNESS_FLEET_CONFIG: "",
        HERDR_HARNESS_TELEGRAM_CONFIG: config,
        TELEGRAM_ALLOWED_USERS: "123456789",
        TELEGRAM_ALLOW_ALL_USERS: "",
        GATEWAY_ALLOW_ALL_USERS: "",
        GATEWAY_ALLOWED_USERS: "",
      },
    });
    assert.equal(callback.status, 0, callback.stderr);
    const callbackResult = JSON.parse(callback.stdout);
    assert.equal(callbackResult.args[0], "confirm");
    assert.equal(callbackResult.input.token, "0123456789ABCDEF");
    assert.equal(callbackResult.edit.reply_markup, null);
    assert.match(callbackResult.edit.text, /等待 Controller 重新校验/);

    writeFileSync(config, JSON.stringify({ laneId: "exposure", telegramAllowedUser: "123456789" }), { encoding: "utf8", mode: 0o600 });
    const laneCard = {
      ...card,
      approveCallback: "hh:a:exposure:0123456789ABCDEF",
      holdCallback: "hh:h:exposure:0123456789ABCDEF",
    };
    const laneSent = spawnSync("python3", ["-c", PYTHON_CARD, plugin], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        HERDR_HARNESS_FLEET_CONFIG: "",
        HERDR_HARNESS_TELEGRAM_CONFIG: config,
        HARNESS_TEST_CARD: JSON.stringify(laneCard),
        TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_WITHOUT_WHITESPACE",
        TELEGRAM_ALLOWED_USERS: "123456789",
        TELEGRAM_ALLOW_ALL_USERS: "",
        GATEWAY_ALLOW_ALL_USERS: "",
        GATEWAY_ALLOWED_USERS: "",
      },
    });
    assert.equal(laneSent.status, 0, laneSent.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes Fleet aggregates status and routes cards or callbacks to one fixed lane", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-hermes-fleet-plugin-"));
  try {
    const script = join(root, "script.js");
    const exposure = join(root, "exposure.json");
    const tailmux = join(root, "tailmux.json");
    const fleet = join(root, "fleet.json");
    writeFileSync(script, "// fake\n", { encoding: "utf8", mode: 0o600 });
    const bridge = (laneId: string) => ({
        laneId,
        nodeBin: "/bin/echo",
        statusScript: script,
        approvalScript: script,
        telegramAllowedUser: "123456789",
    });
    for (const [path, laneId] of [[exposure, "exposure"], [tailmux, "tailmux"]] as const) {
      writeFileSync(path, JSON.stringify(bridge(laneId)), { encoding: "utf8", mode: 0o600 });
    }
    writeFileSync(fleet, JSON.stringify({
      telegramAllowedUser: "123456789",
      lanes: { exposure, tailmux },
    }), { encoding: "utf8", mode: 0o600 });

    const overview = invokeFleet(fleet, "", "123456789");
    assert.equal(overview.status, 0, overview.stderr);
    assert.match(overview.stdout, /Harness Fleet/);
    assert.match(overview.stdout, new RegExp(`exposure .* summary --config ${exposure}`));
    assert.match(overview.stdout, new RegExp(`tailmux .* summary --config ${tailmux}`));

    const incident = invokeFleet(fleet, "tailmux incident", "123456789");
    assert.equal(incident.status, 0, incident.stderr);
    assert.match(incident.stdout, new RegExp(`tailmux.*script\\.js incident --config ${tailmux}`, "s"));

    const approval = invokeFleet(fleet, "exposure approve", "123456789");
    assert.equal(approval.status, 0, approval.stderr);
    assert.match(approval.stdout, new RegExp(`script\\.js request --config ${exposure}`));
    assert.match(invokeFleet(fleet, "approve", "123456789").stdout, /必须指定 lane/);
    assert.match(invokeFleet(fleet, "unknown status", "123456789").stdout, /未知 Harness lane/);

    const card = {
      text: "🚨 <b>Exposure 需要人工决定</b>",
      approveLabel: "批准：全新 Reviewer",
      approveCallback: "hh:a:exposure:0123456789ABCDEF",
      holdCallback: "hh:h:exposure:0123456789ABCDEF",
    };
    const sent = spawnSync("python3", ["-c", PYTHON_CARD, resolve("integrations/hermes-telegram/plugin/__init__.py")], {
      encoding: "utf8",
      timeout: 5_000,
      env: fleetEnv(fleet, { HARNESS_TEST_CARD: JSON.stringify(card), TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_WITHOUT_WHITESPACE" }),
    });
    assert.equal(sent.status, 0, sent.stderr);
    assert.equal(JSON.parse(sent.stdout).body.reply_markup.inline_keyboard[0][0].callback_data, card.approveCallback);

    const callback = spawnSync("python3", ["-c", PYTHON_CALLBACK, resolve("integrations/hermes-telegram/plugin/__init__.py")], {
      encoding: "utf8",
      timeout: 5_000,
      env: fleetEnv(fleet, { HARNESS_TEST_CALLBACK: "hh:a:tailmux:0123456789ABCDEF" }),
    });
    assert.equal(callback.status, 0, callback.stderr);
    const callbackResult = JSON.parse(callback.stdout);
    assert.equal(callbackResult.lane, "tailmux");
    assert.equal(callbackResult.args[2], tailmux);
    assert.equal(callbackResult.input.token, "0123456789ABCDEF");

    const unknown = spawnSync("python3", ["-c", PYTHON_CALLBACK, resolve("integrations/hermes-telegram/plugin/__init__.py")], {
      encoding: "utf8",
      timeout: 5_000,
      env: fleetEnv(fleet, { HARNESS_TEST_CALLBACK: "hh:a:missing:0123456789ABCDEF" }),
    });
    assert.equal(unknown.status, 0, unknown.stderr);
    const unknownResult = JSON.parse(unknown.stdout);
    assert.ok(!("args" in unknownResult));
    assert.match(unknownResult.answer.text, /无效的 Harness 决策/);

    const mismatched = { ...card, holdCallback: "hh:h:tailmux:0123456789ABCDEF" };
    const rejected = spawnSync("python3", ["-c", PYTHON_CARD, resolve("integrations/hermes-telegram/plugin/__init__.py")], {
      encoding: "utf8",
      timeout: 5_000,
      env: fleetEnv(fleet, { HARNESS_TEST_CARD: JSON.stringify(mismatched), TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_WITHOUT_WHITESPACE" }),
    });
    assert.ok(rejected.status !== 0);
    assert.match(rejected.stderr, /callback data 无效/);

    writeFileSync(tailmux, JSON.stringify(bridge("wrong-lane")), { encoding: "utf8", mode: 0o600 });
    assert.match(invokeFleet(fleet, "", "123456789").stdout, /bridge config laneId 不匹配/);
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
      HERDR_HARNESS_FLEET_CONFIG: "",
      HERDR_HARNESS_TELEGRAM_CONFIG: config,
      HARNESS_TEST_ARGS: args,
      TELEGRAM_ALLOWED_USERS: allowedUser,
      TELEGRAM_ALLOW_ALL_USERS: allowAll,
      GATEWAY_ALLOW_ALL_USERS: "",
      GATEWAY_ALLOWED_USERS: "",
    },
  });
}

function invokeFleet(config: string, args: string, allowedUser: string) {
  return spawnSync("python3", ["-c", PYTHON, resolve("integrations/hermes-telegram/plugin/__init__.py")], {
    encoding: "utf8",
    timeout: 5_000,
    env: fleetEnv(config, { HARNESS_TEST_ARGS: args, TELEGRAM_ALLOWED_USERS: allowedUser }),
  });
}

function fleetEnv(config: string, extra: Record<string, string>) {
  return {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: "1",
    HERDR_HARNESS_FLEET_CONFIG: config,
    HERDR_HARNESS_TELEGRAM_CONFIG: "",
    TELEGRAM_ALLOWED_USERS: "123456789",
    TELEGRAM_ALLOW_ALL_USERS: "",
    GATEWAY_ALLOW_ALL_USERS: "",
    GATEWAY_ALLOWED_USERS: "",
    ...extra,
  };
}
