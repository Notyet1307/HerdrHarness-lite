# Attempt runtime 演进任务

本轮只有三个独立交付面。每项只有一个主要结果和一个主要验收入口；后项不得削弱现有 ledger、result 与 Git fixed-point 真值。

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

## Task 3 — Worker-only Pi RPC adapter 试点

**主要结果：** Worker Attempt 可选择由 Controller 外的持久 runner 托管 Pi RPC；Controller 仍是唯一 workflow writer，且 Controller 重启后可重连同一 Attempt。

**主要验收入口：** adapter 集成测试覆盖 dispatch receipt、重启后观察、terminal/result 收敛、禁止重复 prompt，以及 retry/compaction 显式关闭。

验收断言：

1. RPC 子进程不归短命 Controller 所有，由 Herdr 持久 pane 托管。
2. Controller 与 runner 通过 Attempt 私有、原子落盘的 command/state spool 重连；SDK host 只共享 canonical subscription OAuth 的原生 pathname lock，settings/session 保持内存化，且不挂载或复制全局 auth/models。
3. prompt 只有一个持久 dispatch intent；不确定结果只观察，不重放。
4. runner 只接受已核验的 Pi 0.84.0，启动后立即关闭 auto-retry 与 auto-compaction，再接受 prompt。
5. Pi event 只用于运行观察；完成仍由 Harness result 与 Git 验证决定。
6. Worker CLI 路径保留为第二个真实 adapter，并与 RPC 共用同一 ExecutionSnapshot 合约。
7. SDK host 只把 canonical subscription OAuth 交给 `ModelRuntime`，继续用 Pi 原生 pathname lock 完成 refresh；settings/session 内存化，Attempt 私有目录禁止出现凭据或模型配置文件。
8. Reviewer 继续使用现有 CLI 路径。

## 明确延后 — Reviewer runtime 迁移

Reviewer 迁移不属于本轮三个交付面。只有 Worker RPC 在真实任务中稳定运行、重启恢复与结果/Git 收敛均有证据后，才单独建票评估 Reviewer 的 subagent extension、只读 snapshot、validation tool 与双轴证据迁移；不得直接复用 Worker 的“已稳定”结论。
