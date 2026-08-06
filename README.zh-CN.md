# HerdrHarness Lite

[English](./README.md) | 简体中文

HerdrHarness Lite 是一个小型、失败关闭的 GitHub Issue 交付控制器。它用持久状态机协调 GitHub、Git、Herdr、Pi Worker、独立 Reviewer 和 Codex Analyst；agent 会话、终端输出和聊天回复都不是交付事实。

这份 README 有两条阅读路径：

- Agent 要安装、运行、查看或恢复 Harness：从“Agent 操作手册”开始，并按步骤与停止条件执行。
- 人类要理解系统：从“系统如何运行”开始，再看“能力与边界”。

## Agent 操作手册

这是操作契约。执行任何命令前先读完本节六步；README 不扩大用户授权，只要求查看时就在 `status` 后停止。先读状态，再采取动作；每次只允许一个 Controller 写账本。把命令中的大写占位符替换为当前机器的真实值。

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

### 2. 先用手动 `tick`

首次真实任务使用手动模式：

```bash
node dist/src/cli.js tick --config /ABSOLUTE/PATH/harness.config.json
```

每次成功的 `tick` 至多写入一个持久迁移。根据返回结果继续：

| 返回状态 | 下一步 |
| --- | --- |
| `idle` | 当前没有可执行 Issue；停止或等待队列变化 |
| `selected`、`claimed`、`worktree_created` | 核对消息后再执行一次 `tick` |
| `attempt_prepared`、`attempt_pane_ready`、`attempt_agent_ready` | 再执行一次 `tick`；下一步可能进入长时间 dispatch |
| dispatch 阶段命令仍未返回 | 等待；只用 `status` 和 Herdr 只读查看，不并发启动第二个 `tick` |
| `attempt_dispatched`、`attempt_completed`、`published`、`merged` | 再执行一次 `tick` 消费下一阶段 |
| `publish_retry` | 修复消息指出的可重试发布条件，再执行 `tick` |
| `waiting_for_merge` | 等待 GitHub required checks/merge，再执行 `tick`；不得绕过 GitHub |
| `blocked`、`analysis_recorded`、`waiting_for_approval` | 进入“恢复 blocked job” |
| `archived` | 当前 slot 已释放；下一次 `tick` 可以选择下一个 Issue |

任意 `ok:false` 都先运行 `status` 并修复消息中的具体条件。重复同一命令不会自动授予恢复权限。

Dispatch 阶段会调用 Herdr `agent prompt --wait`，因此可能在整个 Worker 或 Reviewer 运行期间不返回。命令没有输出不等于 prompt 丢失。

单步完成条件：账本只推进了一次，或明确停在等待外部条件/agent 的状态；没有并行 Controller。

### 3. 查看当前进展

先读 Harness 账本：

```bash
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
```

从 `activeJob.activeAttempt.handle.agentName` 取出 agent 名称，再读 Herdr：

```bash
herdr --session SESSION_NAME agent get AGENT_NAME
herdr --session SESSION_NAME agent read AGENT_NAME \
  --source recent-unwrapped --lines 40
```

Pi 底部显示实际 `(provider) model • thinking`。配置文件只能表达意图；运行时 footer 和真实探测才证明实际选择。

查看完成条件：已确认 `activeJob.state`、`revision`、attempt ID/phase、实际 provider/model，以及当前是在工作、等待还是 blocked。

### 4. 切换到连续 `run`

手动完成一次端到端 canary 后，再启动：

```bash
node dist/src/cli.js run \
  --config /ABSOLUTE/PATH/harness.config.json \
  --poll-ms 15000
```

可用 `--max-cycles N` 做有界试跑。不设置时它是前台常驻进程；仓库不会自行安装 daemon。

`run` 与 `tick` 使用同一个状态机。PR merge 被 GitHub 确认并归档后，下一轮才会领取下一个符合条件的 Issue。Blocked job 会占住唯一 active slot，`run` 不能跳过 Analyst hold 或人工审批。

配置在 `run` 启动时只读取一次。修改 provider、model、thinking、路径或验证命令后，停止旧 `run` 并重新启动。

### 5. 恢复 blocked job

所有恢复都从精确状态开始：

```bash
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
```

记录：

- `activeJob.revision`
- `activeJob.state`
- `activeJob.incident.id`、class 和 lane
- `activeJob.analysis.id`、action、summary
- `activeJob.activeAttempt.id`、lane、phase
- `activeJob.headSha`
- `activeJob.ciFailure` 与 `activeJob.ciReworkCount`（存在时）

#### 新 block

当 `state=blocked` 且 `analysis=null` 时，只执行一次 `tick`。Analyst 会收到有界证据包并记录建议。

- `action=hold`：停止。不能批准 `hold`。
- `action=retry_fresh_worker` 或 `retry_fresh_reviewer`：把证据和建议交给人类；只有人类明确同意后才能执行 `approve`。

```bash
node dist/src/cli.js approve \
  --config /ABSOLUTE/PATH/harness.config.json \
  --revision REVISION \
  --incident INCIDENT_ID \
  --analysis ANALYSIS_ID \
  --actor OPERATOR \
  --reason "Evidence checked; approve one bounded fresh retry"
```

Approval 受 compare-and-swap 保护。随后继续单独 `tick`，直到 `recovery_applied`，再依次创建并派发 fresh attempt。Harness 会关闭旧 pane，绝不恢复旧 agent。

#### Provider、Reviewer 验证环境或 Analyst 运行时已修复

仅当 incident 精确对应以下可重评情况时使用 `reassess`：

- Worker/Reviewer `infrastructure_exhausted` 且没有 durable result；或
- Reviewer `review_uncertain` 已产生与当前 HEAD 绑定的 durable `blocked` 结果，且其外部验证环境已经修复并通过有界探测；或
- Reviewer 尚未获得 pane/agent 时，启动前检查发现并已人工保全或清理的 `reviewer_preflight_dirty`；或
- Controller 自己记录的 Analyst 执行失败。

顺序：

1. 停止连续 `run`；
2. 修改故障角色的 provider/model、修复 Reviewer 验证环境，或修复 Analyst 可执行文件；
3. 在受影响的隔离边界内完成一次有界探测；
4. 如果旧故障尚未入账，执行 `tick` 使其成为 blocked incident；
5. 如果 Analyst 已基于旧运行时返回 `hold`，执行精确 `reassess`；
6. 再执行一次 `tick` 获取新 Analyst 判断；
7. 若新建议是 lane 匹配的 fresh retry，获得人类明确批准后执行 `approve`；
8. 继续 `tick` 到 fresh attempt 已派发，或重新启动 `run`；
9. 用 Herdr footer 核对新 agent 的实际 provider/model/thinking。

```bash
node dist/src/cli.js reassess \
  --config /ABSOLUTE/PATH/harness.config.json \
  --revision REVISION \
  --incident HELD_INCIDENT_ID \
  --analysis HELD_ANALYSIS_ID \
  --actor OPERATOR \
  --reason "Affected runtime changed and a bounded probe passed"
```

`reassess` 只请求新判断，不授予 retry 权限。如果新 Analyst 仍返回 `hold`，停止。

Fresh Worker 不会丢掉已提交改动：它继续使用同一任务 worktree，并从账本记录的 base/reviewed HEAD 接收有界恢复或 rework brief。未提交、未形成 durable result 的 agent 内部状态不被信任。

完整性违规、任务身份过期、HEAD 漂移、禁止动作和未知证据不能靠改配置或重复命令转成 retry。唯一兼容迁移是旧版把“Reviewer 启动前残留”误记成完整性违规，且账本能证明 Reviewer 从未获得 handle；它会被精确 `reassess` 为 `reviewer_preflight_dirty`，仍需新 Analyst 判断、人类批准和恢复前 clean-tree 校验。

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
| Herdr / Pi | worktree、pane 和 agent 运行时；只提供执行与可观察性 |

任何一层都不能替代另一层。尤其是 Herdr `idle/done`、Pi 最终回复或终端截图只能说明运行状态，不能替代 durable result、Git 验证、Reviewer 结论或 GitHub merge。

### 正常状态机

```text
GitHub ready issue
  -> durable selection and claim
  -> task-bound Codex Analyst session
  -> isolated Herdr worktree
  -> fresh Pi Worker
  -> durable result + Git verification
  -> fresh independent Pi Reviewer
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

每次 `tick` 至多完成一次持久迁移，所以进程重启后从账本继续，不会重放整个编排脚本。

### 角色与信息边界

| 角色 | 什么时候运行 | 拥有什么信息 | 权限与完成条件 |
| --- | --- | --- | --- |
| Worker | 首次实现、Reviewer actionable findings 后的 rework、获批的 Worker 恢复 | 不可变 Issue snapshot、task digest、base/branch、可选的有界 rework/recovery brief、result path | 可修改任务 worktree、测试和提交；不能 push/建 PR。只有身份绑定 durable result 与 Git 验证同时通过才完成 |
| Reviewer | 每次 Worker HEAD 被接受后 | Issue 目标、固定 base、精确 HEAD、Harness 生成的 Git evidence、固定验证 argv | 顶层无通用 shell/edit/write；独立检查 Standards 和 Spec，在验证副本运行命令，通过 `review_submit` 返回 `pass/changes/blocked` |
| Analyst | claim 后建立任务绑定 session；正常主链不介入，只有 blocked 时执行判断 turn | 任务 snapshot、incident、账本/Git/最近 review 等有界证据；最多请求 `maxAnalystTurns` 轮白名单只读证据 | 只能建议 `hold` 或 policy 允许的 fresh retry；不能写状态、改 Git、操作 Herdr 或批准自己 |
| 人类 | provider/运行时变更、风险接受和恢复授权时 | 精确 revision、incident、analysis 与证据 | 唯一可签发 retry approval；审批后 Controller 仍会重新检查 policy、身份和 Git |

Worker 与 Reviewer 是两个独立的顶层 Pi agent。Reviewer 不在旧 Worker 会话中继续运行。

### Review、Rework 与 Reviewer 隔离

Reviewer 针对精确实现 HEAD 创建只读源码快照。它只能前台启动一次 `subagent`，且必须恰好包含一个 Standards 子代理和一个 Spec 子代理；两个子代理的工具上限都是 `read,grep,find,ls`。失败、缺失或没有实质输出的任一轴都不能得到 `pass` 或 `changes`。

`review_validate` 在独立可写副本中执行 attempt 已绑定的固定 argv，使用最小环境和私有 cache/home/temp。源码、验证、状态与结果路径按 canonical path 双向检查不得重叠，包括符号链接别名。`review_submit` 在产品 worktree 外原子发布唯一结果，已有结果不可覆盖。

这是 Pi 工具级写权限边界，不是恶意测试代码的 OS 沙箱。验证命令本身不可信时，应使用容器或独立 OS 账户。

Reviewer `changes` 必须包含可执行 findings。Harness 将 findings 作为有界 brief 交给 fresh Worker，再启动 fresh Reviewer。超过 `maxReviewRounds`、findings 缺失或证据不完整时 fail closed。

## 能力与边界

Harness 能够：

- 从一个 GitHub 仓库选择 `readyLabel` 队列中的严格前沿 Issue；
- 持久 claim，并维护单一 active job；
- 创建隔离 worktree 和 fresh Worker/Reviewer；
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
| `stateDir` | 私有账本、事件、Analyst receipts 和 Reviewer attempt 数据 |
| `worktreeRoot` | Herdr 任务 worktree 根目录 |
| `maxReviewRounds` | Reviewer/rework 最大轮数 |
| `maxAnalystTurns` | Analyst 可请求的最大证据轮数 |
| `reviewerValidationArgv` | Harness 直接执行、不经过 shell 拼接的固定验证 argv |
| `autoMerge` | Reviewer pass 后是否请求 GitHub 原生 auto-merge |
| `workerArgv` / `reviewerArgv` | 被 Controller 验证的 Pi 角色契约 |
| `herdr.session` | 必填的命名 Herdr session |
| `analyst` | task-bound Codex Analyst wrapper 命令与参数 |

角色契约：

| 角色 | 必需内容 | 工具 | Thinking |
| --- | --- | --- | --- |
| Worker | `implement`、`tdd`、bundled `code-review` | `read,bash,edit,write,grep,find,ls,subagent` | `high`、`xhigh` 或 `max` |
| Reviewer | bundled `code-review`、显式 `pi-subagents` 与 `reviewer-tools.js` extensions | `read,grep,find,ls,subagent,review_validate,review_submit` | `max` |
| Review-axis 子代理 | fresh context，不继承 skills/extensions | `read,grep,find,ls` | `max` |

Worker 与 Reviewer 都必须包含 `--no-approve --no-skills`；Reviewer 还必须包含 `--no-extensions` 和示例配置声明的两个 extension。Controller 会核对 skill/extension 身份、工具集合和 bundled review 代码。可选运行时选择器仅限 `--provider`、`--model`、`--no-session`。

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

两者独立，不要求配对。先确认 model，再进行故障恢复：

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

PR 仍为 OPEN 时，Controller 会读取精确 reviewed HEAD 上的 GitHub required checks。若 check 明确为失败或取消，它会：

1. 在修改 ledger 状态前先取消原生 auto-merge；
2. 记录 `ci_failure` incident，其中包含 check 身份、状态、链接，以及有界的 `gh run view --log-failed` 输出；
3. 保留 active slot，并让任务绑定的 Analyst 给出建议；
4. 只有精确人工批准后，才允许一个 fresh Worker 在同一分支回修；
5. 先验证远端分支仍指向此前已审的 PR HEAD，再要求 fresh Reviewer，通过后更新同一 PR。

Controller 不会自动 rerun CI，也不会自动 rebase。获批的 CI 回修完成后若 required check 再次失败，会进入 `ci_rework_exhausted`，只允许 `hold`。

## 状态与审计数据

`stateDir` 保存：

- 单一 active job snapshot 与 terminal job 摘要；
- compare-and-swap revision 和 append-only 保存事件；
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
src/policy.ts      incident policy 与结果验证
src/recovery.ts    approval 与 reassessment gates
src/prompts.ts     Worker/Reviewer 契约
src/ports.ts       外部边界
src/cli.ts         tick/run/status/approve/reassess
src/adapters/      GitHub、Git、Herdr、Analyst、证据与状态
```

完整状态机和设计分析见 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md)。
