# HerdrHarness Lite

这是针对 `Notyet1307/HerdrHarness` 的精简参考实现。目标不是把现有功能全部搬过来，而是先固定一个可验证的核心闭环：

```text
GitHub ready issue
  -> durable claim intent
  -> GitHub claim + task-bound Codex Analyst
  -> Herdr worktree
  -> fresh Pi worker
  -> fresh read-only Pi reviewer
  -> PR
  -> observe merge
```

出现阻塞时：

```text
BLOCKED
  -> bounded evidence pack
  -> Codex Analyst may request whitelisted read-only evidence
  -> Analyst advice
  -> exact human approval gate
  -> close old pane
  -> fresh Pi worker with bounded resolution brief
```

## 验证状态

执行：

```bash
npm ci
npm run verify
```

仓库固定使用 TypeScript 5.8.3；严格类型检查通过，35 项测试通过。测试覆盖：

- `ready-for-agent`、OPEN、assignee、OPEN blocker 的领取条件；
- Map 容器不领取、严格首个 OPEN 子任务前沿；
- GitHub claim intent 的崩溃恢复；
- worker、独立 reviewer、review rework、PR/merge 完整链路；
- block 后 Analyst 补充证据；
- 过期审批拒绝；
- integrity block 禁止被模型转换为 retry；
- 审批后关闭旧 pane，并强制创建新的 worker attempt；
- attempt 在 `prepared -> pane_ready -> agent_ready -> running` 各阶段先持久化再推进；prompt 结果不确定时不重放；
- 成功 attempt 在结果与 Git 验证后关闭自有 pane，关闭后崩溃可凭 durable result 收敛；
- Herdr 适配器使用原生 `worktree / tab / agent` 命令，并在 blocked/wait 失败时使用官方 `agent get/read` 诊断，不再通过 `pane split + pane run` 模拟 agent 启动。
- Codex Analyst wrapper 的 start/turn effect receipt、崩溃后禁止重复 dispatch、完成结果重放、证据漂移拒绝、精确 UUID close，以及 close 失败时保留终态 Job。

默认测试使用 fake GitHub/Git/Herdr/Analyst。本次另在 `Notyet1307/harness-sandbox@fd9defa` 上使用 Herdr 0.8.0、Pi 0.83.0 与 Pi integration v8 完成了独立命名 session canary：Pi 写出预期 result、tracked tree 未改，自有 attempt pane 已关闭；又从 `harness-sandbox@2b9ebce` 验证了 Codex CLI 0.145.0 的真实 `exec -> resume -> delete` 生命周期、完成 turn 的 receipt 重放、同 digest payload 漂移拒绝和目标 tracked tree 零改动。Analyst 实际运行目录是私有 state dir，不接触目标仓库。这仍不代表 GitHub issue 到 PR/merge 的完整端到端已经跑通。worktree 自动删除不在本次实现范围内。

## 最小命令面

```bash
npm run build
node dist/src/cli.js status --config /absolute/harness.config.json
node dist/src/cli.js tick --config /absolute/harness.config.json
node dist/src/cli.js run --config /absolute/harness.config.json --poll-ms 15000
node dist/src/cli.js approve \
  --config /absolute/harness.config.json \
  --revision 12 \
  --incident incident-id \
  --analysis analysis-id \
  --actor yet \
  --reason "已核对证据，批准受限重试"
```

配置样例见 `harness.config.example.json`。

## 代码边界

```text
src/
├── model.ts                    # 领域对象与不变量
├── eligibility.ts              # 纯 Map/block/ready 选择逻辑
├── controller.ts               # 单写状态机，每次 tick 至多一次持久迁移
├── policy.ts                   # block 分类、允许恢复动作、结果验真
├── recovery.ts                 # 人工审批 gate；不直接操作旧 agent
├── prompts.ts                  # worker/reviewer 的固定契约
├── ports.ts                    # GitHub/Git/Herdr/Analyst/Store 端口
├── cli.ts                      # tick/run/status/approve
└── adapters/
    ├── github-gh.ts            # gh CLI
    ├── git-cli.ts              # Git 固定点验真
    ├── herdr-cli.ts            # Herdr 原生轻量适配器
    ├── json-command-analyst.ts # Codex wrapper 协议适配器
    ├── local-evidence.ts       # 只读、白名单、限长证据采集
    └── json-store.ts           # 单机 CAS snapshot + JSONL 事件
```

核心只依赖 `ports.ts`，因此现有 SQLite ledger、Codex Analyst 代码、FCM 推送都可以作为适配器接入，而不是进入状态机。

## Codex Analyst wrapper 协议

仓库内置 `codex-analyst-wrapper`，但 Controller 仍只依赖 JSON command seam。源码构建产物是 JavaScript，因此配置样例以 Node 作为 `analyst.command`，并在 `analyst.argv` 中传入 wrapper 路径和 `--state-dir`；Harness 通过 stdin 发送 JSON，并从 stdout 接收单个 JSON。

wrapper 使用 Codex CLI 的持久 session：首次调用 `codex exec`，后续调用 `codex exec resume <UUID>`，终态调用 `codex delete --force <UUID>`。start 与 turn 都先在 `analyst-effects/` 写入并 fsync 私有 effect receipt，再调用 Codex；receipt 同时绑定完整请求摘要，重复请求返回已记录结果，payload 漂移或未决请求 fail closed，绝不自动创建替代 session。这些 receipt 只负责外部副作用幂等，不是 Job workflow truth。

start 和 resume 都使用同一 restricted profile：strict config、忽略用户 config/rules、read-only sandbox、关闭 web search 与 shell tool。Codex 没有 controller、GitHub、Git、Herdr 或恢复权限；所有 task/evidence 都按不可信数据处理。

启动请求：

```json
{
  "operation": "start",
  "jobId": "job-id",
  "task": { "...": "完整任务快照" }
}
```

响应：

```json
{
  "sessionId": "durable-session-id",
  "agentName": "codex-analyst-job-id",
  "startedAt": "2026-08-03T00:00:00.000Z"
}
```

诊断轮次可返回证据请求：

```json
{
  "kind": "need_evidence",
  "requests": [
    { "kind": "git_diff", "path": null, "reason": "确认改动边界" }
  ]
}
```

或最终建议：

```json
{
  "kind": "advice",
  "action": "retry_fresh_worker",
  "summary": "原因说明",
  "resolutionBrief": "只供下一条 fresh worker 参考的有限解决说明",
  "evidenceRefs": ["task", "git-diff-stat"],
  "unknowns": []
}
```

Analyst 不会获得 controller write、任意 shell recovery 或直接向旧 worker 发消息的能力。

关闭请求由 Controller 在归档前发送：

```json
{
  "operation": "close",
  "jobId": "job-id",
  "taskDigest": "sha256",
  "session": { "id": "real-codex-session-uuid", "taskDigest": "sha256" }
}
```

只允许删除 wrapper 为该 Job 和 task digest 记录的精确 UUID；删除失败时终态 Job 保留，不会静默归档。

## 生产迁移建议

不要直接删除现有 SQLite ledger。更稳妥的方式是实现一个 `StateStore` 适配器复用它，再逐步让现有 `picker.ts`、`runtime.ts`、`codex-analyst.ts` 接到新端口。参考实现使用 JSON snapshot + JSONL，仅为降低代码与依赖数量，并验证状态机边界。

完整分析、状态机、Map 与 block 规则见 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md)。
