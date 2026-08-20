# Telegram transport cutover

本 runbook 只负责 Harness Telegram transport 的部署、canary 与 rollback。Harness ledger、policy 和 Controller 始终是 workflow authority；Bridge、Observer、Telegram 消息与 callback 只是 transport state。

## 前置条件

- 已选择 standalone Bridge 或 Hermes compatibility 中的一种 transport；同一 Bot Token 只能有一个 update consumer。
- 当前没有 running Worker/Reviewer Attempt，也没有未决 Telegram decision challenge。
- Harness 与 Bridge 的待部署提交已经各自通过 review 和完整验证。
- 已准备上一版二进制、配置和启动定义，能够不改 ledger 回滚。

## 切换前记录

记录以下 live facts，不使用旧日志代替：

- `status --operator` 输出与 active Job revision；
- Controller heartbeat；
- Observer state 与 Bridge update offset；
- Harness、Bridge 的本地和部署 SHA；
- Controller、Bridge、Observer 的进程或 LaunchAgent PID；
- 当前配置路径、mode、Bot update consumer；
- ledger 与 task worktree 的只读备份位置。

## 部署

1. 在 staging path 构建 Harness，并分别运行 Harness 与 Bridge 的完整验证。
2. 停止 Observer，再停止 Bridge，最后停止 Controller。
3. 复核三类进程均已退出；不要执行 `tick`，不要编辑 `state.json`。
4. 替换 reviewed code/build artifacts。只有 reviewed version 要求时才修改配置。
5. 先启动 Controller，再启动 Bridge，最后启动 Observer。
6. 确认只有一个 Bot update consumer，Controller heartbeat 恢复，Observer offset 单调前进。

## Canary

先运行只读 canary：

- `/harness status`；
- `/harness why`；
- `/harness evidence`；
- `/harness actions`；
- 一条 outbound card 到预期 private chat。

再在 disposable fixture lane 验证：

1. expired challenge 不改变 ledger；
2. stale revision challenge 不改变 ledger；
3. 一次 reassessment challenge 只产生预期的精确 ledger transition；
4. 重启 Observer 不重放历史 normal progress。

通过条件：Controller heartbeat 正常、Bridge offset 前进、目标 chat 收到 canary、没有 Telegram `409 Conflict`、没有历史通知 replay、生产 ledger revision 未被 canary 意外推进。

## Rollback

任一 canary 失败时：

1. 停止 Observer、Bridge、Controller；
2. 恢复上一版 code/build artifacts 与配置；
3. 按 Controller、Bridge、Observer 顺序启动；
4. 复核 heartbeat、offset、单一 Bot consumer 与 read-only status；
5. 保留当前 ledger、task worktrees、失败日志和 canary evidence，不回滚或手工重写业务状态。

Transport 配置与命令见 [`integrations/hermes-telegram/README.md`](../../integrations/hermes-telegram/README.md)。
