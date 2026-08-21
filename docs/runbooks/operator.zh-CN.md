# HerdrHarness Lite 运维手册

本文是 Controller 的唯一完整运维入口。架构与安全边界见 [当前架构](../../ARCHITECTURE.zh-CN.md)；Telegram transport 见 [integration README](../../integrations/hermes-telegram/README.md)。

## 1. 不变量

- 一个 `stateDir` 只能有一个 Controller writer。
- `tick` 是有副作用命令，可能 preflight、claim Issue 或推进 Job。
- 每个 lane 使用独立的 `stateDir`、`worktreeRoot` 和 `herdr.session`。
- 不编辑生产 `state.json`，不删除 active worktree，不复用 blocked Agent。
- 不把 Herdr/Pi 状态、短 probe 或通知送达当成交付完成。
- 恢复只消费 `status --operator` 当前投影的精确 option。

## 2. 安装与构建

要求 Node.js `>=22.16.0`、Git、已登录目标仓库的 GitHub CLI、Herdr、Pi、Codex CLI，以及可用的 target repository。

```bash
npm ci
pi install npm:pi-subagents@0.42.1
pi install /ABSOLUTE/PATH/HerdrHarness-lite
npm run build
```

`npm ci` 会通过 `prepare` 生成 ignored `dist/`；显式 `npm run build` 可在更新源码后重建入口。不要提交 `dist/`。

验证外部工具：

```bash
gh auth status
gh repo view OWNER/REPOSITORY
herdr session list --json
pi --version
codex --version
```

## 3. 配置

复制 `harness.config.example.json` 到仓库外的私有路径。至少替换：

- `repo`、`localPath`、`baseRef`；
- `stateDir`、`worktreeRoot`；
- `herdr.session`；
- `analyst.command` 与 argv 中的绝对路径；
- Worker/Reviewer 的 skill、extension 绝对路径；
- provider/model selection 与 `reviewerValidationArgv`。

保持 example 中 ambient-discovery hardening flags、tools、thinking、extension 顺序和 role contract 完整。启用 `reviewerProviderProfiles` 时，裸 `reviewerArgv` selector 应与 active profile 可见值一致；Controller 会在 future Attempt preparation 时绑定 active selection。

Worker 启用 Ponytail 时，extension 顺序必须严格为 bundled `worker-tools.js` 后接 `@dietrichgebert/ponytail` `4.9.0` 的 manifest entry。Harness 会强制 `PONYTAIL_DEFAULT_MODE=full`、`PONYTAIL_HIDE_STATUS=1`、`PONYTAIL_QUIET_STARTUP=1`；不要为 Ponytail 放宽 Worker UI allowlist。

`stateDir` 不得与 source 或 `worktreeRoot` 重叠。包含 token、OAuth 或 custom model credentials 的 canonical Pi 文件保持原位和私有 mode；不要复制到配置、Attempt 目录、日志或 ledger。Harness 只记录 canonical `auth.json` realpath 的 SHA-256 domain ID，并在 credential store 内的私有 coordination directory 写无 credential 内容的 startup lease/probe cache。

`reviewer.axisConcurrency` 只接受 1 或 2。custom Provider 默认 2 并可显式改为 1；`credentialMode=canonical-oauth + provider=openai-codex` 无条件收紧为 1，Standards 完成并释放 axis startup lease 后才启动 Spec。

配置要求 Docker 时，preflight 只接受本地 Unix socket，并验证 daemon 与 Compose。不要把远端 Docker credential boundary 隐式带入 Attempt。

运行预算在新 Attempt preparation 时固化，运行中修改配置不会延长旧 Attempt。示例配置写出了当前默认值：Worker total/no-progress 为 90/15 分钟，Reviewer 为 45/10 分钟，validation total 为 30 分钟，SIGTERM/SIGKILL grace 为 10/5 秒；旧配置省略这些块时使用相同默认值。调小前先用 disposable lane 验证目标命令最长静默区间。

Pi RPC 的 no-progress 只由 assistant message、tool execution、controlled compaction、明确 Provider retry、durable result 和 terminal/settled 事件刷新。`herdr-pi-cli` lane 改用 bounded `agent wait`，只对去除 queue/heartbeat/poll 行后的 terminal text digest 变化刷新进展；原文不落盘。Reviewer validation 使用 Controller-owned validation heartbeat，no-progress 取 Reviewer no-progress 与 validation total 的较小值，total 始终是硬上限。重复读取状态和 Controller/Fleet heartbeat 都不刷新业务进展。`runtime-progress.json`/`validation-progress.json` 只保存时间、类型、计数、PID、result-present 与 digest，不保存 Provider 原文、token 或 transcript。

`runtime_stall` 表示已 dispatch 后超过 no-progress，`attempt_deadline` 表示无论期间是否持续进展都到达 total。两者都会写 terminate intent，经过 bounded SIGTERM/SIGKILL 收尾并要求 fresh Attempt；不得向旧 Attempt 重发 prompt。若 `terminated.json` 未确认，先核对 owned pane、runner/child PID 与 heartbeat，再按当前 operator option 处理，不能手工伪造 receipt。

OAuth startup 的稳定诊断为 `credential_lock_timeout`、`credential_lock_stale`、`oauth_refresh_timeout`、`oauth_missing`、`oauth_probe_failed`。前两项先检查同 credential domain 的 owner PID/heartbeat；malformed lease 不得手工删除。只有确认 PID 已死且 heartbeat 已超时后，下一次 acquisition 才会自动回收。诊断与 receipt 不包含 auth path、token、Provider 原始响应或 transcript。

## 4. 启动前检查

每次启动或升级前记录：

```bash
git rev-parse HEAD
git status --short
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json --operator
```

另外确认：

- 没有另一个 `run` / `tick` 进程持有同一 Controller lease；
- configured Herdr session 可达；
- target checkout 与 worktree root 存在且权限正确；
- 当前 active Job、Attempt phase、Incident、operator actions 与 ledger revision 已被理解；
- Worker RPC snapshot 显示 `controlled-threshold`（75%、最多一次、overflow continuation=false），Reviewer 仍显示 `disabled`；
- 要 claim 的 Issue/Map frontier 是本次明确允许推进的队列；
- 部署操作不会顺带启动 Worker 或 Reviewer。

## 5. Tick canary

先在 disposable lane 或明确允许推进的真实 lane 使用单步 `tick`：

```bash
node dist/src/cli.js tick --config /ABSOLUTE/PATH/harness.config.json
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
```

一次只执行一个 `tick`，读回输出和 ledger 后再继续。常见 action 只是当前一步，例如 `selected`、`claimed`、`worktree_created`、`attempt_prepared`、`attempt_pane_ready`、`attempt_agent_ready` 或 `attempt_dispatched`；它们都不等于交付完成。

发生 `preflight_failed` 时，确认没有产生 claim 或新的 runtime side effect。发生 `blocked` 时停止手动推进，先读取 Incident、Analysis 与 operator projection。

## 6. 连续运行

Tick canary 与状态读回符合预期后再启动：

```bash
node dist/src/cli.js run \
  --config /ABSOLUTE/PATH/harness.config.json \
  --poll-ms 15000
```

`run` 持有 Controller lease，并循环调用 `tick`。前台验证可加 `--max-cycles N`；生产守护进程应由 launchd/systemd 等 supervisor 管理 stdout/stderr 和 restart policy，但 supervisor 不得并发启动第二个 writer。

正常停止使用 supervisor 或向该进程发送正常终止信号。停止后复核进程、lease、heartbeat 和 ledger；不要以一条旧错误日志判断当前进程仍失败。

## 7. 状态与人工决策

只读状态：

```bash
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json --operator
```

`--operator` 返回当前 Job 摘要和可消费 actions。选择 action 后使用它的 ID：

```bash
node dist/src/cli.js decide \
  --config /ABSOLUTE/PATH/harness.config.json \
  --option OPTION_ID \
  --actor 'maintainer identity' \
  --reason 'bounded evidence-based reason'
```

`decide` 会重新加载 ledger 并拒绝 stale option。执行后必须再次读取 `status --operator`，确认预期 durable effect，而不是只相信 CLI exit code。

`approve`、`reassess`、`resolve-decision` 和 `cancel` 仍是使用 revision/Incident/Analysis 参数的 compatibility entrypoints。新操作优先使用 `decide --option`；在生产调用方盘点与迁移完成前不要删除这些入口。

## 8. Blocked 与恢复

处理 blocked Job：

`validation_infrastructure` 表示 Controller 在 Reviewer Provider 启动前遇到 spawn、路径、权限、超时或环境故障；正常非零退出是 `failed-checks` 审查证据，不属于该 Incident。此类恢复仍需 Analyst advice 与精确 human approval，并创建 fresh Reviewer Attempt。

1. 记录当前 HEAD、Job revision、Attempt、Incident、Analysis 和 operator actions。
2. 区分 runtime liveness、durable result、Git fixed point、GitHub checks 与 ledger truth。
3. 保留 dirty worktree、result、receipt、Controller log 和 bounded evidence；不要先清理现场。
4. Analyst `hold` 只表示无执行授权。需要新证据时消费 reassessment option。
5. 只有当前 `approve_retry` 或 `resolve_decision` option 能授权 fresh retry。
6. 授权后由 Controller 关闭旧 pane、生成 TypedHandoff 并创建 fresh Attempt。
7. 读回新 revision 和 Attempt identity；不得向旧 Agent 手工发送续跑 prompt。

same-HEAD Reviewer fresh retry 可能携带 `reviewerCheckpointInputs`。只读核对 source Attempt、stage、path/digest 和新 Attempt plan；不要手工创建、编辑、复制或改权限来“修复” `reviewer-preflight.json`、`standards-axis.json`、`spec-axis.json`、`validation-receipt.json` 或 `reviewer-final.json`。无效 checkpoint 应由 Controller 拒绝并重跑缺失阶段或 fail closed。即使 `reviewer-final.json` 存在，也必须等待 fresh Reviewer 的 durable `review_submit` result、exact HEAD 与 clean-tree gate。

Short provider probe、Herdr `done`、Reviewer child completed 或 validation pass 均不足以宣告恢复。至少等新的 durable role result 和对应 Git gate。

## 9. 升级与回滚

升级前：

- 等到 lane quiescent；若 active Attempt 存在，先完成或保持 fail closed；
- 记录 source/deployed SHA、配置 digest、进程、heartbeat、ledger revision；
- 在 staging path 执行 `npm ci` 与 `npm run verify`；
- 不升级 Pi、`pi-subagents` 或其他依赖，除非独立兼容任务已经验证 exact protocol。

部署只替换源码/build artifacts 和 reviewed configuration。不要迁移或改写 ledger，除非有独立 schema migration、备份、测试与 rollback。

回滚恢复上一版 code/build/config 后，复核 exact SHA、单一 Controller、heartbeat、ledger revision 和 active Attempt。旧日志需要按 mtime 与本次重启时间解释。

## 10. 验证与证据

仓库改动至少运行：

```bash
npm ci
npm run typecheck
npm test
npm run verify
git diff --check
git ls-files dist
node dist/src/cli.js --help
```

`git ls-files dist` 必须无输出。验证报告应分别说明：代码/测试完成、PR/checks、merge、部署和真实 runtime canary；这些阶段不能互相代替。
