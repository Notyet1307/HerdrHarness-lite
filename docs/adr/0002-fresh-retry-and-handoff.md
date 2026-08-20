# ADR 0002：Fresh retry 与结构化 handoff

- 状态：Accepted
- 范围：review rework、blocked recovery、CI rework

## 背景

复用 blocked Agent transcript 或自由文本 brief 会把旧上下文、过期证据和未授权指令带入恢复。runtime 内部 retry 与 Controller recovery 同时拥有重放权，还可能重复有副作用的 tool call。

## 决策

1. Worker/Reviewer prompt 每个 Attempt 只 dispatch 一次；结果不确定时只观察，不重放。
2. RPC runner 关闭 Pi auto-retry 与 auto-compaction。Controller 只保留一次 bounded same-Attempt reconciliation。
3. 任何 workflow retry 都创建 fresh Worker 或 Reviewer；旧 pane 在新 Attempt 前关闭。
4. review changes、approved recovery 与 CI rework 统一使用 `TypedHandoff`。
5. Handoff 必须绑定来源 job revision、task/result/evidence/Incident/Analysis/Approval，以及目标 lane、base、expected HEAD 与 expected remote HEAD。
6. Handoff 是 untrusted task data，不能扩大工具、runtime 或 repository policy authority。
7. 窄范围自动恢复由 policy 形成可审计 Approval；其余恢复需要 Analyst advice 与精确 human gate。

## 结果

- recovery authority 只有一个明确 owner，不依赖 runtime 隐式重试。
- 每次重试都有新的角色上下文和 durable identity。
- `pendingBrief` 只作为旧 ledger 的 fail-closed guard；新状态只写结构化 handoff。
- Analyst 建议、人工授权、runtime 观察和实际执行保持分离。
