# HerdrHarness Lite 当前架构

本文只描述当前 `src/`、`test/`、配置解析和集成代码已经实现的系统。运行时事实以代码、测试、配置验证和外部系统的实时读数为准。

## 1. 范围与非目标

HerdrHarness Lite 是一个单槽、持久化、fail-closed 的 GitHub Issue 交付控制器。它从符合准入条件的 Issue 中选择一个任务，绑定事实与执行计划，驱动 fresh Worker 和 fresh Reviewer，验证 Git fixed point，发布 PR，等待 required checks 与 merge，最后归档。

当前范围：

- 一个 Controller 实例管理一个配置 lane；
- 一个 lane 同时最多有一个 active Job；
- GitHub Issue 与 strict Map frontier 负责待办选择；
- Herdr 承载 worktree、pane 和 agent 生命周期；
- Worker 与 Reviewer 可分别使用 `herdr-pi-cli` 或 `pi-rpc` Attempt adapter；
- JSON ledger 保存 workflow truth；
- Analyst、Observer 和 Telegram 只提供诊断、观察或受控操作入口。

非目标：

- 通用多代理平台或任意深度 agent tree；
- 多任务并行调度器；
- 用 Pi session、Herdr 状态或通知状态替代交付 ledger；
- 让 Analyst、Observer、Telegram 或候选仓库指令获得 workflow authority；
- 通过恢复旧的 blocked Agent 上下文继续执行；
- 依靠工具 allowlist 充当操作系统 sandbox。

## 2. 权威事实源

解释冲突时按以下顺序取事实：

1. `src/` 的 TypeScript 实现；
2. `test/` 的行为测试；
3. 配置解析与运行时 preflight；
4. 当前集成实现；
5. 本文；
6. README。

不同系统各自拥有不同事实，不能互相替代：

| 事实 | 权威来源 |
| --- | --- |
| Job revision、Attempt、Incident、Analysis、Approval | Harness ledger |
| Issue 状态、claim label、PR、required checks、merge | GitHub |
| base/head、祖先关系、clean tree、提交 fixed point | Git |
| Worker/Reviewer 结果 | Harness-owned durable result channel |
| pane、agent、进程存活 | Herdr / Pi runtime |
| 通知 offset、消息、callback | Observer / Bridge / Telegram |

Herdr `idle/done`、Pi runtime event、Reviewer child 完成或验证命令结束都不是交付完成。完成至少需要身份绑定的 durable result 与对应 Git/GitHub 验证。

## 3. 核心记录

```text
IssueSnapshot -> TaskSnapshot -> Job -> Attempt
                                  |      |-- ExecutionSnapshot
                                  |      |-- AttemptContextEnvelope
                                  |      `-- TypedHandoff (可选输入)
                                  |-- Incident -> EvidencePack -> Analysis
                                  |                         `-> Approval
                                  `-- OperatorAction（实时投影，不持久化）
```

### IssueSnapshot 与 TaskSnapshot

`IssueSnapshot` 是 GitHub 当前返回的 Issue 图快照，包含状态、labels、assignees、blockers、父子关系和更新时间。

任务被选择时，Controller 生成 `TaskSnapshot`，绑定仓库、Issue、Map、标题、Objective、labels、排序后的 blocker closure、Issue 更新时间和 digest。它是该 Job 的 claim-time 任务事实，不会在每个 Attempt 中重新抓取另一份 Issue。

### Job

`Job` 是一个 Issue 的持久工作流记录，包含 revision、任务、base、branch、worktree、Analyst session、Attempts、review round、Incident、Analysis、Approval、PR、CI failure、rework 次数和终态信息。每次演进都通过 `evolveJob` 增加 revision。

### Attempt

`Attempt` 是一次 fresh Worker 或 Reviewer 执行。它绑定 lane、round、base、预期 HEAD、result path、phase、prompt digest、执行快照、上下文 envelope、Herdr handle 和 durable result。blocked 或已完成 Attempt 不会被恢复为新的写入执行；重试创建 fresh Attempt。

### Incident、EvidencePack、Analysis、Approval 与 OperatorAction

- `Incident` 记录阻塞类别、lane、Attempt、摘要、可允许动作以及可选的自动恢复候选。
- `EvidencePack` 是 digest 绑定、大小受限、标为 untrusted 的 Issue、Git、测试、result、runtime 和文件摘录证据。
- `Analysis` 在代码中保存为 `AnalystAdvice`；它只能建议 `hold`、`retry_fresh_worker` 或 `retry_fresh_reviewer`，不能授权执行。
- `Approval` 绑定精确 job revision、Incident、Analysis、actor、reason 与 action；policy 自动授权也形成可审计 Approval。
- `OperatorAction` 由当前 Job 实时投影，带精确 binding 与 effect，不作为另一份状态持久化。CLI `decide` 消费当前仍有效的 action。

### ExecutionSnapshot

`ExecutionSnapshot` 在 runtime side effect 前绑定：

- adapter、Pi executable 与 exact inspected version；
- 完整 argv、provider、model、thinking、tools；
- session、retry、compaction、credential 模式，以及可选的受控压缩策略；
- Docker host；
- skill、extension、agent、runtime、model config 等资源及 digest；
- trusted context manifest/bundle 与 Attempt-private agent directory。

这些字段进入 `planDigest`。启动前发现 runtime、资源、环境、context、prompt 或 plan 漂移时，Controller fail closed。

### AttemptContextEnvelope

`AttemptContextEnvelope` 是按角色裁剪的唯一 prompt 输入投影，显式区分：

- identity；
- provenance-bound trusted authority；
- untrusted TaskSnapshot / Objective；
- exact Git target；
- untrusted TypedHandoff 与 evidence refs；
- runtime view；
- Harness-owned writeback contract。

凭据内容不进入 envelope、result 或 receipt。

Worker RPC 的请求上下文分四层：Harness/仓库角色约束留在 trusted system prompt；Objective、AC、TypedHandoff 与精确 Git target 进入 digest 绑定的 untrusted pinned task-data；探索过程进入可压缩 history；工具白名单、Git fixed point、ledger、policy 与 human gate 继续由模型外强制。Pinned block 通过 Pi request-local context transform 在每次模型请求前原样注入，不写入 session history，也不进入 compaction summary。

### TypedHandoff

`TypedHandoff` 用于 review changes、approved recovery 和 CI rework。它绑定来源 revision、task/result/evidence/Incident/Analysis/Approval 以及目标 lane、base、expected HEAD、expected remote HEAD。它是有界的 untrusted task data，不能扩大工具、runtime 或 repository policy 权威。

## 4. 当前状态集合

### JobState

```text
claimed
worker_ready
worker_running
reviewer_ready
reviewer_running
publish_ready
awaiting_merge
blocked
recovery_approved
done
cancelled
```

### AttemptPhase

```text
prepared
pane_ready
agent_ready
running
settled
```

### BlockClass

```text
agent_decision
agent_blocked
review_uncertain
reviewer_preflight_dirty
infrastructure_exhausted
integrity_violation
stale_task
ci_failure
ci_rework_exhausted
analyst_unavailable
```

这些字符串由 `src/model.ts` 定义。新增、删除或重解释任何值都属于 ledger 与恢复语义变更，不能只改文档。

## 5. 单写 Controller 与持久化

`HarnessController.tick()` 是自动状态迁移入口。它读取当前 state，按 `JobState` 执行一个分支，并在一次 tick 中最多持久化一次状态迁移后返回。`run` 只是持有 lease 并循环调用 `tick()`。

`JsonStateStore` 使用：

- `state.json` 保存当前 ledger；
- `events.jsonl` 记录状态事件；
- state-directory 文件锁与 Controller lease 防止同一目录并发写；
- expected revision 做 CAS；
- 临时文件与 atomic rename 提交 state，append-only 写入 event；
- 保存前后的 invariant validation 拒绝非法 ledger。

生产 `state.json` 只能通过 Controller、policy 与 recovery API 演进，不能人工编辑。不同机器或 lane 不得同时写同一 state directory 或 worktree。

## 6. 任务准入与 strict Map frontier

普通 Issue 只有同时满足以下条件才可领取：

- state 为 `OPEN`；
- 包含 configured ready label；
- 无 assignee；
- 无 OPEN blocker；
- 当前没有 active Job，且 Issue 不在 `done` terminal ledger 中；已取消任务允许重新入队。

Map 是带 sub-issues 的排序容器，本身永不 claim。唯一 frontier 是第一个 OPEN child；该 child 不可执行、缺失、父关系不一致或仍被阻塞时，整个 Map 等待，Controller 不越过它选择后续 child。选择完成后还会在 claim 前重读 GitHub 事实并做 runtime preflight。

Claim 通过 GitHub Issue label 形成外部事实，并以 claim intent / confirmation 在 ledger 中收敛崩溃窗口。claim label 不能替代 ledger，ledger 也不能假设 label mutation 已成功。

## 7. 角色权限

### Worker

Worker 接收 TaskSnapshot Objective、base/branch、trusted repository context、可选 TypedHandoff 和 `worker_submit` contract。RPC Worker 的稳定角色约束保留在 system prompt，精确任务事实由 request-local pinned block 提供；两者都不依赖 compaction summary。Worker 可以在独立 worktree 中读写、测试、提交；不能 push、创建 PR、启动完整 review 或宣告交付完成。

`worker_submit` 从实际 worktree 解析 HEAD，不信任模型提供 SHA。Controller 仍验证 clean tree、branch、base/head 与 post-PR remote fixed point。

### Reviewer

Reviewer 是 fresh、read-only、exact-HEAD 审查者。它接收 AttemptContextEnvelope 中的 Objective 作为本 Attempt 唯一 Spec 输入、Harness 生成的 Git evidence、trusted standards bundle 和固定 validation argv。Objective 是 untrusted task data，不能扩权；不足时 Reviewer 返回 `blocked`，不会自行抓取另一份 Issue。

Reviewer 必须：

- 先做 `review_preflight`；
- 在只读 exact-HEAD source snapshot 上启动 fresh Standards / Spec 双轴 child；
- 只在 disposable writable copy 中运行一次 `review_validate`；
- 通过 `review_submit` 写身份绑定结果；
- 保持 candidate repository 中的 instruction files 只是审查对象。

Reviewer skill 只允许双轴完成、固定验证成功且无 blocking finding 时提交 `pass`。运行时工具强制双轴、preflight 与验证成功；Controller 再独立强制身份、exact HEAD 与 clean-tree gate。

### Analyst

Analyst 绑定当前 Job 和 task digest，只在 blocked flow 中读取有界 EvidencePack。它没有 shell、Git、Herdr、ledger write 或 approval 权限；引用 pack 外证据、越界 action 或无效 brief 会被降为 `hold`。

### 人类

人类通过 `status --operator` 查看当前实时投影，再用 `decide --option` 提供 actor 与 reason。recovery gate 只记录精确授权，不直接复用旧 Agent、修改 Git 或跳过 Reviewer。过期 revision、Incident、Analysis 或 option 必须被拒绝。

## 8. 外部边界

| 边界 | 可提供 | 不能证明 |
| --- | --- | --- |
| GitHub | Issue 图、claim、PR、checks、merge | 本地 HEAD、Agent result |
| Git | base/head、祖先、diff、clean tree | PR checks、workflow approval |
| Herdr | worktree、pane、agent 生命周期 | 任务完成或审查通过 |
| Pi CLI / RPC | 角色执行与 runtime observation | durable delivery truth |
| Ledger | workflow state、revision、Incident、Approval | GitHub 或 Git 的实时外部事实 |
| Observer / Telegram | 状态投递、受控 action transport | workflow authority |

Worker 与顶层 Reviewer 都可选择 `herdr-pi-cli` 或 `pi-rpc`。两者仍在 Herdr pane 中运行；Reviewer 内部的两个 review-axis child 属于固定 `pi-subagents` contract，不是第三种顶层 Attempt adapter。

RPC 路径由 pane 内 foreground runner 持有 Pi stdin/stdout。Controller 通过 Attempt-private、原子落盘的 intent 与 receipt 观察它，不接管 pipe，也不在 dispatch 结果不确定时重放 prompt。RPC runner 明确关闭 Pi auto-retry 与 Pi-owned auto-compaction。Worker 使用 snapshot 固定的 75% threshold、最多一次、保留最近 20,000 token 的 Harness-controlled compaction；它只在工具轮次之间运行，overflow continuation 与 summarization retry 均关闭。Reviewer compaction 保持关闭。Receipt 只保存次数、阈值、触发时 context/window、前后 token 估计和 summary digest，不保存 summary 内容；exact version compatibility 由 `src/compatibility.ts` 统一定义并 fail closed。

Worker 工具文本结果在进入后续模型上下文前还有 24 KiB 总上限，超限时保留头尾并给出原始字节数和 digest。Pi 内建分页/完整输出路径仍是重新读取事实的入口；截断结果和 compaction summary 都不是 workflow truth。

## 9. 上下文信任模型

Worker/Reviewer argv 关闭 ambient skills、extensions、sessions、context files、prompt templates 与 themes。Controller 从 Job 的 trusted base SHA 读取允许的 repository policy，按固定优先级选择并导出路径、source SHA 与 digest 绑定的 manifest/bundle；显式空清单也是可验证结果。

信任规则：

- Harness bundled role resources 与 base-SHA policy bundle 是 trusted authority；
- Issue Objective、TypedHandoff、EvidencePack 和 operator statement 是 untrusted data；
- Worker RPC 在每次模型请求前重新注入 exact pinned task-data；compaction 只能有损摘要探索过程，不能替代 Objective、AC、target 或 writeback contract；
- candidate HEAD 新增或修改的 `AGENTS.md`、`CLAUDE.md` 或同类文件是审查对象，不是 Reviewer 指令；
- trusted policy 对其他文件的引用不会自动授予那些文件指令权威；
- context/resource/prompt digest 在副作用前复核，漂移即 blocked；
- blocked Agent 的旧 transcript 不进入新的 Attempt。

Worker 可选加载的 Ponytail 必须是 manifest 声明的 `@dietrichgebert/ponytail` `4.9.0`，且只能排在 bundled `worker-tools.js` 之后。Harness 对其强制 `full`、隐藏 status、静默 startup；任何 Worker `extension_ui_request` / response 仍 fail closed。Reviewer 不加载 Ponytail。

## 10. 当前执行链路

### 正常链路

```text
select + preflight
  -> durable claim
  -> task-bound Analyst session
  -> isolated worktree
  -> fresh Worker Attempt
  -> durable Worker result + Git verification
  -> fresh Reviewer Attempt
  -> durable Reviewer result + exact-HEAD gate
  -> PR / native auto-merge request
  -> required checks + merged observation
  -> done + archive + best-effort claim cleanup
```

Attempt 内部按 `prepared -> pane_ready -> agent_ready -> running -> settled` 推进。prompt dispatch 前先持久化 `running`；dispatch 结果不确定时只观察同一 Attempt，不重复发送。

### Review rework

Reviewer 返回 actionable `changes` 时，Controller 把 findings 生成 target=Worker 的 `TypedHandoff`，关闭旧 Attempt，创建 fresh Worker。新 Worker 完成后必须再创建 fresh Reviewer，不能复用上一轮 Reviewer 结论。

### CI rework

required check 失败时，Controller 记录 HEAD-bound CI evidence、取消 auto-merge 并进入 blocked。每次回修都需要新的精确人类授权，生成 CI handoff，交给 fresh Worker，再走 fresh Reviewer。次数达到代码中的上限后保持 fail closed。

### Blocked recovery

runtime 外部结果短暂迟到时，同一 Attempt 只做一次 bounded reconciliation，且不重放 prompt。窄范围 pre-dispatch Worker 或 same-HEAD Reviewer infrastructure incident 可由 policy 自动授权一次 fresh retry；其余情况依次需要 Incident、EvidencePack、Analyst advice 与精确 human gate。恢复会关闭旧 pane，并创建 fresh Worker 或 Reviewer。

Analyst `hold` 不授权 retry。`reassess` 只创建新的可审计 Incident/Analysis cycle，也不直接授权执行。

## 11. `src/` 模块映射

| 模块 | 当前职责 |
| --- | --- |
| `model.ts` | 领域记录、状态集合、digest 与 invariants |
| `controller.ts` | 单槽生命周期编排与外部 gate 顺序 |
| `eligibility.ts` | Issue 准入与 strict Map frontier |
| `policy.ts` | Incident、EvidencePack、result validation、automatic recovery 与 OperatorAction 投影 |
| `recovery.ts` | approval、reassessment、decision resolution、cancellation 的精确 CAS gate |
| `ports.ts` | GitHub、Git、Herdr、runtime、Analyst、evidence、store 等外部接口 |
| `attempt-plan.ts` | ExecutionSnapshot、resource digest 与 plan integrity |
| `attempt-context.ts` | role-scoped AttemptContextEnvelope |
| `handoff.ts` | review/recovery/CI TypedHandoff 生成与绑定 |
| `prompts.ts` | 只从 bound envelope 渲染 Worker/Reviewer prompt |
| `compatibility.ts` | Pi RPC 与 `pi-subagents` exact compatibility facts |
| `reviewer-provider-profile.ts` | active Reviewer provider profile 的验证与 selector 替换 |
| `controller-lease.ts` / `controller-heartbeat.ts` | 单活 lease 与 liveness heartbeat |
| `pi-rpc-*` | durable RPC plan/spool/runner/SDK host/diagnostics |
| `hermes-status.ts` / `hermes-approval.ts` / `hermes-observer.ts` | Telegram/Hermes compatibility transport |
| `adapters/json-store.ts` | ledger lock、CAS、atomic write 与 event append |
| `adapters/github-gh.ts` | GitHub Issue/claim/PR/checks/merge |
| `adapters/git-cli.ts` | worktree、Git fixed point、trusted context、Reviewer snapshots |
| `adapters/herdr-cli.ts` | Herdr worktree/pane/agent lifecycle |
| `adapters/pi-rpc-runtime.ts` | Controller-facing durable RPC adapter |
| `adapters/local-evidence.ts` | bounded Analyst evidence |
| `adapters/json-command-analyst.ts` | task-bound Analyst JSON protocol |

## 12. 尚未退休的兼容边界

以下路径仍被当前代码或部署接口引用，不能按“历史噪声”删除：

- `HarnessState.version: 1` 是当前磁盘 schema；
- 旧 ledger 可缺少 dependency closure、ExecutionSnapshot、context envelope、reconciliation counter、Approval basis 或 CI fields；
- 无执行快照的 running Attempt 只允许观察，未启动 Attempt 不允许产生新副作用；
- `pendingBrief` 只读存在，用于拒绝旧自由文本续跑；新状态只写 `pendingHandoff`；
- policy 保留旧 Incident 形态的有界 reassessment migration；
- `approve`、`reassess`、`resolve-decision`、`cancel` 仍是 CLI compatibility entrypoints；
- Hermes plugin、Hermes-named scripts/config、fleet config 与 Observer state migration 仍可能被既有部署使用。

删除这些边界前必须先盘点真实 ledger、进程参数、配置和 transport 流量，并提供迁移、测试与回滚证据。
