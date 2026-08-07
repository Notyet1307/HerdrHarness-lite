"""Deterministic Hermes status and exact approval commands for Herdr Harness Lite."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

_DEFAULT_CONFIG = Path.home() / ".config" / "herdr-harness-lite" / "hermes-telegram.json"
_MAX_ERROR = 300


def _handle(raw_args: str) -> str:
    parts = raw_args.strip().split()
    if not parts or (len(parts) == 1 and parts[0].lower() in {"status", "incident"}):
        return _status(parts[0].lower() if parts else "status")
    if len(parts) in {1, 2} and parts[0].lower() == "approve":
        return _approve(parts[1] if len(parts) == 2 else None)
    return "用法：/harness [status|incident|approve [challenge]]"


def _status(command: str) -> str:
    try:
        config_path, config = _config()
        result = _run_node(config, "statusScript", [command, "--config", str(config_path)])
    except Exception as error:
        return f"Harness 状态读取失败：{_bounded_error(str(error))}"
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        return f"Harness 状态读取失败：{_bounded_error(detail)}"
    return result.stdout.strip() or "Harness 状态命令没有返回内容。"


def _approve(token: str | None) -> str:
    try:
        config_path, config = _config()
        _assert_single_telegram_operator(config)
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
    config_path = Path(os.environ.get("HERDR_HARNESS_TELEGRAM_CONFIG", str(_DEFAULT_CONFIG))).expanduser()
    if not config_path.is_absolute() or not config_path.is_file() or config_path.is_symlink():
        raise RuntimeError("bridge config 不存在或不是绝对路径")
    if config_path.stat().st_mode & 0o022:
        raise RuntimeError("bridge config 不能被 group/other 写入")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise RuntimeError("bridge config 必须是 JSON object")
    return config_path, config


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


def _assert_single_telegram_operator(config: dict) -> None:
    expected = str(config.get("telegramAllowedUser", "")).strip()
    allowed = [value.strip() for value in os.environ.get("TELEGRAM_ALLOWED_USERS", "").split(",") if value.strip()]
    allow_all = any(os.environ.get(name, "").strip().lower() in {"1", "true", "yes"} for name in (
        "TELEGRAM_ALLOW_ALL_USERS",
        "GATEWAY_ALLOW_ALL_USERS",
    ))
    if not expected.isdigit() or allowed != [expected] or allow_all or os.environ.get("GATEWAY_ALLOWED_USERS", "").strip():
        raise RuntimeError("Telegram 审批身份门禁不满足：必须只有配置绑定的单一 allowlisted user")


def _bounded_error(value: str) -> str:
    return " ".join(value.split())[:_MAX_ERROR]


def register(ctx) -> None:
    if ctx.profile_name != "harness":
        return
    ctx.register_command(
        "harness",
        handler=_handle,
        description="Read Harness status or confirm one exact fresh retry.",
        args_hint="[status|incident|approve [challenge]]",
    )
