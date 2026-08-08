"""Deterministic Hermes status and exact approval commands for Herdr Harness Lite."""

from __future__ import annotations

import asyncio
import html
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

_DEFAULT_CONFIG = Path.home() / ".config" / "herdr-harness-lite" / "hermes-telegram.json"
_MAX_ERROR = 300
_MAX_CARD_INPUT = 16_384
_CALLBACK_PREFIX = "hh:"


def _handle(raw_args: str) -> str:
    parts = raw_args.strip().split()
    try:
        routing = _routing()
    except Exception as error:
        return f"Harness 配置读取失败：{_bounded_error(str(error))}"
    if not routing[0]:
        route = routing[2][""]
        if not parts or (len(parts) == 1 and parts[0].lower() in {"status", "incident"}):
            return _status(route, parts[0].lower() if parts else "status")
        if len(parts) in {1, 2} and parts[0].lower() == "approve":
            return _approve(route, routing[1], parts[1] if len(parts) == 2 else None)
        return "用法：/harness [status|incident|approve [challenge]]"

    if not parts or (len(parts) == 1 and parts[0].lower() == "status"):
        return _fleet_status(routing)
    if parts[0].lower() in {"incident", "approve"}:
        return "Fleet 模式必须指定 lane：/harness <lane> [status|incident|approve [challenge]]"
    lane = parts[0].lower()
    if lane not in routing[2]:
        return f"未知 Harness lane：{_bounded_error(lane)}"
    route = routing[2][lane]
    if len(parts) == 1 or (len(parts) == 2 and parts[1].lower() in {"status", "incident"}):
        return _status(route, parts[1].lower() if len(parts) == 2 else "status", lane)
    if len(parts) in {2, 3} and parts[1].lower() == "approve":
        return _approve(route, routing[1], parts[2] if len(parts) == 3 else None)
    return "用法：/harness [status|<lane> [status|incident|approve [challenge]]]"


def _status(route: tuple[Path, dict], command: str, lane: str | None = None) -> str:
    try:
        config_path, config = route
        result = _run_node(config, "statusScript", [command, "--config", str(config_path)])
    except Exception as error:
        return f"Harness 状态读取失败：{_bounded_error(str(error))}"
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        return f"Harness 状态读取失败：{_bounded_error(detail)}"
    output = result.stdout.strip() or "Harness 状态命令没有返回内容。"
    return f"【{lane}】\n{output}" if lane else output


def _fleet_status(routing: tuple[bool, str, dict[str, tuple[Path, dict]]]) -> str:
    lines = ["Harness Fleet"]
    for lane, (config_path, config) in routing[2].items():
        try:
            result = _run_node(config, "statusScript", ["summary", "--config", str(config_path)])
            if result.returncode != 0:
                detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
                lines.append(f"{lane} · ERROR · {_bounded_error(detail)}")
            else:
                summary = " ".join(result.stdout.split()) or "状态命令没有返回内容"
                lines.append(f"{lane} · {summary}")
        except Exception as error:
            lines.append(f"{lane} · ERROR · {_bounded_error(str(error))}")
    lines.append("详情：/harness <lane> [status|incident]")
    return "\n".join(lines)


def _approve(route: tuple[Path, dict], expected_user: str, token: str | None) -> str:
    try:
        config_path, config = route
        _assert_single_telegram_operator(expected_user)
        command = "confirm" if token else "request"
        input_text = json.dumps({"token": token}) if token else None
        result = _run_node(config, "approvalScript", [command, "--config", str(config_path)], input_text)
    except Exception as error:
        return f"Harness 批准失败：{_bounded_error(str(error))}"
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        return f"Harness 批准失败：{_bounded_error(detail)}"
    return result.stdout.strip() or "Harness 批准命令没有返回内容。"


def _config() -> tuple[Path, dict]:
    return _load_json_config(os.environ.get("HERDR_HARNESS_TELEGRAM_CONFIG", str(_DEFAULT_CONFIG)), "bridge config")


def _routing() -> tuple[bool, str, dict[str, tuple[Path, dict]]]:
    fleet_value = os.environ.get("HERDR_HARNESS_FLEET_CONFIG", "").strip()
    if not fleet_value:
        config_path, config = _config()
        return False, _expected_user(config, "bridge config"), {"": (config_path, config)}

    _, fleet = _load_json_config(fleet_value, "fleet config")
    expected_user = _expected_user(fleet, "fleet config")
    lanes = fleet.get("lanes")
    if not isinstance(lanes, dict) or not lanes:
        raise RuntimeError("fleet config lanes 必须是非空 JSON object")
    if any(not isinstance(lane, str) or not _valid_lane_id(lane) for lane in lanes):
        raise RuntimeError("fleet lane 必须是 1-32 位小写字母、数字或连字符")

    routes: dict[str, tuple[Path, dict]] = {}
    seen_paths: set[str] = set()
    for lane in sorted(lanes):
        bridge_path, bridge = _load_json_config(lanes[lane], f"lane {lane} bridge config")
        canonical_path = str(bridge_path.resolve())
        if canonical_path in seen_paths:
            raise RuntimeError("fleet lanes 不能复用同一个 bridge config")
        seen_paths.add(canonical_path)
        if bridge.get("laneId") != lane:
            raise RuntimeError(f"lane {lane} 的 bridge config laneId 不匹配")
        if _expected_user(bridge, f"lane {lane} bridge config") != expected_user:
            raise RuntimeError(f"lane {lane} 的 telegramAllowedUser 与 fleet 不匹配")
        routes[lane] = (bridge_path, bridge)
    return True, expected_user, routes


def _load_json_config(path_value: object, label: str) -> tuple[Path, dict]:
    if not isinstance(path_value, str) or not path_value.strip():
        raise RuntimeError(f"{label} 不存在或不是绝对路径")
    config_path = Path(path_value).expanduser()
    if not config_path.is_absolute() or not config_path.is_file() or config_path.is_symlink():
        raise RuntimeError(f"{label} 不存在或不是绝对路径")
    if config_path.stat().st_mode & 0o022:
        raise RuntimeError(f"{label} 不能被 group/other 写入")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise RuntimeError(f"{label} 必须是 JSON object")
    return config_path, config


def _expected_user(config: dict, label: str) -> str:
    raw = config.get("telegramAllowedUser")
    if not isinstance(raw, str):
        raise RuntimeError(f"{label} telegramAllowedUser 必须是单个数字 Telegram user id")
    value = raw.strip()
    if not (3 <= len(value) <= 20 and value[0] in "123456789" and all(char in "0123456789" for char in value)):
        raise RuntimeError(f"{label} telegramAllowedUser 必须是单个数字 Telegram user id")
    return value


def _valid_lane_id(value: str) -> bool:
    return 1 <= len(value) <= 32 and value[0] != "-" and all(char in "abcdefghijklmnopqrstuvwxyz0123456789-" for char in value)


def _route_for_callback(
    routing: tuple[bool, str, dict[str, tuple[Path, dict]]],
    lane: str | None,
) -> tuple[Path, dict]:
    if routing[0]:
        if lane is None or lane not in routing[2]:
            raise ValueError("unknown fleet lane")
        return routing[2][lane]
    route = routing[2][""]
    if lane is not None and lane != route[1].get("laneId"):
        raise ValueError("single-instance callback names a different lane")
    return route


def _run_node(config: dict, script_key: str, args: list[str], input_text: str | None = None):
    node_bin = Path(config.get("nodeBin", ""))
    script = Path(config.get(script_key, ""))
    if not node_bin.is_absolute() or not node_bin.is_file() or not os.access(node_bin, os.X_OK):
        raise RuntimeError("nodeBin 必须是可执行的绝对文件路径")
    if not script.is_absolute() or not script.is_file():
        raise RuntimeError(f"{script_key} 必须是绝对文件路径")
    return subprocess.run(
        [str(node_bin), str(script), *args],
        input=input_text,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
        env={
            "HOME": str(Path.home()),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        },
    )


def _assert_single_telegram_operator(expected: str) -> None:
    allowed = [value.strip() for value in os.environ.get("TELEGRAM_ALLOWED_USERS", "").split(",") if value.strip()]
    allow_all = any(os.environ.get(name, "").strip().lower() in {"1", "true", "yes"} for name in (
        "TELEGRAM_ALLOW_ALL_USERS",
        "GATEWAY_ALLOW_ALL_USERS",
    ))
    if allowed != [expected] or allow_all or os.environ.get("GATEWAY_ALLOWED_USERS", "").strip():
        raise RuntimeError("Telegram 审批身份门禁不满足：必须只有配置绑定的单一 allowlisted user")


def _bounded_error(value: str) -> str:
    return " ".join(value.split())[:_MAX_ERROR]


def _parse_callback(value: object) -> tuple[str, str | None, str]:
    if not isinstance(value, str) or len(value.encode("utf-8")) > 64:
        raise ValueError("invalid callback")
    parts = value.split(":")
    if len(parts) == 3:
        prefix, action, token = parts
        lane = None
    elif len(parts) == 4:
        prefix, action, lane, token = parts
        if not _valid_lane_id(lane):
            raise ValueError("invalid callback lane")
    else:
        raise ValueError("invalid callback shape")
    if token != token.strip():
        raise ValueError("invalid callback token")
    if prefix != "hh" or action not in {"a", "h"} or len(token) != 16 or any(char not in "0123456789ABCDEF" for char in token):
        raise ValueError("invalid callback data")
    return action, lane, token


def _setup_card_cli(_parser) -> None:
    """The card payload is accepted only on stdin."""


def _send_card_command(_args) -> int:
    raw = sys.stdin.read(_MAX_CARD_INPUT + 1)
    if len(raw) > _MAX_CARD_INPUT:
        raise RuntimeError("card payload 过长")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("card payload 不是 JSON") from error
    _send_card(payload)
    return 0


def _send_card(payload: object) -> None:
    routing = _routing()
    _assert_single_telegram_operator(routing[1])
    if not isinstance(payload, dict):
        raise RuntimeError("card payload 必须是 JSON object")
    text = payload.get("text")
    approve_label = payload.get("approveLabel")
    approve_callback = payload.get("approveCallback")
    hold_callback = payload.get("holdCallback")
    if not isinstance(text, str) or not text or len(text) > 3900:
        raise RuntimeError("card text 无效")
    if not isinstance(approve_label, str) or not approve_label or len(approve_label) > 64:
        raise RuntimeError("approve label 无效")
    try:
        approve_action, approve_lane, approve_token = _parse_callback(approve_callback)
        hold_action, hold_lane, hold_token = _parse_callback(hold_callback)
        if approve_action != "a" or hold_action != "h" or approve_lane != hold_lane or approve_token != hold_token:
            raise ValueError("mismatched callbacks")
        _route_for_callback(routing, approve_lane)
    except ValueError as error:
        raise RuntimeError("callback data 无效") from error

    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token or any(char.isspace() for char in token) or len(token) > 256:
        raise RuntimeError("TELEGRAM_BOT_TOKEN 未配置或无效")
    body = json.dumps({
        "chat_id": routing[1],
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
        "reply_markup": {
            "inline_keyboard": [
                [{"text": approve_label, "callback_data": approve_callback}],
                [{"text": "⏸️ 保持阻塞", "callback_data": hold_callback}],
            ],
        },
    }, ensure_ascii=False).encode("utf-8")
    request = Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise RuntimeError(f"Telegram sendMessage HTTP {error.code}") from error
    except (URLError, TimeoutError, OSError) as error:
        raise RuntimeError(f"Telegram sendMessage 失败：{type(error).__name__}") from error
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise RuntimeError("Telegram sendMessage 返回失败")


async def _handle_callback(query, data: str) -> None:
    try:
        routing = _routing()
        _assert_single_telegram_operator(routing[1])
        expected_user = routing[1]
        caller = str(getattr(getattr(query, "from_user", None), "id", "")).strip()
        if caller != expected_user:
            await query.answer(text="⛔ 审批身份不匹配")
            return
        try:
            action, lane, token = _parse_callback(data)
            config_path, config = _route_for_callback(routing, lane)
        except ValueError:
            await query.answer(text="⚠️ 无效的 Harness 决策")
            return
    except Exception as error:
        await query.answer(text=f"⚠️ Harness 配置错误：{_bounded_error(str(error))}")
        return

    await query.answer(text="正在校验 Harness 精确绑定…")
    command = "confirm" if action == "a" else "hold"
    try:
        result = await asyncio.to_thread(
            _run_node,
            config,
            "approvalScript",
            [command, "--config", str(config_path), "--json"],
            json.dumps({"token": token}),
        )
        payload = json.loads(result.stdout) if result.stdout.strip() else {}
    except Exception as error:
        await _edit_callback(query, f"⚠️ 未执行：{_bounded_error(str(error))}", keep_buttons=True)
        return

    if result.returncode == 0 and isinstance(payload, dict) and payload.get("ok") is True:
        label = "✅ 已批准；等待 Controller 重新校验" if command == "confirm" else "⏸️ 已选择保持阻塞；未写入恢复批准"
        await _edit_callback(query, label, keep_buttons=False)
        return

    detail = payload.get("message") if isinstance(payload, dict) else None
    if not isinstance(detail, str) or not detail.strip():
        detail = result.stderr.strip() or f"exit {result.returncode}"
    terminal = bool(payload.get("terminal")) if isinstance(payload, dict) else False
    await _edit_callback(query, f"⚠️ 未执行：{_bounded_error(detail)}", keep_buttons=not terminal)


async def _edit_callback(query, outcome: str, *, keep_buttons: bool) -> None:
    message = getattr(query, "message", None)
    original = getattr(message, "text_html", None)
    if not isinstance(original, str):
        original = html.escape(str(getattr(message, "text", "") or ""))
    marker = "\n\n🧾 <b>操作结果</b>"
    base = original.split(marker, 1)[0]
    text = f"{base}{marker}\n{html.escape(outcome)}"
    try:
        await query.edit_message_text(
            text=text,
            parse_mode="HTML",
            reply_markup=getattr(message, "reply_markup", None) if keep_buttons else None,
        )
    except Exception:
        pass


def register(ctx) -> None:
    if ctx.profile_name != "harness":
        return
    ctx.register_command(
        "harness",
        handler=_handle,
        description="Read one Harness or Fleet status and confirm one exact fresh retry.",
        args_hint="[status|<lane> [status|incident|approve [challenge]]]",
    )
    ctx.register_telegram_callback_handler(_CALLBACK_PREFIX, _handle_callback)
    ctx.register_cli_command(
        name="harness-card",
        help="Send one bound Harness approval card",
        setup_fn=_setup_card_cli,
        handler_fn=_send_card_command,
        description="Internal delivery command for the Harness Telegram observer.",
    )
