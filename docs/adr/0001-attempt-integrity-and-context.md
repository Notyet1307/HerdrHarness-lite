# ADR 0001：Attempt 完整性与显式上下文闭包

- 状态：Accepted
- 范围：Worker 与 Reviewer Attempt

## 背景

Controller 重启、配置变化、role resource 漂移和 Pi ambient discovery 都可能让同一 durable Attempt 在不同上下文中执行。Herdr/Pi runtime event 还能表明执行活跃或结束，但不能证明任务结果与 Git fixed point 一致。

## 决策

1. 每个新 Attempt 在 runtime side effect 前持久化 immutable `ExecutionSnapshot`、`AttemptContextEnvelope`、prompt digest 与 `planDigest`。
2. Snapshot 绑定 executable、exact runtime version、完整 argv、tools、provider/model、session/retry/compaction/credential 模式、Docker host、result channel 和所有 role/runtime resource digest。
3. Repository governing context 只从 Job base SHA 导出，写入路径、source SHA 与 digest 绑定的 manifest/bundle；ambient discovery 保持关闭。
4. Objective、handoff、evidence 和 candidate HEAD instruction files 都是 untrusted data，不能扩大 trusted authority。
5. 任何 plan、resource、environment、context、envelope 或 prompt 漂移都在副作用前 fail closed。
6. pane/agent 状态、RPC receipt/event、child completion 和 validation completion 只用于观察；workflow acceptance 仍要求身份绑定的 durable result 与 Git/GitHub gate。

## 结果

- Controller 重启后只执行已绑定计划，不重新解释可变配置。
- Reviewer 对 candidate HEAD 的规则文件保持独立，不把审查对象提升为指令。
- 旧的 snapshot-less running Attempt 只能观察；未启动旧 Attempt 不能产生新副作用。
- 凭据只经既有 canonical seam 使用，不进入 envelope、result 或 receipt。
