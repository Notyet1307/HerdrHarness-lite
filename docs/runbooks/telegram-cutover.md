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

## v2 滚动发布

1. 先部署接受 v1/v2 的 Bridge；继续接收旧 Observer v1 payload。
2. 部署 Harness v2 projection 和 Observer；所有 Project Observer 的
   `transportVersion` 仍保持省略或 `1`。
3. 运行 project/fleet `status|health|diagnose --json v2` 只读 canary。
4. 将一个 disposable Project Observer 改为 `transportVersion: 2`，验证后再逐个切换其余项目。
5. 最后加载独立 Fleet Observer；它不发送项目 workflow incident。
6. 重新执行 Bridge `sync-commands` 并读回四项菜单。

## Canary

先运行本地与只读 canary：

```bash
cd /absolute/path/to/harness-telegram-bridge
npm ci
npm run verify
node src/bridge.js sync-commands --config /absolute/bridge.json

cd /absolute/path/to/HerdrHarness-lite
npm ci
npm run verify
node dist/src/hermes-observer.js run --config /absolute/project-observer-v2.json --once
node dist/src/fleet-observer.js run --config /absolute/fleet-observer.json --once
node scripts/check-telegram-transport-contract.mjs ../harness-telegram-bridge
```

- `/harness`（真实 Fleet 首页）；
- `/harness why`；
- `/harness actions`；
- `/harness_health`；
- `/harness_diagnose ROUTE 7`；
- 一条 outbound card 到预期 private chat。

再在 disposable fixture lane 验证：

1. expired challenge 不改变 ledger；
2. stale revision challenge 不改变 ledger；
3. 一次 reassessment challenge 只产生预期的精确 ledger transition；
4. 重启 Project Observer、Fleet Observer 和 Bridge 不重放当前正常状态；
5. provider pre-side-effect transient 的 lane、safe Provider ID、failure code、notBefore、fresh Attempt、verified boundary 与 quota facts 正确；
6. workflow `blocked` 不被渲染为 Controller/Fleet 进程不健康；
7. 同一个 Bot Token 只有一个 `getUpdates` consumer。

通过条件：Controller heartbeat 正常、Bridge offset 前进、目标 chat 收到 canary、没有 Telegram `409 Conflict`、没有历史通知 replay、生产 ledger revision 未被 canary 意外推进。

## Rollback

任一 canary 失败时：

1. 将 Project Observer `transportVersion` 改回 1；
2. 停止 Fleet Observer；
3. 保留 Bridge 的 v1 compatibility，不修改 ledger、approval challenge 或 Bot Token；
4. 必要时再恢复上一版 Bridge code/config；
5. 复核 heartbeat、offset、单一 Bot consumer 与 read-only status；
6. 保留当前 ledger、task worktrees、失败日志和 canary evidence，不回滚或手工重写业务状态。

Transport 配置与命令见 [`integrations/hermes-telegram/README.md`](../../integrations/hermes-telegram/README.md)。
