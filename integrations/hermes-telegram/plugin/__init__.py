"""Deterministic, read-only Hermes slash command for Herdr Harness Lite."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

_DEFAULT_CONFIG = Path.home() / ".config" / "herdr-harness-lite" / "hermes-telegram.json"
_MAX_ERROR = 300


def _handle(raw_args: str) -> str:
    parts = raw_args.strip().split()
    if len(parts) > 1 or (parts and parts[0].lower() not in {"status", "incident"}):
        return "用法：/harness [status|incident]"
    command = parts[0].lower() if parts else "status"
    try:
        config_path, node_bin, status_script = _runtime()
        result = subprocess.run(
            [str(node_bin), str(status_script), command, "--config", str(config_path)],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except Exception as error:
        return f"Harness 状态读取失败：{_bounded_error(str(error))}"
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        return f"Harness 状态读取失败：{_bounded_error(detail)}"
    return result.stdout.strip() or "Harness 状态命令没有返回内容。"


def _runtime() -> tuple[Path, Path, Path]:
    config_path = Path(os.environ.get("HERDR_HARNESS_TELEGRAM_CONFIG", str(_DEFAULT_CONFIG))).expanduser()
    if not config_path.is_absolute() or not config_path.is_file():
        raise RuntimeError("bridge config 不存在或不是绝对路径")
    if config_path.stat().st_mode & 0o022:
        raise RuntimeError("bridge config 不能被 group/other 写入")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    node_bin = Path(config.get("nodeBin", ""))
    status_script = Path(config.get("statusScript", ""))
    if not node_bin.is_absolute() or not node_bin.is_file() or not os.access(node_bin, os.X_OK):
        raise RuntimeError("nodeBin 必须是可执行的绝对文件路径")
    if not status_script.is_absolute() or not status_script.is_file():
        raise RuntimeError("statusScript 必须是绝对文件路径")
    return config_path, node_bin, status_script


def _bounded_error(value: str) -> str:
    return " ".join(value.split())[:_MAX_ERROR]


def register(ctx) -> None:
    if ctx.profile_name != "harness":
        return
    ctx.register_command(
        "harness",
        handler=_handle,
        description="Read the current Herdr Harness Lite status or incident.",
        args_hint="[status|incident]",
    )
