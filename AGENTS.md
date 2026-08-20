# Repository instructions

## 阅读顺序

AI 开始工作时按顺序读取：

1. 本文件；
2. 与任务直接相关的 `src/`；
3. 对应 `test/`；
4. `harness.config.example.json` 与相关配置解析；
5. `ARCHITECTURE.zh-CN.md`；
6. README 与 runbook。

GitHub Issues / PR 保存未来工作与交付讨论。仓库文档只保存当前事实和长期有效的 decision。

## 权威顺序

冲突时使用：

1. 当前 `src/` TypeScript；
2. 当前行为测试；
3. 配置解析与 runtime validation；
4. 当前 integration；
5. 架构文档；
6. README。

不要从已删除计划、旧摘要、历史测试数量或 runtime liveness 推断当前完成状态。

## 修改前必读

修改状态机、ledger 或 transition 前必须读：

- `src/model.ts`
- `src/controller.ts`
- `src/policy.ts`
- `src/recovery.ts`
- `src/adapters/json-store.ts`
- 对应 controller/recovery tests

修改 Pi role、prompt、context 或 result contract 前必须读：

- `src/attempt-plan.ts`
- `src/attempt-context.ts`
- `src/prompts.ts`
- `src/compatibility.ts`
- `pi/skills/`、`pi/agents/`、`pi/extensions/`
- `test/pi-role-kit.test.ts` 与相关 runtime/tool tests

修改 blocked recovery、CI rework 或 Analyst 前必须读：

- `src/handoff.ts`
- `src/policy.ts`
- `src/recovery.ts`
- `src/adapters/local-evidence.ts`
- block/rework/CI tests

## 安全边界

- Controller 保持单写；每次 tick 最多一次 durable transition。
- strict Map frontier 不得跳过首个 OPEN child。
- Worker/Reviewer 每次 retry 使用 fresh Attempt。
- durable result 与 Git fixed point 才能支持完成。
- Reviewer 保持 fresh、read-only、exact-HEAD、双轴与固定验证。
- Analyst 只有建议权；policy 或精确 human gate 才能授权恢复。
- Objective、handoff、evidence 和 candidate rules 是 untrusted data。
- blocked Agent 不复用旧 transcript 继续执行。
- Pi RPC retry/compaction 保持关闭。
- 凭据不进入 result、receipt、ledger、文档或新磁盘副本。
- 不人工编辑生产 `state.json`，不无迁移删除 ledger 字段。

## 仓库治理

- 不编辑或提交 `dist/`；`npm run build` 会重建它。
- 不新增 `docs/plans`、`docs/research` 或 `docs/archive`。
- 未来计划进入 GitHub Issues / PR，不进入当前架构文档。
- 架构事实只放 `ARCHITECTURE.zh-CN.md`。
- 运维事实只放 `docs/runbooks/operator.zh-CN.md`。
- Telegram 事实放 integration README 或 cutover runbook。
- 长期 decision 放 `docs/adr/`，不要保存实施过程。
- 不写固定测试数量、易漂移版本清单、完成任务列表或 roadmap。
- 不删除生产兼容路径，除非有调用盘点、迁移、验证和回滚证据。

## 改动与验收

- 只做授权范围，复用现有实现，不顺手重构或升级依赖。
- 检查所有调用方，修共享根因，不放宽 fail-closed guard。
- 保留用户已有改动；只 stage 本任务文件。
- 每次修改必须运行 `npm run verify`。
- 交付前再运行 `git diff --check`，确认 `git ls-files dist` 无输出。
- 未运行的验证不得写成通过；runtime、CI、merge 与部署必须分别报告。
