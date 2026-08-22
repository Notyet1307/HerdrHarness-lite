# HerdrHarness Lite 当前架构

本文只描述当前 `src/`、`test/`、配置解析和集成代码已经实现的系统。运行时事实以代码、测试、配置验证和外部系统的实时读数为准。

## 1. 范围与非目标

HerdrHarness Lite 的单项目核心是一个单槽、持久化、fail-closed 的 GitHub Issue 交付控制器。每个项目独立选择并交付一个符合准入条件的任务，绑定事实与执行计划，驱动 fresh Worker 和 fresh Reviewer，验证 Git fixed point，发布 PR，等待 required checks 与 merge，最后归档。可选 Fleet Supervisor 在项目进程层同时运行多个隔离的单项目 Controller，但不会合并它们的 workflow authority。

当前范围：

- 一个 Controller 实例管理一个配置 lane；
- 一个 lane 同时最多有一个 active Job；
- 可选 Fleet Supervisor 同时监督多个配置 lane；每个 lane 仍拥有独立 repo、source、state、worktree、lease 和 Herdr session；
- GitHub Issue 与 strict Map frontier 负责待办选择；
- Herdr 承载 worktree、pane 和 agent 生命周期；
- Worker 与 Reviewer 可分别使用 `herdr-pi-cli` 或 `pi-rpc` Attempt adapter；
- JSON ledger 保存 workflow truth；
- Analyst、Observer 和 Telegram 只提供诊断、观察或受控操作入口。

非目标：

- 通用多代理平台或任意深度 agent tree；
- 同一项目内部的多任务并行调度器；项目级并发由 Fleet 通过独立 Controller 进程提供；
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
| 项目进程生命周期、退避、熔断、Supervisor 存活 | Fleet state / lease / heartbeat |

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

`Attempt` 是一次 fresh Worker 或 Reviewer 执行。它绑定 lane、round、base、预期 HEAD、result path、phase、prompt digest、执行快照、上下文 envelope、可选 validation receipt path/digest/status、一次性 Reviewer checkpoint inputs、Herdr handle 和 durable result。blocked 或已完成 Attempt 不会被恢复为新的写入执行；重试创建 fresh Attempt，且不会恢复旧 transcript。

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
- session、retry、compaction、credential 模式、canonical auth realpath digest，以及 Reviewer axis concurrency；
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

启用 controlled compaction 的 Worker RPC 请求上下文分四层：Harness/仓库角色约束留在 trusted system prompt；Objective、AC、TypedHandoff 与精确 Git target 进入 digest 绑定的 untrusted pinned task-data；探索过程进入可压缩 history；工具白名单、Git fixed point、ledger、policy 与 human gate 继续由模型外强制。Pinned block 通过 Pi request-local context transform 在每次模型请求前原样注入，不写入 session history，也不进入 compaction summary。Disabled Worker 直接在初始 prompt 中携带这些任务事实，不加载 private compaction module。

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
validation_infrastructure
infrastructure_exhausted
integrity_violation
stale_task
ci_failure
ci_rework_exhausted
analyst_unavailable
```

这些字符串由 `src/model.ts` 定义。新增、删除或重解释任何值都属于 ledger 与恢复语义变更，不能只改文档。

## 5. 单写 Controller 与持久化

`HarnessController.tick()` 是自动状态迁移入口。它读取当前 state，按 `JobState` 执行一个分支，并在一次 tick 中最多持久化一次状态迁移后返回。`src/controller.ts` 只保留公开 facade 与状态分发；task、Attempt、runtime、delivery、recovery 和 config 逻辑分别位于 `src/controller/` 的聚焦模块。单项目 `run` 持有 lease 并循环调用 `tick()`，同时通过 signal latch 响应 `SIGINT`/`SIGTERM`，使 heartbeat 与 lease 走正常 `finally` 清理路径。

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

Worker 接收 TaskSnapshot Objective、base/branch、trusted repository context、可选 TypedHandoff 和 `worker_submit` contract。启用 controlled compaction 时，RPC Worker 的稳定角色约束保留在 system prompt，精确任务事实由 request-local pinned block 提供；disabled 时任务事实保留在一次性初始 prompt。两者都不依赖 compaction summary。Worker 可以在独立 worktree 中读写、测试、提交；不能 push、创建 PR、启动完整 review 或宣告交付完成。

`worker_submit` 从实际 worktree 解析 HEAD，不信任模型提供 SHA。Controller 仍验证 clean tree、branch、base/head 与 post-PR remote fixed point。

### Reviewer

Reviewer 是 fresh、read-only、exact-HEAD 审查者。固定 validation argv 在 Attempt 产生任何副作用前绑定；Controller 随后导出只读 source snapshot 和 disposable writable validation copy，执行命令并原子持久化 `validation-receipt.json`。同一 tick 只把 receipt binding 写入 ledger；后续 tick 复核 receipt 后才允许 Reviewer Provider 启动。Objective 是 untrusted task data，不能扩权；不足时 Reviewer 返回 `blocked`，不会自行抓取另一份 Issue。

Reviewer 必须：

- 先做 `review_preflight`；
- 只为缺失阶段在只读 exact-HEAD source snapshot 上启动 fresh Standards / Spec child；`openai-codex + canonical-oauth` 固定 `axisConcurrency=1` 并按 Standards、Spec 串行，custom Provider 使用绑定的 1 或 2；
- 只读取 exact-HEAD、digest-bound 的 Controller validation receipt，不启动或等待 validation 进程；
- 通过 `review_submit` 写身份绑定结果；
- 保持 candidate repository 中的 instruction files 只是审查对象。

receipt 的 `passed` 允许继续 `pass` gate；正常非零退出记录为 `failed-checks`，Reviewer 必须把固定 validation finding 纳入 `changes`；spawn、路径、权限、超时或环境失败记录为 `infrastructure-error`，Controller 在 Provider 启动前进入 `validation_infrastructure` block。已有有效 receipt 在 restart 后复用，绑定或 source digest 漂移则 fail closed。Reviewer skill 与运行时工具继续强制双轴和 finding identity；Controller 再独立强制身份、exact HEAD、receipt 与 clean-tree gate。

Reviewer 的确定性阶段分别写入 Attempt-private 的 `reviewer-preflight.json`、`standards-axis.json`、`spec-axis.json`、`validation-receipt.json` 和 `reviewer-final.json`。每个文件绑定 source Attempt/job revision、task/base/exact HEAD、runtime/provider/model/resource digests、trusted context bundle digest、stage、结构化 result 及 result digest，并以 Harness-owned 原子不可覆盖方式创建。candidate source、child Agent 和普通工具没有写入这些路径的能力。

same-HEAD Reviewer runtime failure仍先关闭旧 Attempt，再创建 fresh aggregation Attempt。Controller 只导入身份与 digest 全部匹配、尚未被另一 Attempt 消费的 checkpoint；单轴存在时只补另一轴，两轴存在时只做确定性 final aggregation，`reviewer-final` 存在时仍必须由 fresh Attempt 成功调用 `review_submit`。无效、可写、格式错误、HEAD/task/resource/context 漂移或已消费 checkpoint 不提供任何完成事实；对应阶段重跑或 fail closed。checkpoint 从不扩大工具、权限或 recovery authority。

顶层 Reviewer prompt 从绑定 snapshot 明示大小写敏感的真实工具 allowlist，其中没有 `review_validate`。Harness 注入上下文总预算为 256 KiB；初始 prompt、trusted bundle 与 bundled review skill 在 dispatch 前计数，后续 `read`/`grep`/`find`/`ls`、双轴和 receipt projection 继续累计，超限以 `reviewer_context_budget_exceeded` fail closed。receipt 的 stdout/stderr 内容统一替换为固定 redaction marker，只保留原始 byte count 与 SHA-256，原始 validation 输出不落盘；Standards/Spec 各只返回最多 12 KiB 的结构化 status/summary/findings/evidence refs 与原始输出 digest，`review_submit` 机械绑定每项 axis/validation finding identity。完整 axis 输出只写入 Attempt 私有 evidence，不能替代 exit code、finding identity、durable result 或 Git gate。

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
| Transport projection / Observer / Telegram | 版本化只读事实、状态投递、受控 action transport | workflow authority |

Worker 与顶层 Reviewer 都可选择 `herdr-pi-cli` 或 `pi-rpc`。两者仍在 Herdr pane 中运行；Reviewer 内部的两个 review-axis child 属于固定 `pi-subagents` contract，不是第三种顶层 Attempt adapter。

RPC 路径由 pane 内 foreground runner 持有 Pi stdin/stdout。Controller 通过 Attempt-private、原子落盘的 intent 与 receipt 观察它，不接管 pipe，也不在 dispatch 结果不确定时重放 prompt。RPC runner 明确关闭 Pi auto-retry 与 Pi-owned auto-compaction。`workerCompaction.mode` 缺省为 `disabled`；只有显式 `controlled-threshold` 的 Worker 才使用 snapshot 固定的 75% threshold、最多一次、保留最近 20,000 token 的 Harness-controlled compaction。它只在工具轮次之间运行，overflow continuation 关闭；summary 请求仅对 network/rate-limit/timeout 允许一次 Harness-owned retry，Pi 内建 retry 仍关闭。Reviewer compaction 始终关闭。唯一 private compaction import 隔离在 exact-version compatibility adapter；disabled 不加载该模块。SDK host 在 stdout 边界把 event 显式分成 observational、progress、authority-changing、forbidden、unknown-safe 与 unknown-unsafe，并只转发有界投影；只有 exact-qualified Pi 版本、无控制/响应/credential 形状、无 opaque 文本 payload 且可有界序列化的未知事件可作为不刷新 progress 的 observation，其余未知事件 fail closed。需要文本的新增日志事件必须先进入对应 exact-version contract。Terminal receipt 还记录 content-free 的 `assistantContentObserved`、`toolCallObserved`、`toolExecutionStarted`、`durableResultPresent`、`worktreeChanged` 与 `commitCreated`；Git/status 只保存 digest 或布尔结论，不保存原始 Provider、tool 或私密 transcript 内容。Compaction receipt 只保存 trigger、次数、阈值、context/window、payload byte estimate、summary attempt count/duration、retry 使用情况、前后 token estimate、summary digest 或稳定 failure domain/code，不保存 summary 内容；exact version compatibility 由 `src/compatibility.ts` 与单一 adapter fail closed，qualified version 的 event contract 由 fixture 锁定。

canonical OAuth 仍只存在于原 canonical `auth.json`。Harness 以其 realpath 的 SHA-256 作为 `credentialDomainId`，在 credential store 内的私有 coordination directory 用 `provider + credentialDomainId` O_EXCL lease 协调跨项目 Provider probe、credential load、Herdr/Pi child startup 与 RPC ready handshake。Lease 只保存 domain digest、instanceId、PID、acquiredAt 和 heartbeat；只有 owner 可释放，只有 PID 已死且 heartbeat 超时才可回收，malformed lease fail closed。stale takeover 在原生 advisory lock 内原子 replace lease，回收进程崩溃时 OS 自动释放 lock，且 lease path 不出现可被另一 contender 抢占/误删的空窗。成功 probe 的短 TTL cache 还绑定 provider、model 与 auth 文件元数据 digest；每次 SDK startup 仍执行 credential validation/getAuth，refresh 或 child 启动失败会立即删除 cache。Reviewer axis launcher 在 qualified Pi `0.84.2` 的首个 assistant `message_start`（该版本在 `prepareRequest/getAuth` 打开 Provider stream 后才发出）释放 lease；旧 qualified runtime 保守持有到 child 结束。失败发生在释放后时，launcher 会重新取 lease 再失效 cache，因此不同项目的非 credential review 阶段仍可并行。Axis child JSONL 只保留生命周期/工具元数据和 bounded terminal review JSON；Provider error、`agent_end` messages、delta content 与未知 payload 不转发。

SDK host 构造主 Pi Session 时使用独立的 Attempt-private `pi-agent`，并显式绑定 canonical `ModelRuntime`、in-memory settings 与 session；该目录继续禁止 `auth.json`、`models.json` 和 `settings.json`。Session 构造完成后，工具子进程继承的 `PI_CODING_AGENT_DIR` 切换到同一 runtime root 下独立的 `tool-agent`，避免 bash 中启动的嵌套 Pi 把默认 store 写回主目录。`tool-agent` 只接受 mode `0600`、单链接且内容严格为 `{}` 的 `auth.json` / `models-store.json` 初始化壳；任何非空 credential、`models.json`、`settings.json`、symlink 或 hardlink 仍 fail closed。两类目录都不读取或复制 canonical credential。

Worker 工具文本结果在进入后续模型上下文前还有 24 KiB 总上限，超限时保留头尾并给出原始字节数和 digest。Pi 内建分页/完整输出路径仍是重新读取事实的入口；截断结果和 compaction summary 都不是 workflow truth。

## 9. 上下文信任模型

Worker/Reviewer argv 关闭 ambient skills、extensions、sessions、context files、prompt templates 与 themes。Controller 从 Job 的 trusted base SHA 读取允许的 repository policy，按固定优先级选择并导出路径、source SHA 与 digest 绑定的 manifest/bundle；显式空清单也是可验证结果。

信任规则：

- Harness bundled role resources 与 base-SHA policy bundle 是 trusted authority；
- Issue Objective、TypedHandoff、EvidencePack 和 operator statement 是 untrusted data；
- controlled Worker RPC 在每次模型请求前重新注入 exact pinned task-data；compaction 只能有损摘要探索过程，不能替代 Objective、AC、target 或 writeback contract；
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

runtime 外部结果短暂迟到时，同一 Attempt 只做一次 bounded reconciliation，且不重放 prompt。窄范围 pre-dispatch Worker/same-HEAD Reviewer infrastructure incident 保留原有一次性 policy 与 Analyst advice 条件；dispatch 后只有明确 transient Provider code 且 `toolExecutionStarted`、durable result、worktree change、commit 全为 false 时，`provider_pre_side_effect_transient` 才能由确定性 policy 在固定短退避后直接授权一次 fresh retry，不调用或等待 Analyst。该规则按 job/lane/HEAD 限一次，并把 provider、failure code、Attempt 与 HEAD 绑定到 fingerprint；恢复执行前还会重新检查 result path、Git HEAD 与 clean worktree。Analyst 只能提供建议，不能创建 candidate、Approval 或执行恢复；第二次同 scope 失败、`validation_infrastructure`、auth/tool/result/Git/policy/compaction 错误以及任何已开始工具的失败都保持 blocked。恢复会确认关闭旧 pane/runner，并创建 fresh Worker 或 Reviewer；Reviewer 可带入一次性、plan-bound 的有效阶段 checkpoint，但不带入旧 session 或 transcript。

Analyst `hold` 不授权 retry。`reassess` 只创建新的可审计 Incident/Analysis cycle，也不直接授权执行。

## 11. `src/` 模块映射

| 模块 | 当前职责 |
| --- | --- |
| `model.ts` | 领域记录、状态集合、digest 与 invariants |
| `controller.ts` | 公开 `HarnessController` facade 与 `JobState` 分发 |
| `controller/task-lifecycle.ts` | 选择、claim、worktree 与归档 |
| `controller/attempt-*` | Attempt 准备、驱动、完整性、收口与 bounded reconciliation |
| `controller/reviewer-validation.ts` | Reviewer 前置 validation receipt 的绑定、复核与 block 分类 |
| `controller/reviewer-checkpoints.ts` | fresh Reviewer checkpoint source、一次性 input 与运行前复核 |
| `controller/runtime-preflight.ts` | Provider、Docker、Pi 与 execution snapshot gate |
| `controller/delivery.ts` | PR、CI、base refresh 与 merge observation |
| `controller/recovery-flow.ts` / `controller/automatic-recovery.ts` | EvidencePack、Analyst、late result、CI reconciliation，以及 policy fresh retry 的授权与副作用复核 |
| `controller/config-validation.ts` | 单项目路径、runtime 与 Pi role contract |
| `fleet-cli.ts` / `fleet/*` | 多项目配置隔离、进程监督、退避、熔断、状态与聚合观察 |
| `shutdown-signal.ts` | 单项目长运行循环的可中断 poll 与正常资源释放 |
| `eligibility.ts` | Issue 准入与 strict Map frontier |
| `policy.ts` | Incident、EvidencePack、result validation、automatic recovery 与 OperatorAction 投影 |
| `recovery.ts` | approval、reassessment、decision resolution、cancellation 的精确 CAS gate |
| `ports.ts` | GitHub、Git、Herdr、runtime、Analyst、evidence、store 等外部接口 |
| `attempt-plan.ts` | ExecutionSnapshot、resource digest 与 plan integrity |
| `attempt-context.ts` | role-scoped AttemptContextEnvelope |
| `handoff.ts` | review/recovery/CI TypedHandoff 生成与绑定 |
| `prompts.ts` | 只从 bound envelope 渲染 Worker/Reviewer prompt |
| `reviewer-context-budget.ts` | 顶层 Reviewer Harness 注入上下文的固定预算与 fail-closed code |
| `reviewer-checkpoints.ts` | Reviewer stage schema、身份 digest 与跨 Attempt compatibility |
| `compatibility.ts` | Pi RPC 与 `pi-subagents` exact compatibility facts |
| `reviewer-provider-profile.ts` | active Reviewer provider profile 的验证与 selector 替换 |
| `controller-lease.ts` / `controller-heartbeat.ts` | 单活 lease 与 liveness heartbeat |
| `pi-rpc-*` | durable RPC plan/spool/runner/SDK host/diagnostics |
| `transport/*` / `transport-cli.ts` | 无 Telegram HTML 的 v2 project/fleet/diagnostic/event 安全投影 |
| `hermes-status.ts` / `hermes-approval.ts` / `hermes-observer.ts` | v1 Telegram/Hermes compatibility 与 v2 Project Observer/精确 challenge |
| `fleet-observer.ts` / `observer/*` | Fleet 生命周期通知、Observer state/outbox/dedupe/delivery；不拥有 workflow transition |
| `adapters/json-store.ts` | ledger lock、CAS、atomic write 与 event append |
| `adapters/github-gh.ts` | GitHub Issue/claim/PR/checks/merge |
| `adapters/git-cli.ts` | worktree、Git fixed point、trusted context、Reviewer snapshots |
| `adapters/reviewer-validation-runner.ts` | 无 shell 的固定 argv 执行、超时与有界输出持久化 |
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
- Hermes plugin、Hermes-named scripts/config、Telegram fleet config 与 Observer state migration 仍可能被既有部署使用。

## 13. 项目级 Fleet Supervisor

Fleet 的并发单位是项目配置 lane，不是单个 Issue。每个启用项目由原单项目 CLI 的独立子进程运行，继续使用自己的 Controller ledger、Controller lease、heartbeat、Git checkout、worktree root 和 Herdr session。

启动任何子进程前，Fleet fail closed 校验重复 project ID、配置路径、GitHub repo、Herdr session，以及 Fleet/项目内部和项目之间所有 `localPath`、`stateDir`、`worktreeRoot` 的相等、父子或符号链接重叠。

Fleet 只持久化项目进程生命周期：`pending`、`starting`、`running`、`adopted`、`backoff`、`tripped`、`stopping`、`stopped`、`disabled`、`unselected`、`error`。它不能 claim Issue、创建 Attempt、批准 recovery、push、publish 或 merge。

已存在且持有有效 Controller lease 的项目进入 `adopted`，Fleet 只观察其存活，不创建第二写者。Fleet 自己拥有的子进程异常退出时，仅该项目进入指数退避或熔断；兄弟项目不会被取消。Supervisor 只在退出时终止自己拥有的子进程，不杀死 adopted Controller。

Fleet 加载时绑定每个项目配置的 digest，并把该 digest 交给单项目 CLI 在产生项目副作用前复核。运行中的 Supervisor 不热加载项目配置；配置漂移只会让新 child fail closed，修改后必须重启 Fleet 重新验证全部隔离边界。

项目的重启历史和熔断状态按项目配置 digest 恢复；其他项目或 Fleet 全局配置变化不能隐式重置该项目的故障预算。child stdout/stderr 只以带项目身份的 envelope 转发，不复制进持久 Fleet state。

项目 state/worktree/Herdr session 继续完全隔离；canonical OAuth credential store 是显式共享的外部资源，只通过上述 digest-keyed startup lease 协调，不进入任何项目 `stateDir`。

Fleet 状态位于独立 `fleet-state.json`，项目业务真相仍位于各项目 `state.json`。Supervisor 在启动 child 前要求初始 Fleet checkpoint 成功；运行中的观测 checkpoint 失败只告警并继续隔离监督，避免 Fleet 存储降级扩散成兄弟项目失控。两类状态在原子提交成功后，即使后续 audit append 失败，也不得向调用方伪装成状态未提交。

Transport v2 从这些权威状态生成有界 JSON：Project projection 组合 ledger、Controller lease/heartbeat 和安全 runtime/Reviewer receipt；Fleet projection 组合真实 Supervisor state、lease、heartbeat 与项目 process phase；diagnostic projection 复用既有安全聚合。Projection 不含 Telegram HTML、task body、原始 evidence/result、绝对私有路径、auth path、Provider 原始响应或 transcript。Project Observer 与 Fleet Observer 只比较 projection 并维护自己的 outbox/dedupe state；Bridge 才负责 Telegram 渲染。Telegram callback 只携带短 `routeId` 和 challenge token，最终仍由 Core option、Harness CLI `decide` 与 ledger CAS 校验。

删除这些边界前必须先盘点真实 ledger、进程参数、配置和 transport 流量，并提供迁移、测试与回滚证据。

## 14. Provider / Runtime Canary

Canary 是独立的本地实验入口，不调用 HarnessController.tick() 或任何 GitHub port。它在专用 state directory 中生成固定 disposable repository，并直接复用模块化 Attempt preparation/driver、Worker/Reviewer runtime adapter、Reviewer validation 和 Git gate。每个 repetition 使用独立 Job、Attempt、branch、worktree 与 terminal unit receipt；恢复时 running Attempt 只能继续 observation，不能重新 dispatch。

主要 A/B 只聚合 serial measured units；stress、deterministic fault simulation 和 unsupported cells 分开报告。Worker custom Provider 与 canonical OAuth Reviewer axis concurrency 2 保持 unsupported，不通过修改 identity、credential 或 Reviewer policy 形成实验格子。Canary 证明本地 durable result、exact HEAD、clean worktree 和 Git fixed point，不创建或声称 GitHub delivery fixed point。
