# HerdrHarness Lite

HerdrHarness Lite 是一个单槽、持久化、fail-closed 的 GitHub Issue 交付控制器：它通过 fresh Worker/Reviewer Attempt、Git 验证、PR checks、merge observation 和归档交付一个符合准入条件的任务。

[English](./README.md)

## 项目定位

Controller 选择 OPEN、带 ready label、无人领取、无 OPEN blocker 的普通 Issue，或 strict Map frontier 的第一个 OPEN child。它在一个 JSON ledger 中拥有 workflow transition；GitHub、Git、durable role result、Herdr 与 Pi 各自保留自己的事实边界。

本项目不是通用多代理平台、并行调度器、操作系统 sandbox，也不替代 GitHub/Git 事实。Analyst 与 Telegram integration 永远不成为 workflow authority。

## 核心安全不变量

- 一个 Controller 写一个 `stateDir`；一次 tick 最多持久化一次 transition。
- Map 永不 claim，且不能跳过第一个 OPEN child。
- Worker/Reviewer 使用 fresh Attempt；blocked Agent 上下文不得续跑。
- Worker 完成必须有 Harness-owned durable result 与 Git verification。
- Reviewer 保持 fresh、read-only、exact-HEAD、双轴和独立验证。
- Runtime event、Herdr status、child completion 与短 probe 都只是观察事实。
- Analyst 只有建议权；policy 或精确 human gate 才能授权恢复。
- Pi RPC auto-retry 与 Pi 自有 auto-compaction 保持关闭。只有 Worker RPC 可使用 snapshot 绑定、最多一次的受控阈值压缩；Reviewer 压缩仍关闭。
- 凭据不进入 result、receipt、ledger、文档或复制出的 credential 文件。

## 前置依赖与精确安装

需要 Node.js `>=22.16.0`、Git、已登录目标仓库的 GitHub CLI、Herdr、Pi、Codex CLI，以及目标仓库的本地 checkout。只有启用 `preflight.dockerRequired` 时才要求 Docker。

```bash
npm ci
pi install npm:pi-subagents@0.42.1
pi install /ABSOLUTE/PATH/HerdrHarness-lite
npm run build
```

`npm ci` 会运行 package `prepare` 并生成 ignored `dist/`；源码更新后可以安全重复执行显式 build。

## 最小配置

把 [`harness.config.example.json`](./harness.config.example.json) 复制到仓库外的私有路径，然后替换：

- `repo`、`localPath`、`baseRef`；
- 独立的 `stateDir`、`worktreeRoot`、`herdr.session`；
- skill、extension、Analyst 与 validation 的绝对路径；
- Worker/Reviewer provider 与 model selector。

保持 example 中完整 role argv、ambient-discovery hardening flags、tools、thinking 和 extension 顺序。裸 `reviewerArgv` 的可见 provider/model 应与 active Reviewer profile 一致。`stateDir` 不得位于 source checkout 或 worktree root 内。

Worker 可选的第二个 extension 只能是 `@dietrichgebert/ponytail` `4.9.0`。声明后 Harness 强制 full mode，同时静默 status/startup UI；Worker UI request 的拒绝策略不会放宽。

运行前验证外部访问：

```bash
gh auth status
gh repo view OWNER/REPOSITORY
herdr session list --json
pi --version
```

## Build

```bash
npm run build
node dist/src/cli.js --help
```

`dist/` 是本地生成物，不得提交。

## Tick canary

`tick` 有写入副作用：它可能 preflight、claim Issue 或推进 active Job。只在 disposable lane 或明确授权的真实 frontier 上执行，并确认没有另一个 Controller 持有同一 `stateDir`。

```bash
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
node dist/src/cli.js tick --config /ABSOLUTE/PATH/harness.config.json
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
```

每次手动 tick 后都读回 ledger。`attempt_dispatched` 不等于完成。

## Run

Tick canary 与状态读回符合预期后：

```bash
node dist/src/cli.js run \
  --config /ABSOLUTE/PATH/harness.config.json \
  --poll-ms 15000
```

前台有界运行可加 `--max-cycles N`。Supervisor 可以重启进程，但不得为同一 state directory 启动第二个 writer。

## Status / decide

```bash
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json --operator
node dist/src/cli.js decide \
  --config /ABSOLUTE/PATH/harness.config.json \
  --option OPTION_ID \
  --actor 'maintainer identity' \
  --reason 'bounded evidence-based reason'
```

必须从当前 `status --operator` 获取 option；`decide` 会拒绝 stale binding。执行后再次读取 status，确认 durable effect。兼容 recovery 命令保留在 operator runbook。

## 文档导航

- [当前架构](./ARCHITECTURE.zh-CN.md)：实体、状态、权限、信任、链路、模块与兼容边界。
- [运维手册](./docs/runbooks/operator.zh-CN.md)：完整 setup、canary、run、recovery、upgrade 与 rollback。
- [Telegram integration](./integrations/hermes-telegram/README.md)：standalone Bridge 与 Hermes compatibility 配置。
- [Telegram cutover](./docs/runbooks/telegram-cutover.md)：部署、canary 与 rollback。
- [架构决策](./docs/adr/)：Attempt 完整性、context closure、retry ownership 与 TypedHandoff 的 durable reasons。
- [仓库指令](./AGENTS.md)：AI 阅读顺序与修改 gate。
