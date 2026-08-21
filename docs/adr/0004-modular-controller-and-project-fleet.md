# ADR 0004：模块化 Controller 与项目级 Fleet

- 状态：Accepted
- 基准提交：`06db50cf261312e7be10cc8ce30808455deb5113`

## 背景

原 `src/controller.ts` 同时承担状态分发、任务领取、Attempt 准备与驱动、runtime preflight、Worker/Reviewer 收口、PR/CI、诊断恢复、归档和配置校验。它已经超过八万字节，使每次修改都激活过多上下文，并增加跨责任误改风险。

同时，多项目运行不能通过在该 Controller 内增加共享并发循环实现。项目拥有独立 GitHub frontier、Git checkout、ledger、lease、worktree 和 Herdr session，因此项目必须成为独立故障域。

## 决策

1. `src/controller.ts` 只保留公开构造器和 `JobState` 分发。
2. 现有流程按变化原因拆入 `src/controller/`：task、Attempt preparation、Attempt driver、settlement、runtime preflight、integrity、delivery、recovery、configuration。
3. 共享副作用通过 `ControllerContext` 收口；不新增第二份 workflow state。
4. 机械迁移的方法必须通过 `scripts/verify-controller-refactor.mjs` 与基准 Controller 比较。
5. 补齐 `localPath` 与 `worktreeRoot` 的重叠校验。
6. 新增 Fleet Supervisor；每个项目使用原单项目 CLI 的独立子进程。
7. Fleet 只拥有进程生命周期，不直接读写项目业务 transition。
8. Fleet 强制拒绝重复 repo/session 和所有项目目录重叠。
9. Fleet 为每个 child 绑定已验证项目配置的 digest；启动或重启前发生配置漂移时 fail closed。
10. 项目独立退避、熔断和 graceful shutdown；重启历史按项目配置 digest 恢复，兄弟配置变化不能重置本项目熔断。已有 Controller 只观察接管，不创建第二写者。单项目 `run` 使用 signal latch 中断 poll sleep，并通过正常 `finally` 释放 heartbeat/lease。
11. 初始 Fleet state checkpoint 必须在启动 child 前成功；启动后的观测 checkpoint 降级只告警，不能让一个状态写故障终止整个 Supervisor。状态原子提交后，audit append 失败不得向调用方伪装为 transition 未提交；Supervisor shutdown 的状态写降级也不能绕过 child、heartbeat 和 lease 清理。
12. Supervisor 转发带项目身份的 child stdout/stderr，但不把未脱敏输出复制进持久 Fleet state。

## 结果

- Controller 的入口文件变为薄 facade，流程模块可独立阅读和测试。
- 原状态机、ledger schema、CLI 和角色权限合同保持不变。
- 多项目并发以进程和目录隔离为基础，一个项目失败不会传播到其他项目。
- Fleet 不解决同项目多任务并行，也不声称提供 OS sandbox 或跨主机一致性。
