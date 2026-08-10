# HerdrHarness Lite

[English](./README.md) | 简体中文

HerdrHarness Lite 是一个小型、失败关闭的 GitHub Issue 交付控制器。它用持久状态机协调 GitHub、Git、Herdr、Pi Worker、独立 Reviewer 和 Codex Analyst；agent 会话、终端输出、通知和聊天回复都不是交付事实。

Herdr 仍持有 worktree 与持久 pane。Worker 和顶层 Reviewer Attempt 默认使用 interactive Pi，也可以按各自 lane 独立选择 Herdr pane 中受监督的 Pi RPC runner。当前推荐的 Telegram 路径不再依赖 Hermes；Hermes 只保留为向后兼容的传输方式。

## 先读这里

- **运行或恢复：**按顺序执行“Agent 操作手册”，遵守每一步的停止条件。
- **部署 Telegram：**先读“当前架构”，再读 [`integrations/hermes-telegram/README.md`](./integrations/hermes-telegram/README.md)。
- **修改 Controller：**先读“系统如何运行”“能力与边界”和实现入口。
- **追溯设计：**阅读 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md)；当分析文档与代码、配置或测试不一致时，以后三者为当前事实。

## 当前架构

控制面与通知面刻意保持独立：

```text
控制面
GitHub + Git <-> Controller <-> 持久 ledger
                    |-> Herdr pane -> fresh Pi Reviewer（interactive 或 durable RPC runner）
                    |-> Herdr pane -> fresh Pi Worker（interactive 或 durable RPC runner）
                    `-> 需要补充证据时调用 task-bound Codex Analyst

通知与操作面
ledger + Controller JSONL + heartbeat
                    -> Observer -> deliveryCommand -> 独立 Telegram Bridge -> Bot
Telegram /harness + callbacks
                    -> Bridge -> status / approval CLI -> Harness policy + ledger CAS
```

Harness Core 是唯一的工作流权威。Controller 负责自动迁移；operator 写入只能经过精确 recovery gate 与 ledger CAS。Observer 消失、通知延迟或 Telegram 离线都不会改变任务事实，也不会授予恢复权限。

| 组件 | 职责 | 权限边界 |
| --- | --- | --- |
| Controller（`src/controller.ts`） | 每个 `tick` 至多一次持久迁移；执行 effect、验证、恢复、发布和 merge 观察 | 在状态目录排他 lease 下唯一自动写入状态迁移 |
| Herdr + Pi | worktree/pane 宿主与 fresh Worker/Reviewer 执行；每条 lane 均可选择受监督 RPC runner | 只提供运行与活性；RPC terminal、Herdr 状态都不能替代 durable result 与 Harness Git 验证 |
| Codex Analyst | 为 blocked job 做有界证据分析 | 只能建议 `hold` 或策略允许的 fresh retry；不能批准或写状态 |
| Observer（`src/hermes-observer.ts`） | 读取 ledger、Controller JSONL 和 heartbeat，维护可重试通知 outbox | 没有工作流状态权限；只能创建传输 outbox/challenge 状态。文件名为兼容性保留，standalone 模式不需要 Hermes |
| [Harness Telegram Bridge](https://github.com/Notyet1307/harness-telegram-bridge) | 发送卡片，轮询 `/harness` 与 callback，调用已有 status/approval CLI | 只负责传输；仅保存 Telegram offset，不直接编辑 ledger |
| Telegram 用户 | 查看状态，接受或拒绝精确审批 challenge | 人类意图仍由 Harness policy 与 ledger CAS 重新校验 |

### 重构后的 Attempt 契约

本次重构没有增加第二套编排器：Controller、ledger、Git 验证与 Reviewer gate 仍是原来的工作流真值。变化是把每个 Worker/Reviewer Attempt 拆成三份显式、可校验的数据契约：

| 契约 | 固定的数据 | 获得的控制能力 |
| --- | --- | --- |
| `ExecutionSnapshot` | runtime adapter、Pi executable/精确已验收版本、完整 argv、resource/context digest、credential mode、Docker host 与 result channel | Controller 重启后仍消费同一份计划；配置、版本或资源漂移在新副作用前 fail closed |
| `AttemptContextEnvelope` | Attempt 身份、可信 policy digest、不可信 Issue/handoff/evidence、精确 Git 目标、runtime view 与 writeback contract | 每个角色只获得本轮必需上下文；全局或 candidate 指令不能通过 ambient discovery 升格为权威 |
| `TypedHandoff` | Reviewer findings、获批 recovery 或 CI rework 的来源 revision/digest 与下一 lane/base/HEAD | 不再用自由文本续跑；过期、错 lane 或错 HEAD 的 handoff 不能被消费 |

单个 Attempt 的数据流是：

```text
当前配置 + 真实 preflight
        -> ExecutionSnapshot
可信 baseSha 根 policy + 不可信 Issue / evidence / TypedHandoff
        -> 按角色裁剪的 AttemptContextEnvelope
Snapshot + Envelope + 渲染后 prompt
        -> planDigest
        -> AttemptRuntimePort
             |-> herdr-pi-cli -> interactive Pi
             `-> pi-rpc -> Herdr pane 前台 runner -> Pi SDK host
        -> 原子 durable result
        -> Harness result / Git / Reviewer gate
        -> ledger 状态迁移
```

RPC 路径中 Controller 不持有 Pi stdin/stdout；pane 内 runner 独占管道，Controller 只写入唯一 intent 并读取原子 receipt。因此 Controller 重启后只会继续观察同一 Attempt，不会重放 prompt。凭据内容不进入 Envelope、prompt 或 spool：Worker RPC 让 Pi 通过 canonical pathname 共用订阅 OAuth 的原生锁；Reviewer RPC 绑定 canonical `models.json` 的 digest，只在内存中解析当前支持的 custom provider。

| Lane | `herdr-pi-cli` | `pi-rpc` | 不变的完成 gate |
| --- | --- | --- | --- |
| Worker | Herdr interactive agent | durable runner + SDK host + canonical subscription OAuth | `worker_submit` durable result + Git provenance |
| 顶层 Reviewer | Herdr interactive agent | durable runner + SDK host + digest-bound custom model config | `review_submit` + exact HEAD + 隔离 validation |
| Reviewer 双轴 child | 由顶层 Reviewer 前台启动 | 仍使用不可变 child wrapper，不迁移到 RPC | Standards 与 Spec 两轴都必须有实质结果 |

Pi `agent_settled`、runner terminal、pane `done` 和 child completed 都只是运行时事实。它们不能跳过 durable result、Git fixed point、Reviewer 结论或 GitHub merge。详细信任边界见“Attempt 执行计划与上下文信任”。

### 通知与 Telegram 操作

推荐部署包含三个相互独立的常驻进程：Controller、Observer 和独立 Bridge。通知故障不会停止 Controller；Controller 故障则由 Observer 的 heartbeat 监测报告。

| 事件 | 主动通知策略 |
| --- | --- |
| Observer 上线、任务开始、任务进入终态 | 一条简洁的信息通知 |
| 新 Incident 或新 Analyst 结论 | 携带有界证据的 Incident/hold 卡片 |
| 策略允许的 fresh retry | 十分钟、单次使用，并绑定 job、revision、incident、analysis、lane 和动作的审批卡 |
| Ledger、Controller 日志、preflight 或 heartbeat 故障/恢复 | 健康告警或恢复通知 |
| 正常 Worker/Reviewer/publish/merge-wait 进展 | 不主动推送；通过 `/harness` 查询 |

单 lane 命令：

```text
/harness
/harness status
/harness incident
/harness approve
/harness approve CHALLENGE
```

多 lane 使用 `/harness <lane> [status|incident|approve [challenge]]`。审批按钮调用同一个精确绑定的 approval CLI；“保持阻塞”只消费本次 challenge，不会生成恢复批准。

传输方式：

| 模式 | Observer 配置 | Telegram update consumer | 用途 |
| --- | --- | --- | --- |
| 独立 Bridge（推荐） | 设置 `deliveryCommand` 指向 Bridge `send-card` | Bridge | 当前架构；不依赖 Hermes callback |
| Hermes 兼容模式 | 不设置 `deliveryCommand`；配置 `hermesBin`、`hermesProfile` 和 `target` | Harness 专用 Hermes Gateway | 仅用于既有安装 |
| 不启用通知面 | 不运行 Observer 和 Bridge | 无 | 核心交付仍可完整运行 |

一个 Bot Token 只能有一个 `getUpdates` consumer。只有先停止旧 consumer，才能复用现有专用 Bot；零中断迁移需要第二个 Bot。Token 必须放在 Git 之外、mode `0600` 的独立文件中，不能内联进 JSON、plist 或命令参数。Bridge 只接受一个 allowlist 用户的私聊。

## Agent 操作手册

这是操作契约。执行任何命令前先读完本节六步；README 不扩大用户授权，只要求查看时就在 `status` 后停止。先读状态，再采取动作。`run` 和 `tick` 会取得状态目录的排他 lease，并拒绝并发 Controller。把命令中的大写占位符替换为当前机器的真实值。

### 1. 预检

从 [`harness.config.example.json`](./harness.config.example.json) 复制配置。保留其中完整的角色参数，只替换仓库、路径、provider/model 和验证命令。

运行环境需要 Node.js `>=22.16.0`、Git、已登录目标仓库的 GitHub CLI、Herdr、Pi、`pi-subagents` 和 Codex CLI。首次安装或仓库更新后执行：

```bash
npm ci
npm run build
pi install npm:pi-subagents
pi install /ABSOLUTE/PATH/HerdrHarness-lite
gh auth status
gh repo view OWNER/REPOSITORY
herdr session list --json
pi --list-models WORKER_PROVIDER
pi --list-models REVIEWER_PROVIDER
/ABSOLUTE/PATH/codex --version
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
```

Telegram 是可选能力，应在核心预检通过后再安装。不要把 Bot Token 写入 `harness.config.json`；独立 Bridge 使用自己的受限 token 文件和配置。

如果配置中的命名 Herdr session 未运行，先启动或连接：

```bash
herdr session attach SESSION_NAME
```

逐项确认：

- `gh` 身份对目标仓库有 Issue、PR 和标签操作权限；
- `localPath` 指向目标仓库 clone，`baseRef` 存在；
- `stateDir` 和 `worktreeRoot` 位于产品仓库之外；
- 配置中的 Herdr session 为 `running: true`；
- Pi 当前目录能列出 Worker 与 Reviewer 所选 model；
- `analyst.argv` 用 `--codex-bin` 固定真实 Codex CLI 路径；
- `status` 可以读取账本；若已有 `activeJob`，继续它，不领取新任务。

预检完成条件：上述检查全部有真实输出，且不存在未解释的身份、路径、provider 或 active job 不确定性。

Controller 还会自动做真实预检。持久选择 ready Issue 前，它会轻量调用
Worker 与 Reviewer 的配置 Provider；当
`preflight.dockerRequired=true` 时，还会解析并验证当前本地 Docker Unix
socket 和 Compose V2。每个 attempt 创建 pane 前会重检当前角色 Provider
和 Docker。返回 `preflight_failed` 时不会 claim 或 dispatch agent；`run`
会保持运行并在下个轮询周期自动重试，单次 `tick` 则返回失败。

### 2. 先用手动 `tick`

首次真实任务使用手动模式：

```bash
node dist/src/cli.js tick --config /ABSOLUTE/PATH/harness.config.json
```

每次成功的 `tick` 至多写入一个持久迁移。根据返回结果继续：

| 返回状态 | 下一步 |
| --- | --- |
| `idle` | 当前没有可执行 Issue；停止或等待队列变化 |
| `preflight_failed` | 尚未 dispatch agent；`tick` 返回失败，常驻 `run` 保持安全门禁关闭并在下个轮询周期自动重试 |
| `selected`、`claimed`、`worktree_created` | 核对消息后再执行一次 `tick` |
| `attempt_prepared`、`attempt_pane_ready`、`attempt_agent_ready` | 再执行一次 `tick`；下一步可能进入长时间 dispatch |
| `attempt_reconciling` | 正在以同一 Attempt 身份再观察一次；再执行一次 `tick`，不要启动另一个 Controller |
| dispatch 阶段命令仍未返回 | 等待；只用 `status` 和 Herdr 只读查看，不并发启动第二个 `tick` |
| `attempt_dispatched`、`attempt_completed`、`ci_recovered`、`base_refreshed`、`published`、`merged` | 再执行一次 `tick` 消费下一阶段 |
| `publish_retry` | 修复消息指出的可重试发布条件，再执行 `tick` |
| `waiting_for_merge` | 等待 GitHub required checks/merge，再执行 `tick`；不得绕过 GitHub |
| `blocked`、`analysis_recorded`、`waiting_for_approval` | 进入“恢复 blocked job” |
| `archived` | 当前 slot 已释放；下一次 `tick` 可以选择下一个 Issue |

其他 `ok:false` 都先运行 `status` 并修复消息中的具体条件。重复同一命令不会自动授予恢复权限。

Interactive dispatch 会调用 Herdr `agent prompt --wait`；RPC Attempt 则先持久化唯一 `dispatch.json`，由 pane 内 runner 发送一次 prompt，并等待 terminal receipt。两者都可能长时间不返回；命令没有输出不等于 prompt 丢失，也不得并发重发。

单步完成条件：账本只推进了一次，或明确停在等待外部条件/agent 的状态；没有并行 Controller。

### 3. 查看当前进展

先读 Harness 账本：

```bash
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json --operator
```

当 `activeJob.activeAttempt.executionSnapshot.adapter=herdr-pi-cli` 时，从 handle 取出 agent 名称，再读 Herdr：

```bash
herdr --session SESSION_NAME agent get AGENT_NAME
herdr --session SESSION_NAME agent read AGENT_NAME \
  --source recent-unwrapped --lines 40
```

Pi 底部显示实际 `(provider) model • thinking`。配置文件只能表达意图；运行时 footer 和真实探测才证明实际选择。

RPC Worker/Reviewer 没有 Herdr interactive agent 记录；读取账本中的 ExecutionSnapshot，以及对应 attempt `runtime/ready.json`、`accepted.json`、`terminal.json`、`terminated.json`。通用 runner 故障只暴露固定的 `failureStage` 与 child `{code, signal}`；child stderr 和 Provider payload 仍不会写入。不要尝试连接或重建 runner 持有的 stdin/stdout。

普通 `status` 返回完整账本；`status --operator` 返回稳定的操作投影：当前 mode/phase，以及只对精确 revision、incident、analysis、Attempt 和 HEAD 绑定有效的操作。

查看完成条件：已确认 `activeJob.state`、`revision`、attempt ID/phase、实际 provider/model，以及当前是在工作、等待还是 blocked。

### 4. 切换到连续 `run`

手动完成一次端到端 canary 后，再启动：

```bash
node dist/src/cli.js run \
  --config /ABSOLUTE/PATH/harness.config.json \
  --poll-ms 15000
```

可用 `--max-cycles N` 做有界试跑。不设置时它是前台常驻进程；仓库不会自行安装 daemon。关闭承载该进程的终端会停止 Controller，无人值守部署必须由 launchd/systemd 等 service manager 管理；Herdr pane 持久化不会替代 Controller service。

`run` 与 `tick` 使用同一个状态机。PR merge 被 GitHub 确认并归档后，下一轮才会领取下一个符合条件的 Issue。Blocked job 会占住唯一 active slot，`run` 不能跳过 Analyst hold 或人工审批。

配置在 `run` 启动时只读取一次。修改 provider、model、thinking、路径或验证命令后，停止旧 `run` 并重新启动。

### 5. 恢复 blocked job

恢复从实时 operator projection 开始，不再让操作者记忆 incident class 到命令的映射：

```bash
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json --operator
node dist/src/cli.js decide --config /ABSOLUTE/PATH/harness.config.json \
  --option DECISION_ID --actor OPERATOR --reason "Evidence checked; execute this exact option"
```

如果 `state=blocked` 且尚无 Analyst 结论，只执行一次 `tick`，然后重新读取 `status --operator`。投影只会暴露当前 job、revision、incident、analysis、Attempt 与 Git fixed point 允许的动作。

| 投影动作 | 所需人工证据 | 效果 |
| --- | --- | --- |
| `approve_retry` | 明确接受当前 Analyst 的 fresh Worker/Reviewer 建议 | 记录一次有界批准；Controller 创建 fresh attempt 前重新校验全部绑定 |
| `reassess` | 受影响运行时、验证环境或缺失证据已经变化，并通过有界探测 | 创建 successor incident 并重新询问 Analyst；不授予 retry 权限 |
| `resolve_decision` | 对投影出的最终轮架构问题给出具体维护者决策 | 记录 `basis=human_decision`，把该决策和 Reviewer findings 交给 fresh Worker |
| `cancel` | 明确废止这个精确、尚未创建 PR 的 held job | 下一次 `tick` 将其归档为 cancelled，并把 Issue 退回 ready 队列 |

操作顺序：

1. 修改运行时或验证配置前，先停止连续 `run`。
2. 读取 `status --operator`；如果没有你获得授权执行的动作，停止。
3. 核对该动作要求的证据，并取得明确人工意图。
4. 用精确 option ID 和具体 reason 执行 `decide`。
5. 再读一次 `status --operator`，然后逐次 `tick` 或重新启动 `run`。
6. 若产生 fresh attempt，核对新 agent 身份和实际 provider/model/thinking。

Option ID 是 compare-and-swap 绑定；任一事实变化后都会失效。显式 `approve`、`reassess`、`resolve-decision` 和 `cancel` 只为兼容 integration 保留；交互式操作默认使用 `decide`。

同 Attempt reconciliation 由 Controller 自动完成，既不重放 prompt，也不授予 retry 权限。恢复绝不续用旧 agent；fresh Worker 只信任已提交改动和 durable result。完整性违规、身份过期、HEAD 漂移、禁止动作与未知证据会继续 blocked，除非实时投影明确提供动作。

只有 ledger 已记录所选 effect，且下一条允许状态清晰可见时，恢复才算完成；这不代表 GitHub Issue 已完成。

### 6. Agent 交付或交接

只有以下事实可以支撑“任务完成”：

- Worker durable result 已通过 Git provenance 验证；
- Reviewer 对精确 HEAD 返回 `pass`；
- PR 已发布；
- GitHub required checks 和 merge 已真实完成；
- Harness 已观察到 merge，并把 job `archived`。

如果只完成了恢复，报告 fresh attempt ID、lane、phase 和实际 provider/model；不要称 Issue 已完成。

交接至少报告：job ID、revision/state、Issue、attempt ID、HEAD、PR、已运行验证、失败/跳过项，以及下一条允许执行的命令。

## 系统如何运行

### 事实源

| 系统 | 负责的事实 |
| --- | --- |
| GitHub | Issue 状态、依赖、队列标签、PR、required checks 和 merge |
| Harness ledger | active job、revision、attempt、incident、Analyst 建议、人工审批和 effect receipt |
| Git | 固定 base、实现 HEAD、提交 provenance 和 clean-tree |
| Herdr / Pi | worktree、持久 pane、interactive agent 或 Worker/Reviewer RPC runner；只提供执行与可观察性 |
| Observer / Telegram Bridge | 不持有权威工作流事实；只保存通知 outbox 与 Telegram offset |

任何一层都不能替代另一层。尤其是 Herdr `idle/done`、Pi 最终回复或终端截图只能说明运行状态，不能替代 durable result、Git 验证、Reviewer 结论或 GitHub merge。

### 正常状态机

```text
GitHub ready issue
  -> live Worker/Reviewer Provider 与可选 Docker 预检
  -> durable selection and claim
  -> task-bound Codex Analyst session
  -> isolated Herdr worktree
  -> fresh Pi Worker（按 lane 配置选择 interactive 或 RPC）
  -> 针对当前任务 diff 的一次 focused self-check
  -> durable result + Git verification
  -> fresh independent Pi Reviewer（interactive 或顶层 RPC）
      -> pass: publish PR
      -> changes: fresh Worker -> fresh Reviewer
  -> optional GitHub native auto-merge
  -> observe merge
  -> archive and release the slot
```

无法安全继续时：

```text
blocked incident
  -> bounded untrusted evidence
  -> Analyst advice
      -> hold: stop
      -> fresh retry recommendation
  -> exact human approval
  -> close old pane
  -> fresh Worker or Reviewer attempt
```

操作展示只是投影，不是第二套状态机：`JobState + Incident + Analysis + live policy -> mode/phase + 精确 OperatorAction[]`。Adapter 只负责展示这些操作；所有写入仍经过 Core recovery gate 与 ledger CAS。

每次 `tick` 至多完成一次持久迁移，所以进程重启后从账本继续，不会重放整个编排脚本。

### 角色与信息边界

| 角色 | 什么时候运行 | 拥有什么信息 | 权限与完成条件 |
| --- | --- | --- | --- |
| Worker | 首次实现、Reviewer actionable findings 后的 rework、获批的 Worker 恢复 | 不可变 Issue snapshot、task digest、base/branch、可选的结构化 rework/recovery handoff | 可修改任务 worktree、测试、执行一次 focused self-check、提交并调用 `worker_submit`；不能提供结果身份、启动 review subagent、push 或建 PR。只有 Harness 绑定的 durable result 与 Git 验证同时通过才完成 |
| Reviewer | 每次 Worker HEAD 被接受后 | Issue 目标、固定 base、精确 HEAD、Harness 生成的 Git evidence、固定验证 argv | 顶层无通用 shell/edit/write；先预检实际验证环境，再独立检查 Standards 和 Spec，在验证副本运行命令，通过 `review_submit` 返回 `pass/changes/blocked` |
| Analyst | claim 后建立任务绑定 session；正常主链不介入，只有 blocked 时执行判断 turn | 任务 snapshot、incident、账本/Git/最近 review 等有界证据；最多请求 `maxAnalystTurns` 轮白名单只读证据 | 只能建议 `hold` 或 policy 允许的 fresh retry；不能写状态、改 Git、操作 Herdr 或批准自己 |
| 人类 | provider/运行时变更、风险接受和恢复授权时 | 精确 revision、incident、analysis 与证据 | 唯一可签发 retry approval；审批后 Controller 仍会重新检查 policy、身份和 Git |

Worker 与 Reviewer 是两个独立的顶层 Pi agent。Reviewer 不在旧 Worker 会话中继续运行。

### Attempt 执行计划与上下文信任

每个新 Attempt 在任何 agent 启动或 prompt 副作用前持久化 `ExecutionSnapshot + AttemptContextEnvelope + planDigest`。ExecutionSnapshot 绑定探测到的 Pi executable/精确版本、实际 argv、role resource 与 extension 本地模块闭包 digest、session/retry/compaction 模式、Docker host、result channel 和显式 context manifest；按角色裁剪的 Envelope 只把身份、可信 authority digest、不可信任务数据、精确 Git 目标、有界证据、runtime selector 与允许的 writeback contract 投影进最终 prompt。Controller 重启后只读这些绑定值；配置、版本、资源、环境、Envelope、prompt、bundle 或计划漂移都会 fail closed。旧 ledger 中已经 running 的无快照 Attempt 只能继续观察，不能重启或重发；旧的 pre-dispatch Attempt 不能产生新副作用。

Reviewer findings 与获批的 recovery/CI 决策通过带版本的 `TypedHandoff` 传递，不再拼接自由文本续跑 prompt。它绑定来源 revision/digest 和下一条 lane/base/HEAD，再从 `Job.pendingHandoff` 原子移动到下一 Attempt Envelope。Handoff、Issue 与 evidence 始终是不可信任务数据：可以增加 obligation、reference 和 unknown，不能扩大 tools、runtime 或 repository-policy authority。

Pi 的 context/session/prompt-template/theme 自动发现均被关闭。Harness 只从 `job.baseSha` 的 Git object 按 Pi 根目录优先级选择一份 `AGENTS.override.md / AGENTS.md / AGENTS.MD / CLAUDE.md / CLAUDE.MD`，记录路径、Git mode、source SHA 与 digest，并通过只读 bundle 显式注入。可信 policy 对其他仓库文件的引用不会自动授予指令权威，除非 Harness 另行从 trust anchor 导出并列入 manifest；bundled Worker TDD adapter 同样只把 candidate `CONTEXT.md`、ADR 与规则文件当数据，不赋予 ambient 指令权威。Reviewer candidate Head 中的规则文件对顶层 Reviewer 和两条 fresh review-axis child 都只是审查数据。由于 Pi CLI 没有单独禁用 `SYSTEM.md` 且保留默认 system prompt 的开关，绑定的用户 agent dir 或候选根目录出现 `SYSTEM.md` 时会在启动前阻断；该 agent dir 会显式注入每个 Herdr pane。

当 `workerRuntime=pi-rpc` 或 `reviewerRuntime=pi-rpc` 时，Controller 不持有 RPC pipes：Herdr pane 的前台 runner 独占 Pi stdin/stdout，Controller 只写 O_EXCL intent、读原子 receipt。精确版本绑定的 SDK host 将 settings/session 保持在内存，并把 resource/context 绑定到 Attempt。Worker 使用 canonical `auth.json` 的原始路径，使订阅 OAuth refresh 与普通 Pi 共享同一把 pathname lock；Reviewer 则捕获 canonical `models.json` 的严格 JSON 绑定字节并核对执行计划摘要，在内存将一个受支持的独立 custom provider 规范化为完整公开 `ProviderConfigInput`，补齐与 Pi 一致的模型默认值、折叠 modelOverrides，并只接受当前部署需要的 compat 子集（`supportsStore`、`supportsDeveloperRole`、`requiresReasoningContentOnAssistantMessages` 和 Pi 0.84 的 `thinkingFormat` 枚举），最后通过公开 `ModelRuntime.registerProvider` 与空的非持久 credential store 注册。built-in provider overlay、OAuth provider、注释和未知字段一律 fail closed。源文件必须是权限私有的普通单链接文件。两类凭据都不会形成第二份磁盘文件或链接、进入 receipt，或回传 Controller。选单前和启动前 Provider probe 使用相同凭据 seam；runner 在接受 prompt 前证明 fresh session、关闭 auto-retry/auto-compaction，并在 child 完整退出后再次拒绝凭据或资源漂移。Runner 接受的是一组已完整验收的精确 Pi 版本，而不是散落在各处的单个硬编码常量；当前已验收集合仍只有 `0.84.0`，每个 Attempt 继续钉住实际探测到的精确版本。新版本必须先完成协议与 SDK 行为测试并加入集合，否则 fail closed。`agent_settled` 仍只形成 runtime terminal，完成必须继续通过 durable result 与 Git provenance。Reviewer RPC 只迁移顶层 Reviewer；两条固定 review-axis child 继续使用现有不可变 wrapper 与 capability ceiling。

### Review、Rework 与 Reviewer 隔离

Worker 不再加载 `code-review`，也没有 `subagent` 工具；bundled
`focused-self-check` 只针对当前任务 diff 做一次有界检查。完整双轴审查仍
只由 fresh 独立 Reviewer 执行。

Reviewer 针对精确实现 HEAD 创建只读源码快照。它必须先调用 `review_preflight`，从真实 Reviewer 进程内证明源码/验证路径、固定 executable/version、固定命令和所需 Docker socket 可用；之后才能前台启动一次 `subagent`，且必须恰好包含一个 Standards 子代理和一个 Spec 子代理。两个子代理的工具上限都是 `read,grep,find,ls`。子代理定义与 subagent config 都是 Attempt 私有、只读且带摘要的快照，只从私有 project registry 解析，因此用户/candidate 同名覆盖、async 默认值和 intercom 注入都不能生效；只读 child-Pi wrapper 会在每个 child 前复核 Attempt 绑定版本，并显式注入空 append-system prompt，阻止子进程动态读取全局或 candidate `APPEND_SYSTEM.md`。预检失败，或任一轴失败、缺失、没有实质输出，都不能得到 `pass` 或 `changes`。

`review_validate` 在独立可写副本中执行 attempt 已绑定的固定 argv，使用最小环境和私有 cache/home/temp。源码、验证、状态与结果路径按 canonical path 双向检查不得重叠，包括符号链接别名。`review_submit` 在产品 worktree 外原子发布唯一结果，已有结果不可覆盖。

`worker_submit` 同样只接收结果字段；job、attempt、lane 和 result path 身份均来自 Harness 管理的 descriptor，原子结果通道也不能覆盖已有结果。

如果 `reviewerValidationArgv` 用 `/usr/bin/env
DOCKER_CONFIG=/absolute/path` 显式包装验证命令，预检只复用这个声明路径，
让隔离 HOME 能找到 Compose plugin。该目录必须无凭据；Harness 不会复制
用户的通用 Docker 配置。

这是 Pi 工具级写权限边界，不是恶意测试代码的 OS 沙箱。验证命令本身不可信时，应使用容器或独立 OS 账户。

Reviewer `changes` 必须包含可执行 findings。Harness 将 findings 绑定成结构化 handoff 交给 fresh Worker，再启动 fresh Reviewer。超过 `maxReviewRounds`、findings 缺失或证据不完整时 fail closed。

## 能力与边界

Harness 能够：

- 从一个 GitHub 仓库选择 `readyLabel` 队列中的严格前沿 Issue；
- 持久 claim，并维护单一 active job；
- 创建隔离 worktree 和 fresh Worker/Reviewer；
- 为 Attempt 固定执行快照和可信 context provenance；
- 让任一顶层 lane 可选共用 RPC adapter，并提供单 dispatch、结构化 terminal 与可确认终止；
- 验证 durable result、Git provenance、精确 review HEAD 和 Reviewer 隔离结果；
- 执行有界 rework 与经人工批准的 fresh recovery；
- 发布 PR、请求 GitHub 原生 auto-merge、观察 merge，并在归档后领取下一个 Issue；
- 让 Worker 与 Reviewer 独立选择 provider/model/thinking。

Harness 不会：

- 把 agent 回复、pane 状态或未提交改动当成完成；
- 恢复旧 agent 会话，或让 Analyst 自行批准重试；
- 绕过 GitHub branch protection、required checks 或最终 merge 决策；
- 跳过占用 active slot 的 blocked job；
- 并发调度多个 active job；
- 为恶意验证命令提供完整 OS 隔离。

## 配置参考

以 [`harness.config.example.json`](./harness.config.example.json) 为角色参数的单一事实源，不要从 README 手工重建完整 argv。

| 字段 | 含义 |
| --- | --- |
| `repo` | `owner/name` 格式的 GitHub 仓库 |
| `localPath` | 用于刷新 `baseRef` 的本地 clone |
| `baseRef` | 目标分支，通常为 `main` |
| `readyLabel` | GitHub 可执行任务标签，例如 `ready-for-agent` |
| `claimLabel` | 持久领取标记，例如 `agent:claimed` |
| `stateDir` | 私有账本、事件、Analyst receipts、attempt descriptors、Controller 心跳和排他 lease |
| `worktreeRoot` | Herdr 任务 worktree 根目录 |
| `maxReviewRounds` | Reviewer/rework 最大轮数 |
| `maxAnalystTurns` | Analyst 可请求的最大证据轮数 |
| `preflight.piBin` | 有界 Provider 真实探测所用 Pi 可执行文件；默认 `pi` |
| `preflight.dockerRequired` | 要求本地 Docker daemon 与 Compose V2，并只把解析出的本地 Unix socket 绑定给 Worker/Reviewer 验证环境 |
| `reviewerValidationArgv` | Harness 直接执行、不经过 shell 拼接的固定验证 argv |
| `autoMerge` | Reviewer pass 后是否请求 GitHub 原生 auto-merge |
| `workerRuntime` | `herdr-pi-cli`（默认）或 `pi-rpc`；RPC 要求显式内建 `--provider`、精确内建 `--model`，并使用 canonical 私有 `auth.json` 中的订阅 OAuth |
| `reviewerRuntime` | `herdr-pi-cli`（默认）或 `pi-rpc`；RPC 要求显式自定义 `--provider`/`--model`，并由 canonical 私有 `models.json` 提供配置 |
| `workerArgv` / `reviewerArgv` | 被 Controller 验证的 Pi 角色契约 |
| `herdr.session` | 必填的命名 Herdr session |
| `analyst` | task-bound Codex Analyst wrapper 命令与参数 |

角色契约：

| 角色 | 必需内容 | 工具 | Thinking |
| --- | --- | --- | --- |
| Worker | `implement`、bundled `tdd`、bundled `focused-self-check` 与 `worker-tools.js` | `read,bash,edit,write,grep,find,ls,worker_submit` | `high`、`xhigh` 或 `max` |
| Reviewer | bundled `code-review`、bundled config isolator、显式 `pi-subagents` 与 bundled `reviewer-tools.js` | `read,grep,find,ls,subagent,review_preflight,review_validate,review_submit` | `max` |
| Review-axis 子代理 | fresh context，不继承 project context、skills 或 extensions | `read,grep,find,ls` | `max` |

Worker 与 Reviewer 都必须包含 `--no-approve --no-skills --no-session --no-extensions --no-context-files --no-prompt-templates --no-themes`。Worker 只加载 bundled `worker-tools.js`；Reviewer 必须按顺序加载 config isolator、`pi-subagents`、`reviewer-tools.js` 三个 extension。Controller 会核对 skill/extension 身份、工具集合和 bundled 代码。用户可选运行时选择器仅限 `--provider`、`--model`；RPC 所需 `--mode rpc` 与显式 context bundle 由 Controller 注入，不能写进 role argv。

Reviewer adapter 只接受已验收的 `pi-subagents` `0.42.1`。双轴通过一次前台 `workflowScript` 启动；Harness 只接收固定的 `return await runs.all(<JSON>);` manifest，已删除的旧 `tasks` API 或任意脚本逻辑都会被拒绝。

### Provider/model 示例

在示例配置的完整 `workerArgv` 中加入或替换以下 selector，同时保留其余必需参数：

```text
"--provider", "openai-codex",
"--model", "gpt-5.6-luna",
"--thinking", "max"
```

在完整 `reviewerArgv` 中加入或替换：

```text
"--provider", "baizhi-chat",
"--model", "deepseek-v4-flash",
"--thinking", "max"
```

两者独立，不要求配对。自动预检会在选择任务前分别轻量调用两个
Provider，并在 attempt 前重检当前角色。手工排障时可先确认 catalog：

```bash
pi --list-models openai-codex
pi --list-models baizhi-chat
```

有界 Worker 探测示例：

```bash
pi --no-session --no-approve --no-skills \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max \
  --tools read \
  -p "Read package.json and print only its name."
```

Reviewer 探测同理，替换为其 provider/model。`-p` 和探测文本只用于命令行探测，不得写入角色 argv。

Analyst 应在 `analyst.argv` 中固定：

```json
"--codex-bin", "/absolute/path/to/codex"
```

service、SSH 和交互 shell 的 `PATH` 可能不同，因此二进制和 skill/extension 路径优先使用绝对路径。

## GitHub 队列与 Auto-merge

Harness 只选择同时满足以下条件的 Issue：

- `OPEN`；
- 带配置的 `readyLabel`；
- 没有 assignee；
- 没有 OPEN blocker；
- 不在持久 ledger 的已处理集合中。

带原生 sub-issues 的父 Issue 是 Map 容器，不会被领取；第一个 OPEN 且可执行的子任务是严格前沿。任务标签可以直接使用 `ready-for-agent`，不需要专用 `herdr-lite:ready`。`claimLabel` 只用于让人和自动化看到 Harness 已领取任务。

启用 `autoMerge` 时，Harness 为已审 HEAD 请求：

```text
gh pr merge --auto --match-head-commit <reviewed-sha> --merge
```

GitHub 必须允许 auto-merge，目标分支 ruleset 必须配置 required checks。PR HEAD 漂移或发布恢复时，Harness 会先取消 auto-merge 再 fail closed。只有 GitHub 报告 merged 后才归档。

若 `baseRef` 在发布前前移，或 OPEN PR 的 required checks 完成后前移，Controller 会先暂停 auto-merge，核对本地与远端 reviewed anchor，在干净任务 worktree 中合入新 base 但不 push，并要求 fresh Reviewer 审阅新的精确 HEAD。若发生 merge conflict，Controller 会 abort 并 fail closed，交由有界 Worker recovery 处理；Controller 自身不解冲突。

PR 仍为 OPEN 时，Controller 会读取精确 reviewed HEAD 上的 GitHub required checks。若 check 明确为失败或取消，它会：

1. 在修改 ledger 状态前先取消原生 auto-merge；
2. 记录 `ci_failure` incident，其中包含 check 身份、状态、链接，以及 `gh run view --log-failed` 的有界尾部，使最终错误不会被冗长启动日志截掉；
3. 保留 active slot，并让任务绑定的 Analyst 给出建议；
4. 每次都需精确人工批准，最多允许两个 fresh Worker 在同一分支回修；
5. 先验证远端分支仍指向此前已审的 PR HEAD，再要求 fresh Reviewer，通过后更新同一 PR。

Controller 不会自动 rerun CI，也不会自动 rebase。若操作者在 reviewed PR HEAD 未变化时 rerun CI，blocked job 只会在同一精确 HEAD 的全部 required checks 均为 pass/skipping 后恢复，且不会重置 CI rework 计数。无冲突的 base merge 只作为集成刷新，仍必须重新经过独立 Reviewer 与 GitHub CI。每轮 CI 回修都需要独立 Analyst 建议和精确人工批准。两轮获批回修后若 required check 第三次失败，会进入 `ci_rework_exhausted`，代码改动只允许 `hold`。

## 状态与审计数据

`stateDir` 保存：

- 单一 active job snapshot 与 terminal job 摘要；
- compare-and-swap revision 和 append-only 保存事件；
- Controller 排他 lease 与存活心跳；
- incident、Analyst effect receipts、session identity、approval 与 reassessment；
- required-check 失败证据与有界 CI 回修计数；
- 每次 Reviewer attempt 的只读源码快照、验证副本、fixed-point evidence、descriptor 和外部 result。

Reassessment 记录在 terminal archive 后仍保留。无法关闭精确绑定的 Analyst session 时，终态 job 不会静默归档。

绝不要手工编辑 `state.json` 或 result JSON。

## 开发与验证

```bash
npm run typecheck
npm test
npm run verify
```

默认测试使用 fake GitHub、Git、Herdr 和 Analyst ports。真实 canary 的历史成功不证明 provider、凭据或 GitHub ruleset 当前健康；运行和恢复都必须重新核对 live evidence。

实现入口：

```text
src/model.ts       领域记录与不变量
src/controller.ts  单写者状态机
src/policy.ts      incident policy、operator projection 与结果验证
src/recovery.ts    approval、reassessment 与 cancellation gates
src/prompts.ts     Worker/Reviewer 契约
src/ports.ts       外部边界
src/cli.ts         tick/run/status/恢复操作命令
src/hermes-observer.ts  ledger/log/heartbeat 观察与可重试 outbox
src/hermes-status.ts    有界只读 Telegram 视图
src/hermes-approval.ts  精确、限时的 Telegram 审批 challenge
src/adapters/      GitHub、Git、Herdr、Analyst、证据与状态
```

独立 Telegram 投递、安全 Bot 切换、Hermes 兼容模式和多仓库 lane 的配置见 [`integrations/hermes-telegram/README.md`](./integrations/hermes-telegram/README.md)。

完整状态机和设计分析见 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md)。
