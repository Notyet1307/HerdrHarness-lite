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

Reviewer validation 只收到 exact-HEAD 的 Git tracked files；不会继承 source worktree 的 `.git`、`node_modules`、虚拟环境或构建缓存。`reviewerValidationArgv` 必须是项目显式配置的自包含命令。example 的 Node.js 命令先在 disposable validation copy 内创建无 remote、禁用 hooks/GPG 的临时 Git snapshot，再按 tracked lockfile 执行 `npm ci --ignore-scripts --no-audit --no-fund` 和 `npm run verify`。需要真实 Git 历史、lifecycle script、private registry 或其他包管理器的项目必须替换整条固定 argv，不得复制 source `.git`、依赖 ambient 全局工具或继承 source worktree 的未跟踪依赖。

`workerCompaction.mode` 只接受 `disabled | controlled-threshold`。example、缺省值以及省略该字段的旧配置都安全解析为 `disabled`，迁移不会自动开启。只有明确的长任务 canary 才改为 `controlled-threshold`；变更只影响之后创建的 fresh Worker Attempt。

Worker 启用 Ponytail 时，extension 顺序必须严格为 bundled `worker-tools.js` 后接 `@dietrichgebert/ponytail` `4.9.0` 的 manifest entry。Harness 会强制 `PONYTAIL_DEFAULT_MODE=full`、`PONYTAIL_HIDE_STATUS=1`、`PONYTAIL_QUIET_STARTUP=1`；不要为 Ponytail 放宽 Worker UI allowlist。

`stateDir` 不得与 source 或 `worktreeRoot` 重叠。包含 token、OAuth 或 custom model credentials 的 canonical Pi 文件保持原位和私有 mode；不要复制到配置、Attempt 目录、日志或 ledger。Harness 只记录 canonical `auth.json` realpath 的 SHA-256 domain ID，并在 credential store 内的私有 coordination directory 写无 credential 内容的 startup lease/probe cache。

Worker 的主 `pi-agent` 与 bash/工具子进程使用不同的 Attempt-private agent directory。子进程若启动默认 Pi，允许在 `tool-agent` 创建严格空的 `{}` store；非空 `auth.json`、`models.json`、`settings.json` 或文件身份异常仍属于 credential integrity failure。不要通过删除现场文件或放宽主 `pi-agent` postflight 来恢复；应先核对两处目录的安全元数据，再按当前 operator action 使用 fresh Attempt。

Reviewer Review Axis 的 credential wrapper 使用 `HERDR_HARNESS_REVIEW_CANONICAL_PI_AGENT_DIR`，不得改回继承工具进程的 `PI_CODING_AGENT_DIR`。若 axis 在一秒左右以 `oauth_missing` 退出且 `tool-agent` 没有 canonical auth，先核对 wrapper 与该专用 env；不要把升级 `pi-subagents` 当作此故障的修复，也不要复制 auth 或把 tool-agent 当作 credential store。

wrapper 启动 credential launcher/child 时，其子进程 `PI_CODING_AGENT_DIR` 也必须等于专用 canonical env；只修 `--credential-agent-dir` 参数不足以让普通 child Pi 读取 OAuth。Analyst-advice approval 的 reason 会以 `Operator statement (untrusted)` 进入 fresh Attempt handoff；可写明已确认的验证命令、非 Secret 环境缺口和保留约束，但不得把它描述成新的 policy authority。

custom Reviewer 的 child 不经过 OAuth launcher，但同样必须只对子进程把 `PI_CODING_AGENT_DIR` 恢复为 `HERDR_HARNESS_REVIEW_CANONICAL_PI_AGENT_DIR`，否则会继承 top-level `tool-agent` 而看不到 canonical `models.json`。若两个 axis 都在约一秒内以 exit 1、0 tools、0 output 失败，先核对该 scoped env；不要复制 models.json 或把顶层 Reviewer 改回 canonical store。

`reviewer.axisConcurrency` 只接受 1 或 2。custom Provider 默认 2 并可显式改为 1；`credentialMode=canonical-oauth + provider=openai-codex` 无条件收紧为 1，Standards 完成并释放 axis startup lease 后才启动 Spec。

配置要求 Docker 时，preflight 只接受本地 Unix socket，并验证 daemon 与 Compose。不要把远端 Docker credential boundary 隐式带入 Attempt。

运行预算在新 Attempt 中固化，运行中修改配置不会延长旧 Attempt。Worker absolute deadline 在 preparation 时绑定；Reviewer 先独立受 validation total 约束，只有 exact-HEAD validation receipt 持久化并复核成功后，才在 Provider/pane side effect 前绑定完整 Reviewer runtime total。示例配置写出了当前默认值：Worker total/no-progress 为 90/15 分钟，Reviewer runtime 为 45/10 分钟，validation total 为 30 分钟，SIGTERM/SIGKILL grace 为 10/5 秒；旧配置省略这些块时使用相同默认值。调小前先用 disposable lane 验证目标命令最长静默区间。

Pi RPC 的 no-progress 只由 assistant message、tool execution、controlled compaction、明确 Provider retry、durable result 和 terminal/settled 事件刷新；unknown-safe observation 明确不刷新。`herdr-pi-cli` lane 改用 bounded `agent wait`，只对去除 queue/heartbeat/poll 行后的 terminal text digest 变化刷新进展；原文不落盘。Reviewer validation 是任意黑箱 argv，没有可信业务进展协议，因此只使用 validation total 硬上限；Controller-owned `validation_heartbeat` 仅证明 runner 仍存活，不能刷新或声称业务进展。重复读取状态和 Controller/Fleet heartbeat 都不刷新业务进展。`runtime-progress.json`/`validation-progress.json` 只保存时间、类型、计数、PID、result-present 与 digest，不保存 Provider 原文、token 或 transcript。

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
- Worker RPC snapshot 与配置一致：默认 `disabled`；显式 canary 才显示 `controlled-threshold`（75%、最多一次、overflow continuation=false）。Reviewer 始终显示 `disabled`；
- 要 claim 的 Issue/Map frontier 是本次明确允许推进的队列；
- 部署操作不会顺带启动 Worker 或 Reviewer。

### 运行时 preflight（不推进 workflow）

对一个 lane 运行当前配置绑定的 Pi/Provider 与可选本地 Docker 检查：

```bash
node dist/src/cli.js preflight \
  --config /ABSOLUTE/PATH/harness.config.json \
  --lane reviewer \
  --json
```

该命令先验证完整 Harness 配置，只接受 `worker` 或 `reviewer`。它不 claim Issue、不推进 Job、不取得 Controller lease，也不写 `state.json`；Provider probe 仍会使用 credential startup lease，并可能更新 canonical credential store 旁的私有 probe cache 与 `stateDir/preflight` 下的隔离 agent directory。JSON 只给出时间、配置 digest、lane、Docker 可用性、稳定 failure code 与 retryable 属性，不包含 auth path、Provider 原文、stderr 或 stack。

`ok=true` 只证明该次短检查成功，不能证明旧 Attempt 可交付，也不授权 retry。blocked Job 仍必须通过当前 `reassess` / `approve_retry` option 和 fresh Attempt 恢复。若 Controller 正在为同一 credential domain 启动 Attempt，startup lease 会串行化 probe；不要并发重复调用。

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

Review Axis 失败时，durable blocked summary 中的 `Harness Review Axis failure` 行是 Harness 生成的安全投影。使用 axis、固定 code、exit、timeout/interrupted/stopped/detached、turn/tool budget、tool count、duration 与 output byte count 判断失败形状；它不包含 child error、stderr、stack 或输出原文。固定预算是 10 turns + 2 grace，read/grep/find/ls 合计 16 soft / 24 hard；soft limit 要求从已有证据收尾，hard limit 只阻止新的只读检索。`retryable` 仍只是诊断属性，必须消费当前 operator option 才能恢复。缺少该行的旧 Attempt 不能靠猜测补写，应在修复投影后通过 fresh Reviewer 重新取证。

若备用模型不能生成完整 `runs.all` 参数，Reviewer gate 还接受一个 exact `herdr-harness-review-axis` + `Axis: Standards|Spec` task 简写，并由 Harness 补齐固定 workflow 字段。该兼容只减少格式负担，不提供 agent discovery、management action、任意 scope/async、非 fresh context 或额外工具；这些调用仍应被拒绝。

Short provider probe、Herdr `done`、Reviewer child completed 或 validation pass 均不足以宣告恢复。至少等新的 durable role result 和对应 Git gate。

## 9. 失败诊断与 Fleet 聚合

诊断命令只读项目 `state.json`、Controller 的 content-free `events.jsonl` 审计投影，以及 Attempt 目录中固定名称的 terminal/progress/Reviewer checkpoint receipt。它不读取 `runtime-events.jsonl`、objective/body、result 摘要、完整 Evidence、auth path、token、Provider 原始响应、stack 或私密 transcript，也不取得 Controller lease。

单项目采集最近 7 天或 30 天：

```bash
herdr-harness-lite diagnose --config /ABSOLUTE/PATH/harness.config.json --days 7
herdr-harness-lite diagnose --config /ABSOLUTE/PATH/harness.config.json --days 30
```

Fleet 聚合所有项目，或只看一个项目：

```bash
herdr-harness-fleet diagnose --config /ABSOLUTE/PATH/fleet.config.json --days 7
herdr-harness-fleet diagnose --config /ABSOLUTE/PATH/fleet.config.json --project PROJECT_ID --days 30
```

默认输出只有聚合视图；需要逐 Attempt 安全字段时显式加 `--json`。逐 Attempt 输出仍只包含结构化分类、计数、布尔值、桶和安全身份，不包含正文。Provider/model 使用分别带类型域的稳定 SHA-256 ID，因此可以跨窗口分组比较，但不会把误填到 selector 的凭据原样写入审计或输出。Harness 配置可选择项目 ID 以及 repo/Issue 脱敏：

```json
{
  "diagnostics": {
    "projectId": "product-api",
    "redactRepo": true,
    "redactIssue": true
  }
}
```

读取结果时先看 `partial`、`corrupt` 和 `unknown` 桶：

- 单个 receipt 损坏只把对应 Attempt 标为 `partial/corrupt`，不会中止其他项目或 Attempt；不得把 `unknown` 重新归入最接近的 failure code。
- 新版本会把安全 Attempt 元数据追加到既有 best-effort `events.jsonl` 审计。状态原子提交仍是 authority；audit append 降级、升级前遗留数据、Pi RPC 缺失 terminal，或所有 adapter 同时缺失 terminal/progress receipt 时会产生 `partial/unknown`，不能据此声称完整失败率。
- 7/30 天窗口按 durable Attempt/Job 时间、progress 时间或最后的文件创建事实过滤；使用 filesystem 时间的行会明确标为 partial。保留目标窗口内的项目 `stateDir`，不要为了统计手工补 receipt 或改 ledger。

`taxonomyDomain` 用于判断失败层：

- `execution`：Provider/model/runtime 确实未完成本次执行；查看 `failureDomain` 继续区分 `model`、`provider`、`rpc`、`credential`、`compaction` 或 `harness_policy`。
- `observation`：Harness 无法确认 terminal/continuation/liveness；即使 `resultPresent=true` 也不能当成交付成功，应先收敛同一 Attempt 的事实，不能重发 prompt。
- `acceptance`：durable result、identity、Git clean/exact HEAD、Reviewer validation 等验收失败；模型可能已经工作，但没有形成可交付 fixed point。
- `deterministic`：固定 validation/check 命令给出可重复非零结果；它不同于 Provider 或 runtime 波动。

`retryable` 只描述诊断，不授权恢复。自动恢复次数只统计 ledger 中明确、有限、可审计的 policy recovery；Analyst advice 不计为授权。

用于 A/B canary 时，先固定 Issue 类型、lane、Pi 版本、validation 命令、超时、Git 基线与运行时 adapter，只改变一个 Provider/model 或 runtime 配置。Fleet 禁止重复 repo，因此同一 repo 的 A/B 应顺序运行；并行 canary 必须使用彼此隔离的 disposable repo/project。分别采集相同天数，比较 `byFailureCode`、`byProviderModel`、context/output 桶、durable-result、compaction、partial 比例和最终 Job outcome。样本量不足、partial 比例不同或 Git/GitHub fixed point 未完成时，不据此扩大 rollout 或自动放宽 recovery policy。

## 10. 升级与回滚

升级前：

- 等到 lane quiescent；若 active Attempt 存在，先完成或保持 fail closed；
- 记录 source/deployed SHA、配置 digest、进程、heartbeat、ledger revision；
- 在 staging path 执行 `npm ci` 与 `npm run verify`；
- 不升级 Pi、`pi-subagents` 或其他依赖，除非独立兼容任务已经验证 exact protocol。

部署只替换源码/build artifacts 和 reviewed configuration。不要迁移或改写 ledger，除非有独立 schema migration、备份、测试与 rollback。

回滚恢复上一版 code/build/config 后，复核 exact SHA、单一 Controller、heartbeat、ledger revision 和 active Attempt。旧日志需要按 mtime 与本次重启时间解释。

## 11. 验证与证据

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
