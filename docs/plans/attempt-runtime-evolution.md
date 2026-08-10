# Attempt runtime 演进任务

前三项是初始独立交付面；稳定后按用户决定追加 Task 4，再追加两个上下文交付面 Task 5/6。每项只有一个主要结果和一个主要验收入口；后项不得削弱现有 ledger、result 与 Git fixed-point 真值。Agent 首屏不在本轮范围内。

## Task 1 — 不可变 ExecutionSnapshot

**主要结果：** `attempt_prepared` 一次性绑定预检到的 Pi executable/version、完整 role argv、配置的 provider/model selector、thinking、tools、session/retry/compaction/credential 模式、extension 本地模块闭包、Docker host 及 `planDigest`；后续生命周期不再读取可变配置启动同一 Attempt。RPC runner 从该 executable 的同一安装闭包加载公开 SDK、核验版本，并要求显式 provider/model 后从 `get_state` 精确核对；Herdr 交互路径仍只能证明预检身份与 selector 可用，不能证明 Herdr 内部最终解析出的 binary/effective model。

**主要验收入口：** Controller 定向测试证明配置或 runtime 漂移会 fail closed，重启后仍按原快照执行。

验收断言：

1. 新 Attempt 在首次运行时副作用前持久化完整快照与 digest。
2. 同一 Attempt 的 argv 不随 Controller 配置变化。
3. 快照或计划任一绑定字段变化会进入 integrity block。
4. Pi executable/version 变化不会静默继续。
5. 旧 ledger 的 running Attempt 只允许观察；旧的未启动 Attempt 不允许产生新副作用。

## Task 2 — provenance-aware context 信任闭包

**主要结果：** Pi ambient discovery 全部关闭；Worker/Reviewer 只接收 Harness 从可信 base SHA 导出的、带路径与 digest 的仓库规则，以及 Harness 自有角色上下文。

**主要验收入口：** context 定向测试证明全局/祖先/候选 HEAD 指令不能进入角色上下文，受信内容或注入文件漂移会 fail closed。

验收断言：

1. 角色运行强制关闭 context files、prompt templates、themes 与 session discovery。
2. 允许的仓库规则来自 Attempt 绑定的可信 base SHA，并记录 path、source SHA 与 digest。
3. Reviewer 及其两条 fresh review-axis child 把候选 HEAD 中的 `AGENTS.md` 当审查数据，不当运行指令。
4. 用户全局与仓库祖先 context 不进入 Worker/Reviewer。
5. Harness 注入文件在启动前被 digest 复核。
6. 未发现允许的仓库规则也是一个显式、可验证的空清单。
7. Worker 的 bundled TDD adapter 不会把 candidate `CONTEXT.md`、ADR 或间接规则提升为 governing context。
8. Reviewer child 只从 Attempt 私有 agent/config 快照解析，并通过绑定的 Pi wrapper 复核 runtime version、排除动态 `APPEND_SYSTEM.md`。

可信 policy 对其他仓库文件的引用不会自动授予指令权威；只有 manifest 内从 trust anchor 导出的条目能成为 governing context。

## Task 3 — Worker Pi RPC adapter

**主要结果：** Worker Attempt 可选择由 Controller 外的持久 runner 托管 Pi RPC；Controller 仍是唯一 workflow writer，且 Controller 重启后可重连同一 Attempt。

**主要验收入口：** adapter 集成测试覆盖 dispatch receipt、重启后观察、terminal/result 收敛、禁止重复 prompt，以及 retry/compaction 显式关闭。

验收断言：

1. RPC 子进程不归短命 Controller 所有，由 Herdr 持久 pane 托管。
2. Controller 与 runner 通过 Attempt 私有、原子落盘的 command/state spool 重连；SDK host 只共享 canonical subscription OAuth 的原生 pathname lock，settings/session 保持内存化，且不挂载或复制全局 auth/models。
3. prompt 只有一个持久 dispatch intent；不确定结果只观察，不重放。
4. runner 只接受已核验的精确 Pi 版本集合（当前仅 `0.84.0`），每个 Attempt 钉住探测到的精确版本；启动后立即关闭 auto-retry 与 auto-compaction，再接受 prompt。
5. Pi event 只用于运行观察；完成仍由 Harness result 与 Git 验证决定。
6. Worker CLI 路径保留为第二个真实 adapter，并与 RPC 共用同一 ExecutionSnapshot 合约。
7. SDK host 只把 canonical subscription OAuth 交给 `ModelRuntime`，继续用 Pi 原生 pathname lock 完成 refresh；settings/session 内存化，Attempt 私有目录禁止出现凭据或模型配置文件。
8. Reviewer 在本任务完成时仍使用现有 CLI 路径。

## Task 4 — Reviewer 顶层 Pi RPC adapter

**主要结果：** Reviewer 顶层 Attempt 使用与 Worker 相同的 durable runner/spool 与 SDK host，同时保留 exact-HEAD 只读 snapshot、固定 validation tool、Standards/Spec 双轴 child 和 `review_submit`/Git gate。

**主要验收入口：** Reviewer RPC 集成测试证明 `/skill:code-review` 只 dispatch 一次，canonical `models.json` 的路径与摘要绑定到 Attempt，API key 不形成持久副本或写入 receipt，且最终 `pass/changes` 仍必须通过原 Reviewer gate。

验收断言：

1. Reviewer RPC 使用显式 provider/model 和 `canonical-model-config`，不复用 Worker 的 OAuth 假设。
2. SDK host 从 canonical `models.json` 捕获摘要匹配的严格 JSON 字节，在内存把受支持的独立 custom provider 规范化为完整 `ProviderConfigInput`，再通过公开 `ModelRuntime.registerProvider` 注册；compat 仅允许当前部署所需的三个布尔字段与 Pi 0.84 `thinkingFormat` 枚举，不支持的 provider/config 形态 fail closed，私有 agent dir 不出现 `auth.json`、`models.json` 或 credential cache。
3. Provider probe、正式 runtime 和重启恢复消费同一 execution resource identity。
4. 顶层 Reviewer retry/compaction 关闭，session fresh；两条 child 仍由原不可变 wrapper、私有 agent registry 和 capability ceiling 约束。
5. `agent_settled`、child completed 或 validation completed 均不直接成为 workflow truth；durable Reviewer result、exact HEAD 和 clean-tree 验证保持不变。

本任务不迁移 pi-subagents 内部的两条 child 到 SDK host；只有它们需要独立的 durable lifecycle/control 时再单独拆票。

## Task 5 — TypedHandoff v1

**主要结果：** Reviewer changes、获批 recovery 与 CI rework 统一生成带来源和目标绑定的结构化 handoff，并原子移入下一 Attempt；不再把自由文本 brief 当续跑上下文。

**主要验收入口：** rework/recovery 定向测试证明 handoff 绑定来源 revision/digest、目标 lane/base/HEAD，旧 brief 或过期/错目标 handoff 会 fail closed。

Handoff 只是有界的不可信任务数据，不能扩大工具、运行时或仓库 policy 权威。

## Task 6 — AttemptContextEnvelope v1

**主要结果：** 每个新 Attempt 持久化按角色裁剪的上下文投影，明确区分 identity、trusted authority、untrusted task/handoff/evidence、Git target、runtime view 与 writeback contract；最终 prompt 只从该 Envelope 渲染。

**主要验收入口：** Controller 定向测试证明 Worker/Reviewer 获得各自所需字段，Envelope/prompt 漂移会在 pane 或 dispatch 副作用前 fail closed，凭据内容不进入 Envelope。

Envelope 与 ExecutionSnapshot 一并进入 `planDigest`。它不取代可信 context manifest、durable result 或 Git fixed-point gate。
