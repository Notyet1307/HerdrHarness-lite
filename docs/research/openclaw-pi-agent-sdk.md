# OpenClaw 使用 Pi Agent SDK 的方式及对 HerdrHarness-lite 的启示

> 核验日期：2026-08-09。本文只使用 OpenClaw 与 Pi 官方仓库的一手源码；HerdrHarness-lite 对照基线为本地 `c584e0ef3f40198b57287d2ae44a022c14198fe0`。

## 结论

1. **当前 OpenClaw 已不再使用外部 Pi Agent SDK。** `2026.5.22` 起，原 Pi runtime 被内部化为 OpenClaw 自有 runtime；当前仅保留 `@earendil-works/pi-tui`。研究外部 SDK 集成必须看内部化前的官方快照，不能拿当前 `main` 误判。
2. 内部化前，OpenClaw 不是调用 Pi CLI，而是在同一进程直接创建 `AgentSession`：OpenClaw 负责 provider/model、上下文、工具、权限、sandbox、timeout 和结果语义；Pi 负责 agent loop、provider streaming、事件、session tree 和 compaction。
3. Pi 本身明确**不提供** analyst/worker/reviewer 角色协议、subagent 编排、审批 gate 或 sandbox。OpenClaw 的 subagent 与权限控制都是应用层实现。
4. HerdrHarness-lite 不应照搬 OpenClaw 的 in-process runtime。它更应借鉴“显式运行计划、禁止 ambient discovery、事件只作观察、子任务完成不等于验收”这些边界；继续以 ledger、不可变 result、Git fixed point 和人工 gate 作为 workflow truth。

## 版本与事实边界

| 对象 | 精确版本 / SHA | 核验结论 |
| --- | --- | --- |
| OpenClaw 当前 `main` | [`7d4066639ef008c122c8243ce08d834227a494f3`](https://github.com/openclaw/openclaw/commit/7d4066639ef008c122c8243ce08d834227a494f3)，package `2026.8.1` | 自有 runtime；仓库仍在快速移动 |
| OpenClaw 外部 Pi 集成快照 | [`v2026.5.21-beta.1` / `f5b286f8`](https://github.com/openclaw/openclaw/tree/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d) | Pi packages `0.75.4` |
| 对应 Pi SDK | [`v0.75.4` / `3533843d`](https://github.com/earendil-works/pi/tree/3533843dd781dcd233f51854fc883ec246a6a919) | 与 OpenClaw manifest 精确匹配 |
| Pi 当前 `main` | [`936aff00918de1187f085f123c2812d8f2d67745`](https://github.com/earendil-works/pi/commit/936aff00918de1187f085f123c2812d8f2d67745)，packages `0.84.1` | 仍无内建 subagent/sandbox |

当前边界有三项直接证据（为避免 `main` 漂移，源码行链接固定到核验快照 `00854a7`）：OpenClaw 官方架构文档声明外部 agent framework packages 已移除，仅留 Pi TUI（[`agent-runtime-architecture.md`](https://github.com/openclaw/openclaw/blob/00854a7002a77f47bd56c43b69c2e5ba7b09e8a6/docs/agent-runtime-architecture.md#L6-L25)）；`pi` 只保留为 legacy alias（[同文件](https://github.com/openclaw/openclaw/blob/00854a7002a77f47bd56c43b69c2e5ba7b09e8a6/docs/agent-runtime-architecture.md#L44-L50)）；当前 manifest 只有 `pi-tui: 0.82.1`（[`package.json`](https://github.com/openclaw/openclaw/blob/00854a7002a77f47bd56c43b69c2e5ba7b09e8a6/package.json#L1999-L2015）。

内部化前 manifest 将四个 Pi 包精确锁为 `0.75.4`（[`package.json`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/package.json#L1785-L1792)）。同期 `docs/pi.md` 仍写 `0.75.1`，是落后文档（[`docs/pi.md`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/docs/pi.md#L24-L30)）；真实依赖以 manifest 与对应 tag 为准。

## 历史真实 SDK 数据流

```text
runEmbeddedPiAgent
  -> resolve provider / model / authStorage / modelRegistry
  -> select harness (builtin pi or explicit plugin)
  -> runEmbeddedAttempt
       -> resolve workspace / sandbox / skills / bootstrap
       -> create controlled OpenClaw tools + ResourceLoader
       -> SessionManager.open(sessionFile)
       -> createAgentSession(...)
            -> Pi Agent + streamSimple(provider)
       -> session.prompt(...)
       -> subscribe message/tool/agent/compaction events
       -> persist JSONL session entries
       -> return messages/usage/errors/compaction metadata
  -> build reply payload and delivery metadata
```

入口、模型选择与 attempt 参数传递见 [`run.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/pi-embedded-runner/run.ts#L406-L445) 和 [`run.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/pi-embedded-runner/run.ts#L1349-L1531)。harness 显式选择失败时不会静默换 runtime（[`selection.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/harness/selection.ts#L121-L249)）。

`runEmbeddedAttempt` 打开 Pi `SessionManager` 并传给 `createAgentSession`（[`attempt.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/pi-embedded-runner/run/attempt.ts#L2127-L2156)、[`attempt.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/pi-embedded-runner/run/attempt.ts#L2380-L2424)）。Pi SDK 随后恢复 model/thinking/messages、创建底层 `Agent` 并返回 `AgentSession`（[`sdk.ts`](https://github.com/earendil-works/pi/blob/3533843dd781dcd233f51854fc883ec246a6a919/packages/coding-agent/src/core/sdk.ts#L193-L268)、[`sdk.ts`](https://github.com/earendil-works/pi/blob/3533843dd781dcd233f51854fc883ec246a6a919/packages/coding-agent/src/core/sdk.ts#L320-L405)）。

## Context 与 tools

OpenClaw 的上下文来源包括：用户 prompt、session history、workspace bootstrap/context files、skills snapshot、provider/model/runtime 信息、channel/heartbeat、sandbox 状态、工具说明以及 per-run override。聚合逻辑见 [`attempt.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/pi-embedded-runner/run/attempt.ts#L1501-L1600) 和 [`attempt.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/pi-embedded-runner/run/attempt.ts#L1909-L2055)。恢复的历史会先 sanitize、validate、truncate，再放入 Agent state（[`attempt.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/pi-embedded-runner/run/attempt.ts#L2965-L3147)）。

OpenClaw 基于 Pi `DefaultResourceLoader`，但关闭 `extensions/skills/prompts/themes/contextFiles` 的 ambient discovery，只允许自己控制的 factory（[`resource-loader.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/pi-embedded-runner/resource-loader.ts#L1-L22)）。工具由 OpenClaw 根据 workspace、sandbox、session、provider/model 和 abort signal 创建并再过 policy filter（[`attempt.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/pi-embedded-runner/run/attempt.ts#L1405-L1491)）。

这说明 Pi 提供的是 agent/tool/extension 机制，不是权限策略。宿主必须决定“加载什么、能看什么、能做什么”。

## Session、compaction、events、retry 与 abort

外部 SDK 时期，Pi `SessionManager` 使用 append-only JSONL tree；message/model/thinking/compaction 都是 entry，可从 active branch 重建 context（[`session-manager.ts`](https://github.com/earendil-works/pi/blob/3533843dd781dcd233f51854fc883ec246a6a919/packages/coding-agent/src/core/session-manager.ts#L695-L788)、[`session-manager.ts`](https://github.com/earendil-works/pi/blob/3533843dd781dcd233f51854fc883ec246a6a919/packages/coding-agent/src/core/session-manager.ts#L865-L930)）。当前 OpenClaw 已改为自有 SQLite store（[`sessions/sdk.ts`](https://github.com/openclaw/openclaw/blob/00854a7002a77f47bd56c43b69c2e5ba7b09e8a6/src/agents/sessions/sdk.ts#L583-L605)）。两者都是对话 runtime state，不等于交付 ledger。

Pi 支持手工与自动 compaction：生成 summary entry、重建 agent messages，并在 context overflow 后重试（[`agent-session.ts`](https://github.com/earendil-works/pi/blob/3533843dd781dcd233f51854fc883ec246a6a919/packages/coding-agent/src/core/agent-session.ts#L1605-L1738)、[`agent-session.ts`](https://github.com/earendil-works/pi/blob/3533843dd781dcd233f51854fc883ec246a6a919/packages/coding-agent/src/core/agent-session.ts#L1847-L2025)）。OpenClaw 对 compaction retry 再加 60 秒上限（[`attempt.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/pi-embedded-runner/run/attempt.ts#L4232-L4296)）。这类 retry 只属于一次模型运行，不能直接视作 workflow retry。

更关键的是 retry 所有权。OpenClaw 最终显式调用 `settingsManager.setRetryEnabled(false)`，因为 OpenClaw 外层已有 failover/retry；两层同时开启曾造成失败 tool call 被重复执行（[`pi-project-settings.ts`](https://github.com/openclaw/openclaw/blob/v2026.5.20/src/agents/pi-project-settings.ts#L44-L65)）。本机实际 Pi `0.84.0` 在未配置时仍默认 `retry.enabled=true`、最多 3 次、基础延迟 2 秒，而 CLI 没有单次运行的 `--no-retry` 参数。因此，Harness 的“外层 prompt 只 dispatch 一次”尚不能证明内部没有 replay。

OpenClaw 订阅并归一化 `message_start/update/end`、`tool_execution_start/update/end`、`agent_start/end`、`compaction_start/end`（[`handlers`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/pi-embedded-subscribe.handlers.ts#L23-L143)）；流式 chunk、thinking 和 tool updates 通过回调送到 channel（[`subscribe`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/pi-embedded-subscribe.ts#L524-L600)）。事件用于展示、持久化和诊断，不单独证明任务完成。

Abort 是分层链路：OpenClaw run/idle/external signal触发 controller，继而停止 compaction、`AgentSession`、底层 Agent 和 provider stream（[`attempt.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/pi-embedded-runner/run/attempt.ts#L3162-L3203)、[`agent-session.ts`](https://github.com/earendil-works/pi/blob/3533843dd781dcd233f51854fc883ec246a6a919/packages/coding-agent/src/core/agent-session.ts#L1384-L1391)）。

## Subagent、角色与结果回写

Pi 官方明确写明“No sub-agents”“No permission popups”，需要宿主通过 extension/tmux 和 container 自己构建（[`Pi 0.75.4 README`](https://github.com/earendil-works/pi/blob/3533843dd781dcd233f51854fc883ec246a6a919/packages/coding-agent/README.md#L470-L480)）；当前安全文档仍声明 Pi 以用户权限运行、没有 built-in sandbox（[`security.md`](https://github.com/earendil-works/pi/blob/936aff00918de1187f085f123c2812d8f2d67745/packages/coding-agent/docs/security.md#L1-L7)、[`security.md`](https://github.com/earendil-works/pi/blob/936aff00918de1187f085f123c2812d8f2d67745/packages/coding-agent/docs/security.md#L27-L53)）。

OpenClaw 用 custom tools 实现 `sessions_spawn/sessions_yield/subagents`（[`openclaw-tools.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/openclaw-tools.ts#L436-L464)）。child 有独立 session key，收到显式 task、child system prompt、agent/model/thinking、workspace 和准备后的 context；源码未显示直接复制 parent 全部 transcript（[`subagent-spawn.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/subagent-spawn.ts#L783-L946)、[`subagent-spawn.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/subagent-spawn.ts#L1142-L1187)）。

child 完成后，OpenClaw 构造 `task_completion` 事件并注入 requester session，由 requester 再审阅或继续处理（[`subagent-announce.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/subagent-announce.ts#L460-L572)）。它不是共享 mutable context，也不是自动验收；官方 completion instruction 还要求 parent review/verify（[`subagent-announce.ts`](https://github.com/openclaw/openclaw/blob/f5b286f8b5cc2c873ea4a112b2ffb13136d7b17d/src/agents/subagent-announce.ts#L88-L93)）。

## 与 HerdrHarness-lite 的逐项差距

> 状态说明：本节记录的是改造前的研究基线。当前分支已经按下文“直接借鉴”完成 ExecutionSnapshot、显式 context closure，以及 Worker 与顶层 Reviewer 的 RPC adapter；实现后的验收边界以 [`attempt-runtime-evolution.md`](../plans/attempt-runtime-evolution.md) 与当前测试为准。

| 维度 | OpenClaw 外部 SDK 时期 | HerdrHarness-lite 当前事实 | 差距判断 |
| --- | --- | --- | --- |
| 集成 | 进程内 `createAgentSession` | Controller → Herdr → Pi CLI | 有意分层；CLI transport 有不确定性，但隔离了 runtime 版本和崩溃域 |
| provider/model | 动态 registry/auth/streamFn | 角色 `argv` 固定并做 live preflight | Harness 更窄、更可审计 |
| context | 关闭 ambient discovery，再显式聚合 history、bootstrap、skills、channel 等 | 角色 prompt/skill 显式，但实际 Worker/Reviewer 未传 `--no-context-files`；Pi 仍会发现 `AGENTS.md`/`CLAUDE.md` | 不共享角色历史是对的，但运行上下文尚未闭包 |
| tools | 运行时创建并过 policy | `--no-skills --no-extensions` 后显式加载 bundled skill/extension 和精确工具集 | 已采用同类 fail-closed 思路 |
| session | JSONL tree，可 resume/branch/compact | Worker/Reviewer fresh；Analyst 才使用 task-bound Codex resume | 角色隔离优先于对话连续性 |
| workflow truth | session DB + reply/runtime metadata | 单写 ledger + immutable result + Git/GitHub 验证 | Harness 更强，不应退化为会话事实 |
| events | rich streaming event bus | `prompt --wait`、`agent wait/get/read`、result file、Controller JSONL/heartbeat | 缺少细粒度实时观察，但不影响交付真值 |
| retry | 外层拥有 retry，并关闭 Pi 内层 auto-retry | Controller 不盲重发 prompt，但当前 Pi 内层默认 auto-retry 仍开启 | retry 所有权尚未唯一，存在 side-effect replay 风险 |
| abort | AbortSignal 贯穿 session/agent/provider | 没有 controller-owned 的精确 in-flight cancel/idle deadline | 这是当前真实能力缺口 |
| subagent | generic child sessions，由应用层实现 | 仅 Reviewer 内固定 Standards/Spec 双轴 child，fresh context、只读工具 | Harness 更专用，不需要通用树 |
| sandbox | OpenClaw 自己实现；Pi 不提供 | worktree、Reviewer 只读 snapshot、验证副本和工具 ceiling；不是 OS sandbox | 两者都必须由宿主补强恶意代码隔离 |
| 回写 | reply payload / `task_completion` 注入 parent | Harness-owned 原子 result，绑定 job/attempt/lane/SHA，再做 Git 验真 | Harness 边界更适合交付控制器 |

HerdrHarness-lite 的业务角色 context 已由 [`src/prompts.ts`](../../src/prompts.ts) 和 [`README.zh-CN.md`](../../README.zh-CN.md) 明确：Worker 获得 Issue snapshot、task digest、base/branch 和可选 bounded brief；Reviewer 获得固定 base/head、Harness Git evidence 和固定验证命令，不继承 Worker 结论；Analyst 获得 task snapshot、incident 与白名单 evidence pack。Controller 在 prompt 前持久化 `running`，失败后只观察同一 Attempt，不重放 prompt（[`src/controller.ts`](../../src/controller.ts)）。

但“业务 prompt 显式”不等于“LLM 最终 context 显式”。真实 Worker/Reviewer argv 只关闭 skills/extensions discovery，没有关闭 context files、prompt templates、themes，也没有强制 `--no-session`（[`harness.config.example.json`](../../harness.config.example.json)）；参数校验器当前甚至不允许 `--no-context-files`（[`src/controller.ts`](../../src/controller.ts)）。相反，Provider preflight 已经使用 `--no-context-files --no-prompt-templates --no-themes`（[`runtime-preflight.ts`](../../src/adapters/runtime-preflight.ts)）。所以现在是“预检无菌、真实角色运行非无菌”。本机又确实存在 `~/.pi/agent/AGENTS.md`，会进入真实角色上下文。

另一个持久化缺口是：Attempt 只绑定 `promptDigest` 和 Reviewer validation argv；真正启动时仍从当前 config 读取 Worker/Reviewer argv。Pi 可执行文件/版本、provider/model、skill/extension 内容 digest、tool set、允许的 context 文件及 digest 都没有在 `attempt_prepared` 时固定。因此 Controller 重启或配置/文件变化后，同一个 durable Attempt 可能以不同 runtime 执行，`promptDigest` 检测不到。

## 直接借鉴

1. **先闭合 Attempt 执行快照。** 在 `attempt_prepared` 时把实际 role argv、Pi executable/version、provider/model/thinking、skill/extension 内容 digest、tool set、允许的 context 文件及 digest、session mode 和 result channel 一起持久化；重启后只复用该快照，任何不一致都 fail closed。先扩充现有 `Attempt` 记录即可，不新建一套状态机。
2. **关闭 ambient context，再显式注入允许的仓库规则。** 不能粗暴只加 `--no-context-files`，因为目标仓库的 `AGENTS.md` 可能是必要约束。应由 Harness 解析允许的目标仓库层级文件、记录路径与 digest、显式注入 prompt/system context，然后让 Pi 禁止自行发现；至少先记录实际发现清单并排除用户全局 context。
3. **只保留一个语义 retry owner。** Controller 继续拥有 fresh Attempt/rework；Pi role attempt 应关闭 auto-retry。当前 CLI 没有单次关闭开关，这是将来采用 SDK/RPC adapter 的一个真实理由，而不是为了“更现代”而换 runtime。
4. **事件只进入 observer。** 如果 Herdr 能输出稳定的 start/message/tool/end 事件，可归一化进 Controller JSONL/诊断面；状态迁移仍必须等 durable result 与 Git 验证。
5. **继续执行“child completed ≠ accepted”。** Reviewer 双轴 child 的输出只能由顶层 Reviewer 汇总；顶层 Reviewer result 仍需 Harness 检查 HEAD、dirty tree、完整双轴证据。
6. **明确宿主拥有安全边界。** Pi 工具 allowlist 不是 OS sandbox；运行不可信验证时必须由容器、VM 或独立 OS 账户提供隔离。

## 暂不借鉴

1. 不把 Pi SDK 直接揉进 Controller；否则会把 provider stream、session schema、compaction 和 runtime 升级风险并入唯一写者。需要 SDK 时，应是窄的 attempt adapter，Controller 仍只管理 workflow truth。
2. 不让 Worker/Reviewer resume 旧 session，也不把 Worker transcript 交给 Reviewer；fresh context 是独立审查成立的前提。
3. 不用 Pi JSONL/SQLite session 代替 Harness ledger，不用 agent event、`done` 或 completion message 代替 result + Git 验证。
4. 不引入通用 `sessions_spawn` 或任意深度 agent tree；当前只有 Reviewer 双轴并行具有明确验收入口。
5. 不把 Pi 自动 compaction/provider retry 映射成 workflow retry；审批后的恢复仍创建 fresh Attempt。
6. 不把 child completion 直接注入旧 Worker 并继续修改；Reviewer findings 应继续成为 bounded brief，交给 fresh Worker。

## 触发条件

| 候选能力 | 只有满足这些条件才重新评估 |
| --- | --- |
| Pi SDK/RPC attempt adapter | 需要逐 Attempt 关闭 auto-retry、显式 resource loader、结构化 events 或可靠 abort，而 CLI/Herdr 无法提供；优先 Worker-only 试点，并把 runtime 放在 Controller 之外的独立进程，保持 ledger 单写 |
| 细粒度 event bridge | 有真实长任务诊断或实时 UI 需求；Herdr 提供带 attempt/agent identity 的稳定事件 schema；事件明确只读 |
| in-flight cancel / timeout | 真实出现无法回收的 hung run；Herdr 提供精确 agent target、幂等 cancel、terminal receipt；取消结果能与 durable result 竞态收敛 |
| Worker session resume | 单次任务确实需要多 turn，且 transcript 可绑定 task digest、attempt ID、base/head 与工具集合；绝不跨 Worker→Reviewer 复用 |
| compaction | bounded context 已无法容纳真实任务；summary 可独立持久化、带 source refs/digest，且不丢失验收事实 |
| 通用 subagent tree | 出现三个以上可独立验收、确需动态展开的子问题；每个 child 都有独立 result contract、预算、权限 ceiling 和 parent 验收 |
| OS sandbox | 目标仓库、测试命令或多租户执行进入不可信威胁模型；此时使用容器/VM/独立账户，而不是扩大 Pi tool policy |

如果触发 SDK 试点，最小配置应是 fresh in-memory session、in-memory settings 且 `retry.enabled=false`（bounded attempt 通常也先关闭 compaction）、所有 resource discovery 关闭、只注入快照内 skills/extensions/context、精确 tools/custom tools，并只把结构化事件用于 telemetry/control。Worker 比 Reviewer 更适合作为首个试点：扩展面更小，而且最需要消除有副作用的隐藏 retry；Reviewer 还依赖 subagent extension，迁移面更大。

不要现在先造一个只有 Herdr 实现的抽象接口。只有 SDK/RPC 试点真的启动时，才把现有 `HerdrPort` 拆成“workspace/pane lifecycle”和“attempt execution”两个 seam；届时 Herdr CLI 与 Pi adapter 是两个真实实现，接口才有删除/替换价值。

最终判断：OpenClaw 最值得借鉴的不是某个 Pi API，而是它把 Pi 当作**可替换的 agent loop**，把 context、tools、sandbox、events 和结果语义留在宿主。HerdrHarness-lite 已在 workflow truth 与角色隔离上走得更严格；下一步应先补 Attempt 执行快照、context closure 和唯一 retry owner。事件桥接排在其后；在出现明确触发条件前，不改变当前 Controller→Herdr→fresh Pi 主链。
