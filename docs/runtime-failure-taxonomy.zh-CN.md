# Runtime 故障分类与可复现基线

本文描述当前 Pi RPC Worker/Reviewer、Controller 验收和 Reviewer validation 已实现的故障分类与离线 fixture。它不改变 prompt、retry、recovery authority 或交付 gate。

## 1. 不变量

- 一个 Attempt 只有一个 durable `dispatch.json`，Controller 在 dispatch 前先持久化 `running`；结果不确定时只重观察同一 Attempt，不重发 prompt。
- workflow retry 只创建 fresh Worker/Reviewer Attempt。`retryable` 是诊断属性，不是执行授权。
- 交付仍要求身份绑定的 durable result、exact HEAD、clean worktree，以及 Git/GitHub fixed point。Runtime terminal、Herdr/Pi settled、validation pass 都不能单独证明完成。
- Analyst 只能建议。自动 fresh retry 只来自既有 pre-dispatch rule，或 `provider_pre_side_effect_transient`：后者要求完整无副作用 receipt、固定短退避、fresh Attempt，并按 job/lane/HEAD 限一次。
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
| `provider_rate_limit` | execution | Provider failure classifier | 同上 | 否 | 仅完整 pre-side-effect receipt 可命中一次性 Provider policy | 同上 |
| `provider_network` | execution | Provider failure classifier | 同上 | 不确定 | 同上；WebSocket 在首个工具前关闭归入此类 | 同上，不记录原始错误 |
| `provider_timeout` | execution | Provider failure classifier | 同上 | 不确定 | 仅完整 pre-side-effect receipt 可命中一次性 Provider policy | 同上 |
| `provider_continuation_lost` | observation | runner 观察到 partial assistant 或 tool completion 后 child 退出且无 `agent_settled` | bounded observation → `infrastructure_exhausted` | 工具副作用可能已发生，但没有交付事实 | 只有 `toolExecutionStarted=false` 和其他副作用字段全 false 时可命中一次性 Provider policy | Provider API 枚举、tool/turn 计数、child exit、事件 digest |
| `rpc_protocol` | observation | strict JSONL / response identity validator | terminal failure → bounded observation → `infrastructure_exhausted` | 是 | 仅既有 narrow policy | 细粒度 `failureCode`、stage、last event type、指纹 |
| `rpc_event_oversize` | observation | strict JSONL 的 1 MiB 单行上限 | 同上 | 是 | 同上 | 只记录分类、字节数/digest；不记录 payload |
| `rpc_terminal_missing` | observation | runner 的 child-shutdown cleanup | child-shutdown 或 terminal observation 无法在显式 deadline 内确认时 fail closed | 是，尤其 durable result 已先写入时 | 否；先收敛原 Attempt 事实 | receipt identity、owner/child 状态、result 是否存在、事件 digest |
| `runtime_stall` | observation | Pi RPC accepted 或 Herdr dispatch 后 no-progress deadline | 写 terminate intent，bounded runner/native pane termination，写 terminal/terminated；同一 Attempt 不重发 prompt | 不确定 | 否 | accepted identity、最后进展类型/时间、计数、PID、result-present、digest；Herdr 只记输出 digest |
| `attempt_deadline` | execution | Attempt total deadline | 即使持续业务进展也执行同一 bounded termination；timeout 不归类为模型代码失败 | 不确定 | 否 | 与 `runtime_stall` 相同的 bounded progress receipt |
| `child_exit` | execution | runner child lifecycle | terminal failure → bounded observation → `infrastructure_exhausted` | settled 后非零退出时可能，但不能验收 | 仅既有 narrow policy | exit code 或 signal、settled/agent-end 标志、指纹 |
| `tool_contract` | execution | Worker/Reviewer extension tool gate | 当前已定义但 tool hook 仍只返回固定 bounded reason；若 Agent 随后提交 blocked/failed result，Controller 按该 result 进入 `agent_blocked` / `review_uncertain`，此 code 尚未进入 Incident | 否 | 否 | tool 名、固定 reason、是否 error；不记录完整 tool payload |
| `result_missing` | acceptance | Pi RPC adapter / Controller result validation | 一次 same-Attempt observation 后 `infrastructure_exhausted` | 是 | Worker running 不自动；Reviewer 可能命中既有 same-HEAD policy | Attempt identity、result path 是否存在、terminal identity |
| `result_identity` | acceptance | Controller result validation | `integrity_violation` + hold | 否 | 否 | expected/observed job、Attempt、lane、HEAD 的有界值 |
| `git_integrity` | acceptance | Worker Git verification / Reviewer preflight 与 exact-HEAD gate | `integrity_violation` 或 `reviewer_preflight_dirty` | 模型可能已工作，但未形成可交付 fixed point | 否；Reviewer residue 只能经现有 Analyst/human gate fresh retry | HEAD、branch、clean/dirty 分类、允许 result path；不复制凭据文件 |
| `policy_violation` | execution | runner 对 unknown-unsafe/control/auto-retry/multiple-start 事件的 gate | terminal failure → bounded observation → `infrastructure_exhausted` | 可能有 result，但 failure receipt 优先 | 仅既有 narrow policy | 固定 policy code、事件 classification/type/byte count/digest，不记录 payload |
| `compaction_failure` | execution | controlled Worker compaction + runner | content-free failed event → terminal failure → `infrastructure_exhausted` | 否 | Worker running 不自动 | 次数、阈值、context/window、`outcome=failed`、`willRetry=false` |
| `validation_infrastructure` | acceptance | Reviewer preflight / fixed validation launcher | 分类只在 tool-local receipt；Reviewer 若提交 blocked/failed result，Controller 再按 result 进入 `review_uncertain`，Incident 不直接携带此 code | 否 | 否 | command identity、exit/signal、bounded error/tail、Docker version/host identity |
| `validation_failed` | deterministic | 固定 Reviewer validation command | Controller receipt 记录 `failed-checks`；`pass` 被拒绝，Reviewer 必须提交绑定 validation finding 的 changes | 否 | 否 | command identity、exit code、stdout/stderr redaction marker、原始 byte count 与 SHA-256 |

现有 Provider 还会细分 rejected、unavailable、unknown；RPC 还会保留 invalid JSON、command mismatch、transport closed 等 `failureCode`。稳定 `code` 用于跨层聚合，细粒度兼容字段用于定位，二者都不能被压缩成单一 `infrastructure_exhausted` message。

## 4. 离线 deterministic fixtures

所有 fixture 都使用本地 fake child / fake SDK，不连接真实 Provider：

| 场景 | 可复用触发器 | 当前断言 |
| --- | --- | --- |
| Provider 接受请求后永不返回 | `test/fixtures/fake-pi-rpc.js` + `FAKE_PI_PROVIDER_NEVER_RETURNS=1` | no-progress 后写 `runtime_stall`、terminal/terminated，无 prompt replay |
| 持续工具输出直至 total | `FAKE_PI_CONTINUOUS_TOOL_OUTPUT=1` | tool update 刷新 no-progress，total 到期写 `attempt_deadline` |
| `tool_execution_end` 后无 `agent_settled` | `FAKE_PI_TOOL_BEFORE_FAILURE=success` + `FAKE_PI_CONTINUATION_LOST=1` | `provider_continuation_lost`，不保存 tool result |
| 首个工具前 partial assistant 后失联 | `FAKE_PI_ASSISTANT_BEFORE_CONTINUATION_LOST=1` + `FAKE_PI_CONTINUATION_LOST=1` | `provider_continuation_lost` + 完整无工具副作用边界 |
| read/edit/bash 已开始后 Provider 429 | `FAKE_PI_TOOL_START_ONLY=<tool>` + assistant 429 | `toolExecutionStarted=true`，拒绝自动 fresh retry |
| durable result 已写但 terminal 缺失 | `FAKE_PI_RESULT_BEFORE_STALL=1` | result 创建刷新一次进展；随后 `runtime_stall`，failure receipt 优先且仍不能验收 |
| terminal failure 后 durable result 已存在 | `FAKE_PI_TERMINAL_FAILURE_AFTER_RESULT=1` | failure receipt 优先，adapter 拒绝交付 |
| 单条 event 超过 1 MiB | `FAKE_PI_OVERSIZE_EVENT=1` | `rpc_event_oversize`，spool 不保存大 payload |
| Reviewer validation 输出很大 | `test/fixtures/reviewer-validation.js --stdout-bytes/--stderr-bytes` | 5 MiB/stream 与超过旧 20 MiB buffer 的 fixture 都只保存固定 redaction marker、原始 byte count 与 SHA-256；原始 validation 输出不落盘 |
| Review Axis 输出很大 | `test/fixtures/pi-subagents/index.js` + `FAKE_PI_REVIEW_AXIS_OUTPUT_BYTES` | 1 MiB/axis fixture 只向父 Reviewer 返回各 12 KiB 内结构化投影；原文不进入 durable result |
| 无害未知 telemetry | `FAKE_PI_UNKNOWN_EVENT=telemetry` | exact-qualified contract 下只接受无 opaque 文本的有界结构化值，记录 content-free unknown-safe observation，不刷新 progress |
| 未知 UI / retry event | `FAKE_PI_UNKNOWN_EVENT=ui/retry` | 记录 type/byte count/digest 后 content-free `policy_violation` |
| OAuth lock contention | `test/fixtures/fake-pi-sdk.ts` + `FAKE_PI_SDK_OAUTH_LOCK_CONTENTION=1` | SDK host 只输出安全 stage，不输出 OAuth/token/error 原文 |
| controlled compaction Provider 请求失败 | fake compaction SDK 抛错，或 `FAKE_PI_CONTROLLED_COMPACTION=fail` | 单次、无 retry、无 summary/Provider 原文的 `compaction_failure` |

## 5. 记录边界

允许持久化：Attempt/generation/plan identity，稳定分类，允许枚举的 Provider API，4xx/5xx 状态码，bounded counters，transcript/event 字节桶，event/summary/status/worktree digest，六个 side-effect boundary 布尔值，child exit，compaction 数值 receipt，以及固定 validation receipt 的 identity、argv/digest、时间、exit/signal/timeout、环境/resource/source digest 和 stdout/stderr 有界投影。原始 validation 输出不落盘；Review Axis 原文只在权限收紧的 Attempt 私有 evidence 文件中保存。模型只收到有界投影，ledger 只保存 validation receipt 的 path/digest/status binding，terminal receipt 不保存原文。

禁止持久化：access token、OAuth 内容、API key、Provider 原始响应或 stderr、完整私密 transcript、tool 原始 payload、compaction summary 内容和原始 stack。`runtime-events.jsonl` 只保留 event classification/type、原始 payload byte count、digest 和少量 allowlisted 标志，并有 512 KiB 总上限。

## 6. 基线边界

Fixture 证明故障形状、已实现分类、redaction 和 gate 可重复，不证明真实 Provider 的失败率或根因分布。`runtime_stall` 与 `attempt_deadline` 已有生产 emitter；`tool_contract` 和 Reviewer validation 的跨层分类仍有既有边界。以下事实仍只能通过受控真实运行观察：Provider 是否确实接收了某次请求、网络静默发生在本机/proxy/gateway/Provider 哪一层、Pi AuthStorage 的真实锁竞争时序、以及外部 GitHub API/checks 的实时故障。没有这些证据时，不应声称失败率已修复。
