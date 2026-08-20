# ADR 0003：受控 Worker 压缩与固定任务锚点

- 状态：Accepted
- 范围：Pi RPC Worker；Reviewer 不适用

## 背景

长 Worker 会积累工具结果与探索过程。完全关闭压缩会让后续 provider request 接近 context window；直接调用 Pi RPC `compact` 又会先 abort 当前 agent，形成同一 Attempt 内的隐式重试，违反 fresh-retry 边界。普通 compaction summary 还是有损数据，不能成为 Objective、AC、TypedHandoff 或 Git target 的唯一副本。

## 决策

1. Pi auto-retry 与 Pi-owned auto-compaction 继续关闭；Reviewer compaction 继续关闭。
2. Worker `ExecutionSnapshot` 固定 `controlled-threshold`：75% 触发、最多一次、保留最近 20,000 token、overflow continuation=false。
3. Harness 使用 Pi 0.84.2 的 public next-turn hook 与 exact-version `core/compaction` module seam，只在一个连续 agent run 的工具轮次之间压缩；该模块 surface 在 SDK host 启动时 fail closed 验证，不 abort、不重放 prompt、不创建第二个 `agent_start`。
4. Trusted repository/role constraints 留在 system prompt。Objective、AC、TypedHandoff、target 和 writeback contract 渲染为 digest 绑定的 untrusted pinned task-data，并在每次模型请求前 request-locally 原样注入。
5. Pinned block 不写入 session history，compaction summary 只描述探索过程。压缩后动态 worktree、测试和 Git 事实必须重读。
6. Compaction receipt 只保留 count、threshold、触发时 context tokens/window、tokens-before、estimated-tokens-after 与 summary digest；summary 内容、Provider 原文和凭据不落盘。
7. Worker 文本工具结果在模型上下文入口处限制为 24 KiB，超限保留头尾与 digest；模型应通过窄范围读取重新取得事实。

## 结果

- 压缩只能丢失可重建的探索细节，不能丢失权限边界、任务目标、AC、Git target 或交付 gate。
- 同一 Attempt 仍只有一次 dispatch 和一次连续 agent run；任何真正 retry 仍创建 fresh Attempt。
- 控制策略、Pi/runtime resource、pinned data 与 receipt 都进入现有 immutable plan / digest 链；漂移继续 fail closed。
