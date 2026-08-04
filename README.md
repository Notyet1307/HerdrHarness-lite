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
npm run verify
```

在提供 TypeScript 5.8.3 编译器的环境中，严格类型检查通过，14 项测试通过。测试覆盖：

- `ready-for-agent`、OPEN、assignee、OPEN blocker 的领取条件；
- Map 容器不领取、严格首个 OPEN 子任务前沿；
- GitHub claim intent 的崩溃恢复；
- worker、独立 reviewer、review rework、PR/merge 完整链路；
- block 后 Analyst 补充证据；
- 过期审批拒绝；
- integrity block 禁止被模型转换为 retry；
- 审批后关闭旧 pane，并强制创建新的 worker attempt；
- Herdr 适配器使用原生 `worktree / tab / agent` 命令，不再通过 `pane split + pane run` 模拟 agent 启动。

默认测试使用 fake GitHub/Git/Herdr/Analyst。本次另使用 Herdr 0.8.0 的独立命名 session 完成了 disposable adapter canary；这仍不代表 GitHub issue 到 PR/merge 的完整端到端已经跑通。仓库尚未声明 TypeScript 编译器依赖，因此裸执行 `npm run verify` 的可复现性需要单独修复。

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

参考实现没有硬编码某一版 Codex CLI 的持久 session 参数。`analyst.command` 指向一个 wrapper；Harness 通过 stdin 发送 JSON，并从 stdout 接收单个 JSON。

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

## 生产迁移建议

不要直接删除现有 SQLite ledger。更稳妥的方式是实现一个 `StateStore` 适配器复用它，再逐步让现有 `picker.ts`、`runtime.ts`、`codex-analyst.ts` 接到新端口。参考实现使用 JSON snapshot + JSONL，仅为降低代码与依赖数量，并验证状态机边界。

完整分析、状态机、Map 与 block 规则见 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md)。
