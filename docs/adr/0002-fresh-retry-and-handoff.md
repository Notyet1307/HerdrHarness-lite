# ADR 0002：Fresh retry 与结构化 handoff

- 状态：Accepted
- 范围：review rework、blocked recovery、CI rework

## 背景

复用 blocked Agent transcript 或自由文本 brief 会把旧上下文、过期证据和未授权指令带入恢复。runtime 内部 retry 与 Controller recovery 同时拥有重放权，还可能重复有副作用的 tool call。

## 决策

1. Worker/Reviewer prompt 每个 Attempt 只 dispatch 一次；结果不确定时只观察，不重放。
2. RPC runner 关闭 Pi auto-retry 与 Pi-owned auto-compaction。Worker 仅允许 ADR 0003 定义的同一连续运行内受控压缩；它不是 prompt replay 或 workflow retry。Controller 只保留一次 bounded same-Attempt reconciliation。
3. 任何 workflow retry 都创建 fresh Worker 或 Reviewer；旧 pane 在新 Attempt 前关闭。
4. review changes、approved recovery 与 CI rework 统一使用 `TypedHandoff`。
5. Handoff 必须绑定来源 job revision、task/result/evidence/Incident/Analysis/Approval，以及目标 lane、base、expected HEAD 与 expected remote HEAD。
6. Handoff 是 untrusted task data，不能扩大工具、runtime 或 repository policy authority。
7. 窄范围自动恢复由 policy 形成可审计 Approval；dispatch 后只允许明确 transient Provider failure 在完整 pre-side-effect receipt、固定短退避、fresh Attempt 和 job/lane/HEAD 一次上限内恢复。Analyst 只有建议权，不能创建 candidate、Approval 或执行恢复；其余恢复需要精确 human gate。
8. Reviewer 的 preflight、Standards、Spec、Controller validation 和 final aggregation 可写 Harness-owned、Attempt-private、原子不可覆盖的结构化 checkpoint；它们不是最终 Reviewer result。
9. checkpoint 绑定 source Attempt/job revision、task/base/exact HEAD、runtime/provider/model/resource/context digests、stage、createdAt、结构化 result 与 result digest。
10. same-HEAD Reviewer retry 仍关闭旧 pane并创建 fresh Attempt；新 Attempt 只导入全部身份匹配且未被另一 Attempt 消费的 checkpoint，不恢复旧 session 或 transcript。
11. 无效、漂移、可写、格式错误或已消费 checkpoint 不授权完成、工具或恢复；对应阶段重跑或 fail closed。
12. `review_submit` 仍是唯一最终 Reviewer 结论；即使存在 `reviewer-final.json`，fresh Attempt 也必须完成该调用及既有 Git/result gates。

## 结果

- recovery authority 只有一个明确 owner，不依赖 runtime 隐式重试。
- 每次重试都有新的角色上下文和 durable identity。
- `pendingBrief` 只作为旧 ledger 的 fail-closed guard；新状态只写结构化 handoff。
- Analyst 建议、人工授权、runtime 观察和实际执行保持分离。
- 已完成 Reviewer 确定性阶段不必因后续 Provider continuation 失败而全部重跑，同时每个 checkpoint 的消费仍有 durable Attempt 记录和一次性上限。
