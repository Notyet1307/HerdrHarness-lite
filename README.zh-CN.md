# HerdrHarness Lite

HerdrHarness Lite 是一个持久化、fail-closed 的 GitHub Issue 交付控制器。每个项目一次交付一个符合准入条件的 Issue，通过 fresh Worker/Reviewer Attempt、Git 验证、PR checks、merge observation 和归档完成闭环。可选的 Fleet Supervisor 让多个彼此隔离的项目同时运行，但不会合并它们的 workflow authority。

[English](./README.md)

## 项目定位

项目 Controller 选择 OPEN、带 ready label、无人领取、无 OPEN blocker 的普通 Issue，或 strict Map frontier 的第一个 OPEN child。它在一个 JSON ledger 中拥有 workflow transition；GitHub、Git、durable role result、Herdr 与 Pi 各自保留自己的事实边界。

Fleet 是独立的进程生命周期层：每个项目对应一个单项目 Controller 进程，并强制拒绝共享 repo、source checkout、state directory、worktree root 和 Herdr session。

本项目不是通用多代理平台、项目内并行调度器、操作系统 sandbox，也不替代 GitHub/Git 事实。Analyst、Fleet 与 Telegram integration 永远不成为 workflow authority。

## 核心安全不变量

- 一个 Controller 写一个项目 `stateDir`；一次 tick 最多持久化一次 transition。
- Map 永不 claim，且不能跳过第一个 OPEN child。
- Worker/Reviewer 使用 fresh Attempt；blocked Agent 上下文不得续跑。
- Worker 完成必须有 Harness-owned durable result 与 Git verification。
- Reviewer 保持 fresh、read-only、exact-HEAD 和双轴；固定验证由 Controller 在 Provider 启动前独立执行并绑定 receipt。
- Reviewer 阶段 checkpoint 只在 Harness private state 中原子创建、digest 绑定且最多跨 fresh Attempt 复用一次；checkpoint 本身不是 review pass。
- Runtime event、Herdr status、child completion 与短 probe 都只是观察事实。
- Analyst 只有建议权；policy 或精确 human gate 才能授权恢复。
- Pi RPC auto-retry 与 Pi 自有 auto-compaction 保持关闭。Worker compaction 默认关闭，只有显式 `controlled-threshold` 才启用 snapshot 绑定、最多一次的受控阈值压缩；Reviewer 压缩仍关闭。
- 凭据不进入 result、receipt、ledger、文档或复制出的 credential 文件。
- 多项目共享 canonical OAuth 时，以 auth realpath digest 绑定跨进程 startup lease；openai-codex Reviewer axes 默认串行，custom Provider 可配置 1 或 2。
- Fleet 只管理项目进程，不写项目 workflow transition。
- 单项目 `run` 响应 `SIGINT`/`SIGTERM`，中断 poll sleep 后通过正常 `finally` 释放 heartbeat 与 Controller lease。
- 每个 Fleet 项目必须拥有独立 repo、source checkout、state、worktree root 和 Herdr session。

## 前置依赖与精确安装

需要 Node.js `>=22.16.0`、Git、已登录目标仓库的 GitHub CLI、Herdr、Pi、Codex CLI，以及每个目标仓库的本地 checkout。只有项目启用 `preflight.dockerRequired` 时才要求 Docker。

```bash
npm ci
pi install npm:pi-subagents@0.42.1
pi install /ABSOLUTE/PATH/HerdrHarness-lite
npm run build
```

`npm ci` 会运行 package `prepare` 并生成 ignored `dist/`；源码更新后可以安全重复执行显式 build。

## 单项目配置

把 [`harness.config.example.json`](./harness.config.example.json) 复制到仓库外的私有路径，然后替换：

- `repo`、`localPath`、`baseRef`；
- 独立的 `stateDir`、`worktreeRoot`、`herdr.session`；
- skill、extension、Analyst 与 validation 的绝对路径；
- Worker/Reviewer provider 与 model selector。

保持 example 中完整 role argv、ambient-discovery hardening flags、tools、thinking 和 extension 顺序。裸 `reviewerArgv` 的可见 provider/model 应与 active Reviewer profile 一致。`localPath`、`stateDir` 和 `worktreeRoot` 必须两两隔离。

Worker 可选的第二个 extension 只能是 `@dietrichgebert/ponytail` `4.9.0`。声明后 Harness 强制 full mode，同时静默 status/startup UI；Worker UI request 的拒绝策略不会放宽。

`workerCompaction.mode` 只接受 `disabled` 或 `controlled-threshold`。示例和缺省值均为 `disabled`；旧配置省略该字段时也不会自动开启。只应在明确的长任务 canary 中显式启用 controlled 模式。

运行前验证外部访问：

```bash
gh auth status
gh repo view OWNER/REPOSITORY
herdr session list --json
pi --version
node dist/src/cli.js preflight --config /ABSOLUTE/PATH/harness.config.json --lane reviewer --json
```

`preflight` 会验证完整 Harness 配置，并为一个精确 lane 执行当前绑定的 Pi/Provider 与可选本地 Docker 检查。它不 claim Issue、不推进 Job，也不写 `state.json`；但可能更新私有 credential probe cache 与 preflight agent directory。有界 JSON 只包含配置 digest、lane、Docker 可用性以及稳定 failure code/retryability。

## Build

```bash
npm run build
node dist/src/cli.js --help
node dist/src/fleet-cli.js --help
node dist/src/transport-cli.js project status --config /PRIVATE/PATH/project-observer-v2.json --json v2
node dist/src/transport-cli.js fleet status --config /PRIVATE/PATH/fleet-observer.json --json v2
```

`dist/` 是本地生成物，不得提交。

## 单项目 Tick canary

`tick` 有写入副作用：它可能 preflight、claim Issue 或推进 active Job。blocked lane 的健康检查应先使用上面的非 workflow `preflight`；只在 disposable lane 或明确授权的真实 frontier 上执行 `tick`，并确认没有另一个 Controller 持有同一项目 `stateDir`。

```bash
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
node dist/src/cli.js tick --config /ABSOLUTE/PATH/harness.config.json
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
```

每次手动 tick 后都读回 ledger。`attempt_dispatched` 不等于完成。

## 单项目 Run / decide

```bash
node dist/src/cli.js run \
  --config /ABSOLUTE/PATH/harness.config.json \
  --poll-ms 15000

node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json --operator
node dist/src/cli.js decide \
  --config /ABSOLUTE/PATH/harness.config.json \
  --option OPTION_ID \
  --actor 'maintainer identity' \
  --reason 'bounded evidence-based reason'
```

前台有界运行可加 `--max-cycles N`。Supervisor 不得为同一项目 state directory 启动第二个 writer。

必须从当前 `status --operator` 获取 option；`decide` 会拒绝 stale binding。执行后再次读取 status，确认 durable effect。兼容 recovery 命令保留在 operator runbook。

## 多项目 Fleet Supervisor

项目内仍然是单写、单槽 Controller。项目之间能够并发，是因为 Fleet 为每个项目启动独立的单项目 CLI 进程，而不是让一个 Controller 同时拥有多份 ledger。

```bash
cp fleet.config.example.json /PRIVATE/PATH/fleet.config.json

node dist/src/fleet-cli.js validate --config /PRIVATE/PATH/fleet.config.json
node dist/src/fleet-cli.js tick --config /PRIVATE/PATH/fleet.config.json
node dist/src/fleet-cli.js run --config /PRIVATE/PATH/fleet.config.json
node dist/src/fleet-cli.js status --config /PRIVATE/PATH/fleet.config.json --operator
```

一个项目阻塞、崩溃、退避或触发熔断时，其他项目继续运行。已经存活的 Controller 会被标记为 `adopted`，Fleet 不启动第二写者。完整说明见 [Fleet 手册](./docs/fleet.zh-CN.md) 和 [配置 Schema](./schemas/fleet.config.schema.json)。

## Controller 模块边界

`src/controller.ts` 只保留状态分发和公开兼容入口，具体流程按变化原因拆分：

- `task-lifecycle.ts`：选择、领取、worktree、归档；
- `attempt-preparation.ts`：不可变执行计划与上下文绑定；
- `attempt-driver.ts`：pane、Agent、dispatch、wait；
- `attempt-settlement.ts`：Worker/Reviewer 结果收口；
- `runtime-preflight.ts`、`attempt-integrity.ts`：runtime 与 Git gate；
- `reviewer-validation.ts`、`reviewer-checkpoints.ts`：固定验证与 fresh aggregation checkpoint；
- `delivery.ts`：PR、CI、base refresh、merge；
- `recovery-flow.ts`、`automatic-recovery.ts`：Analyst 证据，以及 policy fresh retry 的授权和副作用复核；
- `config-validation.ts`：路径与角色契约。

公开的 `HarnessController` 构造器和 `tick()` 合同保持不变。

## 文档导航

- [当前架构](./ARCHITECTURE.zh-CN.md)：已有实体、状态、权限、信任和链路。
- [Controller/Fleet ADR](./docs/adr/0004-modular-controller-and-project-fleet.md)：本轮改造的长期边界。
- [Fleet 运行手册](./docs/fleet.zh-CN.md)：多项目配置、隔离、监督和恢复。
- [运维手册](./docs/runbooks/operator.zh-CN.md)：单项目 setup、canary、run、recovery、upgrade 与 rollback。
- [Provider/runtime canary](./docs/runbooks/provider-runtime-canary.zh-CN.md)：独立 A/B 矩阵、中断恢复、压力组与报告。
- [Telegram integration](./integrations/hermes-telegram/README.md)：standalone Bridge 与 Hermes compatibility 配置。
- [Telegram cutover](./docs/runbooks/telegram-cutover.md)：部署、canary 与 rollback。
- [架构决策](./docs/adr/)：Attempt 完整性、context closure、retry ownership、受控压缩与 Fleet 隔离的长期决策。
- [仓库指令](./AGENTS.md)：AI 阅读顺序与修改 gate。
