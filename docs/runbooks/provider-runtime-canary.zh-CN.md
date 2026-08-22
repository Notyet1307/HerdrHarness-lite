# Provider / Runtime A/B Canary

该 runner 在独立 stateDir 中生成固定 disposable Git repository、独立 worktree、Attempt ledger、JSON 报告和 Markdown 报告。它直接调用现有模块化 prepareAttempt / driveAttempt、runtime adapter、Reviewer validation 与 Git gate，不调用 HarnessController.tick()，因此不会读取、领取或修改 GitHub ready queue。

## 配置

复制 canary.config.example.json 到仓库外的私有路径。harnessConfig 是只读的 canary role/runtime 模板；runner 只复用其 Pi argv、Provider profiles 与 timeout，并在内存中覆盖 repo、state、worktree、label、validation 和 Herdr session。它拒绝与模板的 localPath、stateDir 或 worktreeRoot 重叠，也拒绝 herdrSession 与模板 session 相同。

模板必须包含：

- canonical-oauth + openai-codex Reviewer profile；
- 一个用户自行配置的 canonical-model-config custom Provider profile；
- 完整 Worker / Reviewer role argv；
- canary.config 中专用且不同于模板的 herdrSession。

API key、OAuth 内容和 Provider 原始响应不写入 canary 配置或报告。custom Provider 凭据继续留在 canonical private models.json；OAuth 继续留在 canonical auth.json。

## 运行

    npm run build

    node dist/src/canary-cli.js matrix --config /ABSOLUTE/PATH/canary.json

    # 默认只串行，作为主要 A/B 数据。
    node dist/src/canary-cli.js run --config /ABSOLUTE/PATH/canary.json

    # 压力组必须单独显式运行。
    node dist/src/canary-cli.js run --config /ABSOLUTE/PATH/canary.json --group stress

    # 或明确一次运行两组；serial 仍先完成，stress 后执行。
    node dist/src/canary-cli.js run --config /ABSOLUTE/PATH/canary.json --group all

repetitions 控制每个单元的 N。serial 单元逐个 await；stress 单元才使用 stressConcurrency。每个 repetition 都有独立 unit、Job、Attempt、branch、worktree 和 result path。

运行中断后用同一命令与同一配置继续：

- 已有 terminal unit 直接跳过，不重复计数；
- 未完成的 setup reservation 不复用同一 branch/worktree identity；恢复会创建下一 setup generation，旧 workspace 只作为待人工清理的 disposable residue；
- running Attempt 只进入 observation，不重发 prompt；
- 只有尚未 dispatch 的 agent_ready Attempt 才能首次 dispatch；
- config 或 matrix digest 漂移会 fail closed。

## 固定矩阵与边界

实测单元包含：

- Worker：短修改、中型多文件修改、长工具调用；interactive / RPC；RPC long task 的 disabled / controlled-threshold；
- Reviewer：exact-HEAD、长 validation、大输出 validation；interactive / RPC；
- Reviewer Provider：OAuth 与 custom Provider 的 matched exact-HEAD cells；
- custom Reviewer：axisConcurrency 1 / 2；
- 独立 stress group。

两个格子只报告 unsupported，不会通过放宽约束补齐：

- Worker custom Provider 当前不在 Worker identity contract 内；
- openai-codex + canonical OAuth Reviewer 的 axisConcurrency=2 被安全 policy 固定拒绝。

Provider network 与 continuation-lost 是 P2-1 taxonomy 的确定性 simulation 单元，只验证分类与报告链路，不进入真实 Provider 失败率、增量或推荐。真实短/中/长和 Reviewer 单元才标记为 measured。

## 报告和诊断

每次运行原子刷新：

- STATE_DIR/report.json
- STATE_DIR/report.md

报告将假设、simulation、unsupported 与实测数据分开；主要比较只使用 serial measured units。单组比例使用 Wilson 95% 区间，比例差使用 Newcombe score 95% 区间。它报告增量失败，不自动宣布 Provider 优胜。

现有 diagnose CLI 可直接读取：

    node dist/src/cli.js diagnose --canary /ABSOLUTE/PATH/report.json
    node dist/src/cli.js diagnose --canary /ABSOLUTE/PATH/report.json --json

默认隐藏逐 unit 行；--json 才输出安全字段明细。Canary 是本地运行证据，不是交付：runner 验证 durable result、exact HEAD、clean worktree 与本地 Git fixed point，但不会创建 PR、等待 CI 或声称 GitHub merge fixed point。
