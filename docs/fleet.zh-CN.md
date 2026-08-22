# Fleet 多项目运行手册

HerdrHarness Lite 的并发边界是“项目”，不是“同一项目中的多个 Issue”。每个项目仍由一个单写、单槽 Controller 串行推进任务；Fleet Supervisor 只负责同时运行多个彼此隔离的 Controller。

## 1. 第一性原理

系统只有三类变量：

- 项目配置：仓库、source checkout、state、worktree、Herdr session；
- 项目运行时：Controller 子进程、lease、heartbeat、重启历史；
- Fleet 运行时：Supervisor lease、heartbeat、聚合状态。

核心关系：

```text
Fleet 只拥有项目进程生命周期
Controller 只拥有本项目 workflow transition
GitHub / Git 继续拥有各自外部事实
```

硬约束：任何两个项目都不能共享可变权威边界。

```text
Fleet Supervisor
├── Project A child process
│   ├── source checkout A
│   ├── state / lease / heartbeat A
│   ├── worktree root A
│   └── Herdr session A
├── Project B child process
│   ├── source checkout B
│   ├── state / lease / heartbeat B
│   ├── worktree root B
│   └── Herdr session B
└── Fleet-only state
    ├── fleet-supervisor-lease.json
    ├── fleet-supervisor-heartbeat.json
    ├── fleet-state.json
    └── fleet-events.jsonl
```

Fleet 不改写项目 `state.json`，也不代替项目 Controller 做 claim、Attempt、review、recovery、publish 或 merge decision。

## 2. 强制隔离不变量

`herdr-harness-fleet validate` 会在启动任何子进程之前拒绝：

- 重复项目 ID；
- 重复项目配置文件；
- 同一 GitHub 仓库被两个项目配置；
- 重复 Herdr session；
- 项目内部 `localPath`、`stateDir`、`worktreeRoot` 任意重叠；
- 不同项目之间上述任意路径相等、互为父子目录或经符号链接指向重叠目录；
- Fleet `stateDir` 与任何项目目录重叠；
- 不满足原单项目 Worker/Reviewer、绝对路径、runtime 或 provider contract 的项目配置。

这比给共享循环增加 `projectId` 更严格：隔离的真实单位是文件系统、进程、lease、Git 操作范围和 Herdr session。

## 3. 配置

复制 `fleet.config.example.json`。项目配置路径可以相对于 Fleet 配置文件；项目配置内部的运行路径仍由原 Harness 校验。

```json
{
  "version": 1,
  "name": "engineering-fleet",
  "stateDir": "/srv/herdr/state/fleet",
  "tickConcurrency": 4,
  "projects": [
    { "id": "api", "config": "./configs/api.json", "pollMs": 15000 },
    { "id": "console", "config": "./configs/console.json", "pollMs": 20000 }
  ]
}
```

推荐目录：

```text
/srv/herdr/
├── configs/
│   ├── fleet.json
│   ├── api.json
│   └── console.json
├── source/
│   ├── api/
│   └── console/
├── state/
│   ├── fleet/
│   ├── api/
│   └── console/
└── worktrees/
    ├── api/
    └── console/
```

## 4. 命令

```bash
npm ci
npm run build

# 只读配置与隔离校验
node dist/src/fleet-cli.js validate --config /srv/herdr/configs/fleet.json

# 所有启用项目并行执行一次 tick
node dist/src/fleet-cli.js tick --config /srv/herdr/configs/fleet.json

# 指定一个项目执行 canary tick
node dist/src/fleet-cli.js tick --config /srv/herdr/configs/fleet.json --project api

# 持续监督所有启用项目
node dist/src/fleet-cli.js run --config /srv/herdr/configs/fleet.json

# 聚合 workflow / lease / heartbeat / operator 状态
node dist/src/fleet-cli.js status --config /srv/herdr/configs/fleet.json --operator

# 人工排障后清除一个项目的 Fleet 重启熔断记录
node dist/src/fleet-cli.js reset --config /srv/herdr/configs/fleet.json --project api
```

`tick` 使用有界 worker pool，并由 `tickTimeoutMs` 限制单项目 canary 的最长执行时间。某个项目失败或超时会让聚合返回非零，但不会取消仍在执行的其他项目。

`tickTimeoutMs` 是一次性 CLI 的硬终止边界，不等同于 `run` 的 graceful shutdown。超时可能留下已死亡 PID 对应的 stale Controller lease；下一次获取 lease 时会先确认 PID 已退出再回收。已经产生的 Attempt side effect 仍只能沿原 ledger 和 same-Attempt reconciliation 观察，不会因超时重放。

Fleet 在校验时绑定每个项目配置的 SHA-256；`tick` 和 `run` child 会在产生任何项目副作用前复核该 digest。修改项目配置后必须停止并重新启动 Fleet，旧 Supervisor 不会热加载或接受漂移后的配置。

## 5. `run` 的项目级故障域

每个项目拥有独立监督循环：

1. 启动前读取项目 `controller-lease.json`；
2. 已有存活 Controller 时进入 `adopted`，不启动第二写者；
3. Fleet 自己启动的 Controller 异常退出后，仅该项目进入指数退避；
4. 时间窗口内超过重启上限，仅该项目进入 `tripped`；
5. 其他项目继续运行；
6. 连续运行超过 `stableAfterMs` 后，历史短故障计数清零；
7. Supervisor 重启后按项目配置 digest 保留重启时间戳与 `tripped` 状态；修改兄弟项目配置不会重置本项目熔断；
8. `SIGINT`/`SIGTERM` 只终止 Fleet 自己拥有的子进程，不杀死 adopted 外部 Controller；单项目 `run` 会中断 poll sleep 并正常释放 heartbeat/lease。

默认值：1 秒起始退避、60 秒上限、5 次重启、5 分钟窗口、稳定 2 分钟后重置。

## 6. 状态与审计

Fleet 状态只包含项目进程生命周期：

```text
pending / starting / running / adopted / backoff / tripped
stopping / stopped / disabled / unselected / error
```

`unselected` 表示本次使用 `--project` 只监督了 Fleet 的一部分；它不同于配置中明确关闭的 `disabled`。

项目业务真相仍在各项目自己的 `state.json`。`fleet-events.jsonl` 是观测审计，不是 workflow authority。若状态已原子提交但 audit append 失败，Fleet 写入 `fleet-events.degraded.json`，不会把已成功状态提交伪装成失败。

Supervisor 在启动任何 child 前必须成功写入初始 Fleet checkpoint。启动后若观测 checkpoint 暂时不可写，Supervisor 会向 stderr 告警并保留内存中的隔离监督；它不会因此终止兄弟项目。磁盘状态在存储恢复后的下一次 checkpoint 收敛。

项目 stdout/stderr 以带 `projectId` 的 JSON envelope 转发，但不会复制进 `fleet-state.json`，避免未脱敏的 child 输出进入持久状态。一次性 `tick` 报告的输出仍受 `maxLogBytes` 限制。

独立 `fleet-observer` 只读取真实 Fleet status projection，比较 Supervisor down/up、config drift、项目 process phase 与 Controller health。它不会发送项目 workflow incident；该职责仍属于每个 Project Observer。Fleet Observer 的 `routes` 显式把允许大写、点和下划线的 Fleet project ID 映射为 callback-safe 短 route ID，且不会读写项目 ledger。

```bash
node dist/src/transport-cli.js fleet status --config /PRIVATE/PATH/fleet-observer.json --json v2
node dist/src/fleet-observer.js run --config /PRIVATE/PATH/fleet-observer.json --once
```

## 7. 仍然不提供的能力

- 同一项目多个 Issue 并行；
- 操作系统、容器或微虚机 sandbox；
- CPU、内存、磁盘和网络配额；
- 动态热加载 Fleet 配置；
- 跨主机分布式 lease；
- 项目间依赖 DAG 与全局公平调度。

同项目并行会改变 claim、branch、approval、merge 和 recovery 的一致性模型，必须作为独立 Scheduler 设计，不能偷塞进当前 Controller。
