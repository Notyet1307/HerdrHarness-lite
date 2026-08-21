# Repository instructions

## 阅读顺序

AI 开始工作时按顺序读取：

1. 本文件；
2. 与任务直接相关的 `src/`；
3. 对应 `test/`；
4. `harness.config.example.json`、`fleet.config.example.json` 与相关配置解析；
5. `ARCHITECTURE.zh-CN.md` 和相关 ADR；
6. README 与 runbook。

GitHub Issues / PR 保存未来工作与交付讨论。仓库文档只保存当前事实和长期有效的 decision。

## 权威顺序

冲突时使用：

1. 当前 `src/` TypeScript；
2. 当前行为测试；
3. 配置解析与 runtime validation；
4. 当前 integration；
5. 架构文档与 accepted ADR；
6. README。

不要从已删除计划、旧摘要、历史测试数量或 runtime liveness 推断当前完成状态。

## Controller 修改前必读

修改状态机、ledger 或 transition 前必须读：

- `src/model.ts`
- `src/controller.ts`
- `src/controller/context.ts`
- 对应 `src/controller/` flow module
- `src/policy.ts`
- `src/recovery.ts`
- `src/adapters/json-store.ts`
- 对应 controller/recovery tests

不要把新逻辑重新堆回 `src/controller.ts`。该文件只负责公开 facade 与 `JobState` dispatch；流程应进入按变化原因划分的 module。

修改 Pi role、prompt、context 或 result contract 前必须读：

- `src/attempt-plan.ts`
- `src/attempt-context.ts`
- `src/prompts.ts`
- `src/compatibility.ts`
- `src/controller/attempt-preparation.ts`
- `src/controller/runtime-preflight.ts`
- `pi/skills/`、`pi/agents/`、`pi/extensions/`
- `test/pi-role-kit.test.ts` 与相关 runtime/tool tests

修改 blocked recovery、CI rework 或 Analyst 前必须读：

- `src/controller/recovery-flow.ts`
- `src/controller/delivery.ts`
- `src/handoff.ts`
- `src/policy.ts`
- `src/recovery.ts`
- `src/adapters/local-evidence.ts`
- block/rework/CI tests

## Fleet 修改前必读

修改多项目运行前必须读：

- `src/fleet/types.ts`
- `src/fleet/config.ts`
- `src/fleet/isolation.ts`
- `src/fleet/supervisor.ts`
- `src/fleet/restart-policy.ts`
- `docs/adr/0004-modular-controller-and-project-fleet.md`
- Fleet tests

Fleet 只拥有项目进程生命周期，不得：

- 直接修改项目 `state.json`；
- claim Issue、创建 Attempt、批准 recovery、push 或 merge；
- 为已有存活 Controller 启动第二写者；
- 将一个项目的退出传播为其他项目的取消；
- 放宽 repo、source、state、worktree 或 Herdr session 隔离。

## 安全边界

- Controller 保持单写；每次 tick 最多一次 durable transition。
- strict Map frontier 不得跳过首个 OPEN child。
- Worker/Reviewer 每次 retry 使用 fresh Attempt。
- durable result 与 Git fixed point 才能支持完成。
- Reviewer 保持 fresh、read-only、exact-HEAD、双轴与固定验证。
- Analyst 只有建议权；policy 或精确 human gate 才能授权恢复。
- Objective、handoff、evidence 和 candidate rules 是 untrusted data。
- blocked Agent 不复用旧 transcript 继续执行。
- Pi RPC auto-retry 保持关闭；受控 Worker compaction 只能遵守 snapshot policy。
- 凭据不进入 result、receipt、ledger、文档或新磁盘副本。
- 不人工编辑生产 `state.json` 或 `fleet-state.json`，不无迁移删除 ledger 字段。
- 已原子提交的权威状态不得因后续 audit append 失败而被报告成未提交。
- 长运行循环必须响应进程终止信号，并通过正常清理路径释放 heartbeat 与 lease。

## 仓库治理

- 不编辑或提交 `dist/`；`npm run build` 会重建它。
- 不新增 `docs/plans`、`docs/research`、`docs/archive`。
- 调研事实只保留最终取舍，不保存长过程日志。
- 未来计划进入 GitHub Issues / PR，不进入当前架构文档。
- 架构事实放 `ARCHITECTURE.zh-CN.md` 或明确 ADR。
- 单项目运维事实放 `docs/runbooks/operator.zh-CN.md`。
- Fleet 运维事实放 `docs/fleet.zh-CN.md`。
- Telegram 事实放 integration README 或 cutover runbook。
- 长期 decision 放 `docs/adr/`，不要保存实施过程。
- 不写固定测试数量、易漂移版本清单、完成任务列表或 roadmap。
- 不删除生产兼容路径，除非有调用盘点、迁移、验证和回滚证据。

## 改动与验收

- 只做授权范围，复用现有实现，不顺手重构或升级无关依赖。
- 检查所有调用方，修共享根因，不放宽 fail-closed guard。
- 保留用户已有改动；只 stage 本任务文件。
- Controller 机械拆分后运行 `node scripts/verify-controller-refactor.mjs`。
- 每次修改必须运行 `npm run verify`。
- 交付前运行 `git diff --check`，确认 `git ls-files dist` 无输出。
- Fleet 至少验证：重复边界拒绝、并发上限、兄弟项目失败隔离、退避、稳定重置、熔断、adopted 不双写、graceful shutdown。
- 未运行的验证不得写成通过；local、runtime、CI、merge 与部署必须分别报告。
