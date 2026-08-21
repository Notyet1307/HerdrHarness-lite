# Runtime 故障分类与可复现基线

本文描述当前 Pi RPC Worker/Reviewer、Controller 验收和 Reviewer validation 已实现的故障分类与离线 fixture。它不改变 prompt、retry、recovery authority 或交付 gate。

## 1. 不变量

- 一个 Attempt 只有一个 durable `dispatch.json`，Controller 在 dispatch 前先持久化 `running`；结果不确定时只重观察同一 Attempt，不重发 prompt。
- workflow retry 只创建 fresh Worker/Reviewer Attempt。`retryable` 是诊断属性，不是执行授权。
- 交付仍要求身份绑定的 durable result、exact HEAD、clean worktree，以及 Git/GitHub fixed point。Runtime terminal、Herdr/Pi settled、validation pass 都不能单独证明完成。
- Analyst 只能建议。自动 fresh retry 仍只来自 `worker_pre_dispatch_infrastructure` 或 `reviewer_same_head_infrastructure` 两条既有、一次性、指纹绑定的 policy rule。
- 新写入的 runner/controller safe failure receipt 至少包含稳定的 `domain`、`code`、`stage`、`retryable`。兼容字段 `failureDomain`、`failureCode`、`failureStage` 保留细粒度 runtime 信息和旧 ledger 读能力。Reviewer validation 的分类目前只存在于 tool-local `failure` 对象，尚未进入 durable Reviewer result。

## 2. 稳定字段

`domain` 明确区分四种失败：

| domain | 含义 |
| --- | --- |
| `execution` | Provider、child、tool/policy 或 compaction 没有完成一次受约束执行 |
| `observation` | RPC、terminal 或 continuation 证据不足，不能确定执行结局 |
| `acceptance` | result identity、Git fixed point 或 validation 环境未满足验收条件 |
| `deterministic` | 固定代码/测试命令给出可重复的非零失败 |

`stage` 绑定产生分类时的固定处理阶段，例如 `handshake`、`agent-run`、`terminal-observation`、`result-validation`、`git-verification`、`review-preflight`、`review-axis`、`review-validation` 或 `compaction`。自由文本 message 只作有界说明，不能代替这些字段。

## 3. 当前分类与路径

| code | domain | 产生层 | 当前 Incident / Recovery 路径 | 可能“任务已完成但观测失败” | 自动 fresh retry | 可安全记录 |
| --- | --- | --- | --- | --- | --- | --- |
| `provider_auth` | execution | SDK host / Provider failure classifier | terminal failure → bounded same-Attempt observation → 通常 `infrastructure_exhausted` | 否 | code 本身不授权；Reviewer 仍可能命中既有 same-HEAD policy | HTTP 状态、Provider API 枚举、阶段、计数、指纹 |
| `provider_rate_limit` | execution | Provider failure classifier | 同上 | 否 | 同上；`retryable=true` 仍不等于授权 | 同上 |
| `provider_network` | execution | Provider failure classifier | 同上 | 不确定 | 同上 | 同上，不记录原始错误 |
| `provider_timeout` | execution | Provider failure classifier | 同上 | 不确定 | 同上 | 同上 |
| `provider_continuation_lost` | observation | runner 在 tool completion 后观察到 child 退出且无 `agent_settled` | bounded observation → `infrastructure_exhausted` | 工具副作用可能已发生，但没有交付事实 | `retryable=false`；不自动重放 | Provider API 枚举、tool/turn 计数、child exit、事件 digest |
| `rpc_protocol` | observation | strict JSONL / response identity validator | terminal failure → bounded observation → `infrastructure_exhausted` | 是 | 仅既有 narrow policy | 细粒度 `failureCode`、stage、last event type、指纹 |
| `rpc_event_oversize` | observation | strict JSONL 的 1 MiB 单行上限 | 同上 | 是 | 同上 | 只记录分类、字节数/digest；不记录 payload |
| `rpc_terminal_missing` | observation | runner 的 child-shutdown cleanup | child-shutdown 无法确认时写入 `terminated.json`；普通 terminal 缺失目前只表现为 adapter 持续等待，不会自行生成此 code | 是，尤其 durable result 已先写入时 | 否；先收敛原 Attempt 事实 | receipt identity、owner/child 状态、result 是否存在、事件 digest |
| `runtime_stall` | observation | accepted 后无 terminal 的 liveness 分类 | 当前已定义但没有生产 timeout emitter；fixture 只证明 accepted 后可稳定悬挂，受控 terminate 后实际 receipt 是 `runtime_terminated` | 不确定 | 否 | accepted identity、最后事件类型/数量、bounded counters |
| `child_exit` | execution | runner child lifecycle | terminal failure → bounded observation → `infrastructure_exhausted` | settled 后非零退出时可能，但不能验收 | 仅既有 narrow policy | exit code 或 signal、settled/agent-end 标志、指纹 |
| `tool_contract` | execution | Worker/Reviewer extension tool gate | 当前已定义但 tool hook 仍只返回固定 bounded reason；若 Agent 随后提交 blocked/failed result，Controller 按该 result 进入 `agent_blocked` / `review_uncertain`，此 code 尚未进入 Incident | 否 | 否 | tool 名、固定 reason、是否 error；不记录完整 tool payload |
| `result_missing` | acceptance | Pi RPC adapter / Controller result validation | 一次 same-Attempt observation 后 `infrastructure_exhausted` | 是 | Worker running 不自动；Reviewer 可能命中既有 same-HEAD policy | Attempt identity、result path 是否存在、terminal identity |
| `result_identity` | acceptance | Controller result validation | `integrity_violation` + hold | 否 | 否 | expected/observed job、Attempt、lane、HEAD 的有界值 |
| `git_integrity` | acceptance | Worker Git verification / Reviewer preflight 与 exact-HEAD gate | `integrity_violation` 或 `reviewer_preflight_dirty` | 模型可能已工作，但未形成可交付 fixed point | 否；Reviewer residue 只能经现有 Analyst/human gate fresh retry | HEAD、branch、clean/dirty 分类、允许 result path；不复制凭据文件 |
| `policy_violation` | execution | runner 对 unknown/control/auto-retry/multiple-start 事件的 gate | terminal failure → bounded observation → `infrastructure_exhausted` | 可能有 result，但 failure receipt 优先 | 仅既有 narrow policy | 固定 policy code、事件 type/digest，不记录 payload |
| `compaction_failure` | execution | controlled Worker compaction + runner | content-free failed event → terminal failure → `infrastructure_exhausted` | 否 | Worker running 不自动 | 次数、阈值、context/window、`outcome=failed`、`willRetry=false` |
| `validation_infrastructure` | acceptance | Reviewer preflight / fixed validation launcher | 分类只在 tool-local receipt；Reviewer 若提交 blocked/failed result，Controller 再按 result 进入 `review_uncertain`，Incident 不直接携带此 code | 否 | 否 | command identity、exit/signal、bounded error/tail、Docker version/host identity |
| `validation_failed` | deterministic | 固定 Reviewer validation command | 分类只在 tool-local receipt；`pass` 被拒绝，Reviewer 可提交 changes 进入正常 rework，或 blocked/failed 进入 `review_uncertain` | 否 | 否 | command identity、exit code、各 50 KB stdout/stderr tail |

现有 Provider 还会细分 rejected、unavailable、unknown；RPC 还会保留 invalid JSON、command mismatch、transport closed 等 `failureCode`。稳定 `code` 用于跨层聚合，细粒度兼容字段用于定位，二者都不能被压缩成单一 `infrastructure_exhausted` message。

## 4. 离线 deterministic fixtures

所有 fixture 都使用本地 fake child / fake SDK，不连接真实 Provider：

| 场景 | 可复用触发器 | 当前断言 |
| --- | --- | --- |
| Provider 接受请求后永不返回 | `test/fixtures/fake-pi-rpc.js` + `FAKE_PI_PROVIDER_NEVER_RETURNS=1` | 有 accepted、无 result/terminal；受控 terminate 后写 `runtime_terminated`，无 prompt replay |
| `tool_execution_end` 后无 `agent_settled` | `FAKE_PI_TOOL_BEFORE_FAILURE=success` + `FAKE_PI_CONTINUATION_LOST=1` | `provider_continuation_lost`，不保存 tool result |
| durable result 已写但 terminal 缺失 | `FAKE_PI_RESULT_BEFORE_STALL=1` | result 存在、terminal 不存在且 adapter 会继续等待；受控 terminate 后仍不能验收 |
| terminal failure 后 durable result 已存在 | `FAKE_PI_TERMINAL_FAILURE_AFTER_RESULT=1` | failure receipt 优先，adapter 拒绝交付 |
| 单条 event 超过 1 MiB | `FAKE_PI_OVERSIZE_EVENT=1` | `rpc_event_oversize`，spool 不保存大 payload |
| Reviewer validation 输出很大 | `test/fixtures/reviewer-validation.js --stdout-bytes/--stderr-bytes` | 各自只返回 50 KB tail |
| Review Axis 输出很大 | `test/fixtures/pi-subagents/index.js` + `FAKE_PI_REVIEW_AXIS_OUTPUT_BYTES` | 双轴判定可完成，axis 原文不进入 durable Reviewer result |
| 未知 RPC event | `FAKE_PI_UNKNOWN_EVENT=1` | content-free `policy_violation` |
| OAuth lock contention | `test/fixtures/fake-pi-sdk.ts` + `FAKE_PI_SDK_OAUTH_LOCK_CONTENTION=1` | SDK host 只输出安全 stage，不输出 OAuth/token/error 原文 |
| controlled compaction Provider 请求失败 | fake compaction SDK 抛错，或 `FAKE_PI_CONTROLLED_COMPACTION=fail` | 单次、无 retry、无 summary/Provider 原文的 `compaction_failure` |

## 5. 记录边界

允许持久化：Attempt/generation/plan identity，稳定分类，允许枚举的 Provider API，4xx/5xx 状态码，bounded counters，transcript/event 字节桶，event/summary digest，child exit，compaction 数值 receipt，以及固定 validation 的 exit/signal。Reviewer validation tail 只在本次 Reviewer tool result 中有界返回，不自动进入 ledger。

禁止持久化：access token、OAuth 内容、API key、Provider 原始响应或 stderr、完整私密 transcript、tool 原始 payload、compaction summary 内容和原始 stack。`runtime-events.jsonl` 只保留 event type、digest 和少量 allowlisted 标志，并有 512 KiB 总上限。

## 6. 基线边界

Fixture 证明故障形状、已实现分类、redaction 和 gate 可重复，不证明真实 Provider 的失败率或根因分布。`runtime_stall`、普通 terminal-missing 和 `tool_contract` 目前只有定义或可复现状态，没有独立的生产 emitter；Reviewer validation 分类也仍是 tool-local observation。以下事实仍只能通过受控真实运行观察：Provider 是否确实接收了某次请求、网络静默发生在本机/proxy/gateway/Provider 哪一层、Pi AuthStorage 的真实锁竞争时序、以及外部 GitHub API/checks 的实时故障。没有这些证据时，不应声称失败率已修复。
