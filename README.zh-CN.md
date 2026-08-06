# HerdrHarness Lite

[English](./README.md) | 简体中文

HerdrHarness Lite 是一个小型、失败关闭的 GitHub Issue 交付控制器。它在 Herdr worktree 中使用全新的 Pi Worker 和 Reviewer，把 workflow 权限放在持久状态机里，而不是把 agent 会话、终端状态或聊天回复当成交付事实。

```text
GitHub ready issue
  -> 持久 claim
  -> 与任务绑定的 Codex Analyst
  -> Herdr worktree
  -> fresh Pi Worker
  -> fresh 独立 Pi Reviewer
  -> Pull Request
  -> 可选 GitHub 原生 auto-merge
  -> 观察到 merge 后归档
```

无法安全继续时：

```text
blocked incident
  -> 有界、不可信证据
  -> Analyst 建议
  -> 允许重试时的精确人工审批
  -> 关闭旧 pane
  -> fresh Worker 或 Reviewer attempt
```

## Harness 保证什么

- 每次 `tick` 至多完成一次持久状态迁移。
- Worker 只有写出 durable result 且 Git provenance 验证通过才算完成。
- Reviewer 只有绑定精确实现 HEAD，并通过允许产物范围内的 clean-tree 检查才可 `pass`。
- Rework 总是启动 fresh Worker，再启动 fresh Reviewer，最多执行 `maxReviewRounds` 轮。
- Analyst 只能建议，不能授权。重试必须有绑定当前 revision、incident、analysis 的精确人工审批。
- 基础设施不确定、身份过期、证据缺失、HEAD 漂移和完整性违规全部 fail closed。
- Provider 修改只对未来 fresh attempt 生效；不会静默修改或复用正在运行的 agent。

## 环境要求

- Node.js `>=22.16.0`
- Git 和已对目标仓库授权的 GitHub CLI（`gh`）
- 一个正在运行的 Herdr 命名 session
- 已配置目标 provider/model 凭据的 Pi
- `pi-subagents`
- 用于受限持久 Analyst wrapper 的 Codex CLI

安装依赖并构建：

```bash
npm ci
npm run build
pi install npm:pi-subagents
pi install /absolute/path/to/HerdrHarness-lite
```

运行 Harness 前启动或连接命名 Herdr session：

```bash
herdr session attach herdr-harness
herdr session list --json
```

## 配置

复制 [`harness.config.example.json`](./harness.config.example.json)，并把所有路径改为绝对路径。

重要字段：

| 字段 | 含义 |
| --- | --- |
| `repo` | `owner/name` 格式的 GitHub 仓库 |
| `localPath` | 用于解析和刷新 `baseRef` 的本地 clone |
| `baseRef` | 目标分支，通常为 `main` |
| `readyLabel` | GitHub 任务队列标签，例如 `ready-for-agent` |
| `claimLabel` | 持久 GitHub 领取标记；可配置，不是硬编码 |
| `stateDir` | 私有 Harness 状态、事件日志和 Analyst receipts |
| `worktreeRoot` | 隔离的 Herdr 任务 worktree 根目录 |
| `maxReviewRounds` | Reviewer/rework 最大轮数 |
| `maxAnalystTurns` | Analyst 可请求的有界证据轮数 |
| `autoMerge` | 精确 Reviewer pass 后请求 GitHub 原生 auto-merge |
| `workerArgv` / `reviewerArgv` | 被验证为角色契约的 Pi 原生参数 |
| `herdr.session` | 必填的 Herdr 命名 session |
| `analyst` | Codex Analyst wrapper 的命令与参数 |

Controller 在领取任务前验证角色契约：

| 角色 | 必需 skills | 工具 | Thinking |
| --- | --- | --- | --- |
| Worker | `implement`、`tdd`、bundled `code-review` | 实现所需读写工具和 `subagent` | `high` 或 `max` |
| Reviewer | 仅 bundled `code-review` | 只读检查工具和 `subagent` | `max` |
| Review-axis 子代理 | 不继承 skills | `read,grep,find,ls,bash` | `max` |

两个角色都必须包含 `--no-approve --no-skills`。Harness 会核对 skill 真实身份、Matt Pocock installer provenance、精确工具集合和 bundled review skill。只有 `--provider`、`--model`、`--no-session` 可以作为可选运行时选择器；session 复用、extension、prompt 注入和扩大工具权限都会被拒绝。

### Provider 与 model 的显式选择

Provider/model 应写入对应角色的 Pi 原生 argv。下面只把未来 Reviewer attempt 固定到 Baizhi Chat 的 DeepSeek V4 Flash：

```json
{
  "reviewerArgv": [
    "--no-approve",
    "--no-skills",
    "--provider",
    "baizhi-chat",
    "--model",
    "deepseek-v4-flash",
    "--skill",
    "/absolute/path/to/HerdrHarness-lite/pi/skills/code-review",
    "--tools",
    "read,bash,grep,find,ls,subagent",
    "--thinking",
    "max"
  ]
}
```

先确认该 model 存在于 Pi 当前目录：

```bash
pi --list-models baizhi-chat
```

Provider 故障恢复前，执行一次有界、无 session 探测：

```bash
pi --no-session --no-approve --no-skills \
  --provider baizhi-chat \
  --model deepseek-v4-flash \
  --thinking max \
  --tools read \
  -p "Read package.json and print only its name."
```

不要把 `-p` 或探测文本写进 `reviewerArgv`，Harness 会拒绝。修改配置不会改变正在运行的 attempt。每次单独执行 `tick` 都会重新读取配置，但连续 `run` 进程只保留自身启动时加载的配置。修改 provider 后，必须先停止并重新启动 `run`，再让 Controller 创建 fresh Reviewer。

要核对运行中的 Pi 实际选择了什么，从 `status` 读取 `activeJob.activeAttempt.handle.agentName`，再查看 Herdr 最近输出：

```bash
node dist/src/cli.js status --config /absolute/harness.config.json
herdr --session herdr-harness agent get AGENT_NAME
herdr --session herdr-harness agent read AGENT_NAME \
  --source recent-unwrapped --lines 40
```

Pi 底部会显示实际 `(provider) model • thinking`。运行时显示和真实探测才是证据；配置文件本身不能证明 provider 当前健康。

## GitHub 准备

Harness 只选择同时满足以下条件的 Issue：

- 状态为 `OPEN`；
- 带有配置的 `readyLabel`；
- 没有 assignee；
- 不存在 OPEN blocker；
- 没有出现在 Harness 持久 ledger 中。

包含原生 sub-issues 的父 Issue 是 Map 容器，不会被领取；第一个 OPEN 且可执行的子任务是严格前沿。任务队列可以直接使用 `ready-for-agent`，不需要专门的 `herdr-lite:ready`。`claimLabel` 只是让人和自动化看到 Harness 已领取该任务。

首次运行前检查身份和仓库：

```bash
gh auth status
gh repo view owner/repository
```

如果启用 `autoMerge`，GitHub 必须允许 auto-merge，目标分支 ruleset 也必须配置预期 required checks。Harness 不会替代 branch protection。

## 命令

```bash
node dist/src/cli.js status --config /absolute/harness.config.json
node dist/src/cli.js tick --config /absolute/harness.config.json
node dist/src/cli.js run --config /absolute/harness.config.json \
  --poll-ms 15000
```

### 手动 `tick` 模式

重复执行同一个 `tick`。每次成功调用推进一个持久阶段，例如确认 claim、创建 worktree、准备 attempt、创建 pane、启动 agent、验收结果、发布 PR、观察 merge 或归档。

Dispatch 阶段的 `tick` 会故意调用 Herdr `agent prompt --wait`，因此可能在整个 Worker 或 Reviewer 运行期间一直不返回。这段时间没有输出不代表 prompt 丢失。需要时查看该 Harness 自有 agent；不要仅因为命令还在等待就再执行一个 `tick`。命令返回后，再用下一次 `tick` 消费和验证 durable result。

### 连续 `run` 模式

`run` 使用同一个 Controller 循环，并在每轮之间等待：

```bash
node dist/src/cli.js run \
  --config /absolute/harness.config.json \
  --poll-ms 15000
```

手动试跑可增加 `--max-cycles N`。不设置时，`run` 是前台常驻进程；用 `Ctrl-C` 或外部服务管理器停止。仓库本身不会安装 daemon。配置只在该进程启动时读取一次，所以修改角色的 provider、model 或 thinking 后必须重启 `run`。

经过审查的 PR merge 并归档后，下一轮可以领取下一个符合条件的 Issue。Blocked job 会占住唯一 active slot，不能被跳过。`run` 可以继续轮询，但不能绕过 Analyst hold 或人工审批门。

## 正常 Review 与 Rework

1. Fresh Worker 在固定 base 上实现并提交。
2. Fresh Reviewer 针对精确 HEAD 独立检查 Standards 和 Spec。
3. `pass` 进入发布。
4. `changes` 且包含可执行 findings 时，启动 fresh Worker 接收有界 findings brief，随后再启动 fresh Reviewer。
5. 用完 `maxReviewRounds`、缺少 findings、证据不完整或 review 不确定时，生成 blocked incident。

Worker 与 Reviewer 是两个独立的顶层 Pi agent。Review 不会在旧 Worker 会话里继续运行。

## 故障恢复

所有恢复都先读取持久状态：

```bash
node dist/src/cli.js status --config /absolute/harness.config.json
```

记录以下精确字段：

- `activeJob.revision`
- `activeJob.state`
- `activeJob.incident.id` 及 class/lane
- `activeJob.analysis.id` 及 action
- `activeJob.activeAttempt`
- `activeJob.headSha`

### 1. 让 Analyst 诊断新 block

当 job 为 `blocked` 且 `analysis` 为 `null`，执行一次 `tick`，Harness 会构造有界证据包并记录 Analyst 建议：

```bash
node dist/src/cli.js tick --config /absolute/harness.config.json
```

Analyst 可以请求白名单只读证据、建议一个 policy 允许的 retry，或返回 `hold`。它不能写 Controller 状态、改 Git、操作 Herdr，也不能批准自己的建议。

### 2. 批准允许的重试

只有当前 analysis action 是 `retry_fresh_worker` 或 `retry_fresh_reviewer`，并且人接受证据时才能批准：

```bash
node dist/src/cli.js approve \
  --config /absolute/harness.config.json \
  --revision 23 \
  --incident incident-id \
  --analysis analysis-id \
  --actor operator-name \
  --reason "已核对证据，批准一次有界 fresh retry"
```

该命令受 compare-and-swap 保护。revision、incident、analysis 任一变化都会拒绝。Approval 只记录权限；后续 Controller tick 会重新检查 policy 与 Git，关闭旧 pane，再创建 fresh attempt，绝不恢复旧 agent。

### 3. 重新评估处于 hold 的 Reviewer provider 故障

`hold` 不能直接批准。仅当该 hold 精确对应 Reviewer `infrastructure_exhausted`、且没有 durable result，并且运行环境确实发生变化时：

1. 如果存在连续 `run` 进程，先停止它；
2. 修复或切换 Reviewer provider/model；
3. 执行有界、无 session provider 探测；
4. 用 `reassess` 请求新的 Analyst 判断。

```bash
node dist/src/cli.js reassess \
  --config /absolute/harness.config.json \
  --revision 21 \
  --incident held-incident-id \
  --analysis held-analysis-id \
  --actor operator-name \
  --reason "Reviewer provider 已切换，且无 session 只读探测通过"
```

`reassess` 会把旧 revision/incident/analysis、actor 和有界 reason 保留在审计记录中，把 operator statement 标为不可信证据，创建拥有全新 receipt key 的 successor incident，并清空旧 analysis。它本身不授予 retry 权限、不关闭或启动 agent，也不接触 Git。

接着单独执行一次 `tick` 获取新的 Analyst 判断。如果仍为 `hold`，就停止；如果建议 `retry_fresh_reviewer`，必须对新的 revision/incident/analysis 再执行一次精确 `approve`。之后继续手动 tick，或者启动一个新的 `run` 进程；两种方式都会加载修改后的 provider 配置。

### 4. 必须保持停止的故障

完整性违规、任务身份过期、Analyst 不可用、禁止动作、HEAD 漂移和未知证据，不能通过修改 JSON 或重复命令变成重试权限。必须保持 hold，直到通过明确受支持的路径修正底层事实。

绝不要手工编辑 `state.json` 或 result JSON。Snapshot、CAS revision、effect receipts、result identity 与 Git 检查共同构成一条信任边界。

## Auto-merge 与下一个 Issue

设置 `autoMerge: true` 后，发布阶段请求：

```text
gh pr merge --auto --match-head-commit <reviewed-sha> --merge
```

Required checks 和最终 merge 仍由 GitHub 决定。Harness 持续观察 PR；一旦 HEAD 漂移，会先禁用 auto-merge，再 fail closed。只有 GitHub 报告已 merge 才归档。连续 `run` 随后可以选择下一个符合条件的 Issue。

## 状态与审计数据

`stateDir` 保存：

- 单一 active job snapshot 与 terminal job 摘要；
- compare-and-swap revision 状态；
- append-only 保存事件；
- Codex Analyst effect receipts 与 session 身份。

Reassessment 审计记录在 terminal archive 后仍然保留。Analyst 从自己的私有 state 目录运行，只接收有界、不可信的 task/evidence 数据包。无法关闭精确记录的 Analyst session 时，终态 job 会保留而不会静默归档。

## 开发与验证

```bash
npm run typecheck
npm test
npm run verify
```

默认测试使用 fake GitHub、Git、Herdr 和 Analyst 端口。真实 canary 还验证过命名 Herdr session、fresh Pi Worker/Reviewer、持久 Codex Analyst receipts、精确 SHA review、PR 发布、原生 auto-merge 观察和 terminal archive。这些是历史证据，不代表 provider 或 GitHub 设置当前仍然健康；恢复前必须重新核对 live runtime。

实现有意保持精简：

```text
src/model.ts       领域记录与不变量
src/controller.ts  单写者状态机
src/policy.ts      incident policy 与结果验证
src/recovery.ts    精确 approval/reassessment gates
src/prompts.ts     Worker/Reviewer 契约
src/ports.ts       外部边界
src/cli.ts         tick/run/status/approve/reassess
src/adapters/      GitHub、Git、Herdr、Analyst、证据与状态
```

完整状态机和设计分析见 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md)。
