# ADR 0003：受控 Worker 压缩与固定任务锚点

- 状态：Accepted
- 范围：Pi RPC Worker；Reviewer 不适用

## 背景

长 Worker 会积累工具结果与探索过程。完全关闭压缩会让后续 provider request 接近 context window；直接调用 Pi RPC `compact` 又会先 abort 当前 agent，形成同一 Attempt 内的隐式重试，违反 fresh-retry 边界。普通 compaction summary 还是有损数据，不能成为 Objective、AC、TypedHandoff 或 Git target 的唯一副本。

## 决策

1. Pi auto-retry 与 Pi-owned auto-compaction 继续关闭；Reviewer compaction 继续关闭。
2. `workerCompaction.mode` 只接受 `disabled | controlled-threshold`；缺省和省略该字段的旧配置均解析为 `disabled`，不会因迁移或选择 RPC Worker 自动开启实验能力。`controlled-threshold` 仍固定为 75% 触发、最多一次、保留最近 20,000 token、overflow continuation=false。
3. Controlled 模式使用 Pi 0.84.2 的 public next-turn hook；公开 root API 没有 `prepareCompaction`，因此唯一 private `core/compaction` seam 隔离在 `pi-rpc-compaction-compat`，并以 exact version 与 surface contract fail closed。它只在一个连续 agent run 的工具轮次之间压缩，不 abort、不重放 prompt、不创建第二个 `agent_start`。
4. Trusted repository/role constraints 留在 system prompt。Objective、AC、TypedHandoff、target 和 writeback contract 渲染为 digest 绑定的 untrusted pinned task-data，并在每次模型请求前 request-locally 原样注入。
5. Pinned block 不写入 session history，compaction summary 只描述探索过程。压缩后动态 worktree、测试和 Git 事实必须重读。
6. Summary Provider 请求独立于 Agent prompt。Pi 内建 retry 保持关闭；只有 network、rate-limit 或 timeout 可由 Harness 再请求一次 summary，其他 Provider、protocol、context 与 internal API drift 立即失败。该 retry 不调用 Agent prompt，也不产生第二个 `agent_start`。
7. Compaction receipt 只保留 trigger reason、count、threshold、触发时 context tokens/window、payload byte estimate、summary attempt count/duration、是否使用 retry、前后 token estimate、summary digest 和稳定 failure domain/code；summary 内容、Provider 原文和凭据不落盘。
8. Worker 文本工具结果在模型上下文入口处限制为 24 KiB，超限保留头尾与 digest；模型应通过窄范围读取重新取得事实。

## 结果

- 压缩只能丢失可重建的探索细节，不能丢失权限边界、任务目标、AC、Git target 或交付 gate。
- 同一 Attempt 仍只有一次 dispatch 和一次连续 agent run；任何真正 retry 仍创建 fresh Attempt。
- 控制策略、Pi/runtime resource、pinned data 与 receipt 都进入现有 immutable plan / digest 链；漂移继续 fail closed。
- Controlled 失败稳定区分 `compaction_provider_transient`、`compaction_provider_permanent`、`compaction_protocol`、`compaction_context_invalid` 与 `compaction_internal_api_drift`；这些诊断不授权 workflow retry。
