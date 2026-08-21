# HerdrHarness Lite

HerdrHarness Lite is a persistent, fail-closed GitHub Issue delivery controller. Each project delivers one eligible Issue at a time through fresh Worker and Reviewer Attempts, Git verification, PR checks, merge observation, and archival. The optional Fleet Supervisor runs multiple isolated projects concurrently without merging their workflow authority.

[简体中文](./README.zh-CN.md)

## Scope

A project Controller selects an OPEN, ready-labelled, unassigned, unblocked Issue, or the first OPEN child of a strict Map frontier. It owns workflow transitions in one JSON ledger while GitHub, Git, durable role results, Herdr, and Pi retain their own fact boundaries.

Fleet is a separate process-lifecycle layer. It starts or observes one single-project Controller process per project and rejects shared repositories, source checkouts, state directories, worktree roots, or Herdr sessions.

This project is not a general multi-agent platform, an intra-project parallel scheduler, an OS sandbox, or a replacement for GitHub/Git truth. Analyst, Fleet, and Telegram integrations never become workflow authorities.

## Safety invariants

- One Controller writes one project `stateDir`; one tick persists at most one transition.
- A Map is never claimed and its first OPEN child cannot be skipped.
- Worker and Reviewer use fresh Attempts; blocked Agent context is never resumed.
- Worker completion requires a Harness-owned durable result plus Git verification.
- Reviewer remains fresh, read-only, exact-HEAD, two-axis, and independently validated.
- Runtime events, Herdr status, child completion, and short probes are observations, not delivery truth.
- Analyst advises only; policy or an exact human gate authorizes recovery.
- Pi RPC auto-retry and Pi-owned auto-compaction remain disabled. Worker RPC alone may use the snapshot-bound, one-shot controlled threshold compaction; Reviewer compaction stays disabled.
- Credentials never enter results, receipts, the ledger, documentation, or copied credential files.
- Projects sharing canonical OAuth coordinate through a realpath-digest startup lease; openai-codex Reviewer axes serialize by default while custom Providers may use concurrency 1 or 2.
- Fleet manages project processes only; it never writes project workflow transitions.
- Single-project `run` handles `SIGINT`/`SIGTERM`, interrupts the poll sleep, and releases its heartbeat and Controller lease through normal `finally` cleanup.
- Every Fleet project has a distinct repo, source checkout, state directory, worktree root, and Herdr session.

## Prerequisites and exact installation

Required: Node.js `>=22.16.0`, Git, an authenticated GitHub CLI, Herdr, Pi, Codex CLI, and a local checkout of each target repository. Docker is required only when a project enables `preflight.dockerRequired`.

```bash
npm ci
pi install npm:pi-subagents@0.42.1
pi install /ABSOLUTE/PATH/HerdrHarness-lite
npm run build
```

`npm ci` runs the package `prepare` script and generates ignored `dist/`. The explicit build command is safe to repeat after source updates.

## Single-project configuration

Copy [`harness.config.example.json`](./harness.config.example.json) to a private path outside the repository, then replace:

- `repo`, `localPath`, and `baseRef`;
- independent `stateDir`, `worktreeRoot`, and `herdr.session`;
- absolute skill, extension, Analyst, and validation paths;
- Worker/Reviewer provider and model selectors.

Preserve the example's complete role argv, ambient-discovery hardening flags, tools, thinking levels, and extension order. Keep the visible `reviewerArgv` provider/model aligned with the active Reviewer profile. `localPath`, `stateDir`, and `worktreeRoot` must be pairwise separate.

The optional second Worker extension is exactly `@dietrichgebert/ponytail` `4.9.0`. When declared, Harness forces full mode while suppressing status/startup UI; it never relaxes the Worker UI-request deny policy.

Validate external access before running:

```bash
gh auth status
gh repo view OWNER/REPOSITORY
herdr session list --json
pi --version
```

## Build

```bash
npm run build
node dist/src/cli.js --help
node dist/src/fleet-cli.js --help
```

`dist/` is a local generated artifact and must not be committed.

## Single-project tick canary

`tick` is mutating: it may preflight, claim an Issue, or advance the active Job. Use a disposable lane or an explicitly authorized real frontier, and ensure no other Controller owns the same project `stateDir`.

```bash
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
node dist/src/cli.js tick --config /ABSOLUTE/PATH/harness.config.json
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
```

Read back the ledger after each manual tick. An `attempt_dispatched` action is not completion.

## Single-project run and decisions

```bash
node dist/src/cli.js run \
  --config /ABSOLUTE/PATH/harness.config.json \
  --poll-ms 15000

node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json --operator
node dist/src/cli.js decide \
  --config /ABSOLUTE/PATH/harness.config.json \
  --option OPTION_ID \
  --actor 'maintainer identity' \
  --reason 'bounded evidence-based reason'
```

Use `--max-cycles N` for a bounded foreground run. A Supervisor must never start a second writer for the same project state directory.

Always obtain the current option from `status --operator`; `decide` rejects stale bindings. Read status again to verify the durable effect. Compatibility recovery commands remain documented in the operator runbook.

## Multi-project Fleet Supervisor

Each project remains a single-slot Controller. Projects run concurrently because Fleet starts one isolated single-project CLI process per project, not because one Controller owns multiple ledgers.

```bash
cp fleet.config.example.json /PRIVATE/PATH/fleet.config.json

node dist/src/fleet-cli.js validate --config /PRIVATE/PATH/fleet.config.json
node dist/src/fleet-cli.js tick --config /PRIVATE/PATH/fleet.config.json
node dist/src/fleet-cli.js run --config /PRIVATE/PATH/fleet.config.json
node dist/src/fleet-cli.js status --config /PRIVATE/PATH/fleet.config.json --operator
```

One project may block, crash, back off, or trip its restart circuit without cancelling sibling projects. Existing live Controllers are observed as `adopted`; Fleet does not start a second writer. See the [Fleet runbook](./docs/fleet.zh-CN.md) and [Fleet schema](./schemas/fleet.config.schema.json).

## Controller module boundaries

`src/controller.ts` is intentionally a thin state dispatcher. The implementation is separated by change reason:

- `task-lifecycle.ts`: selection, claim, worktree, archive;
- `attempt-preparation.ts`: immutable execution plan and context binding;
- `attempt-driver.ts`: pane, Agent, dispatch, wait;
- `attempt-settlement.ts`: Worker/Reviewer result closure;
- `runtime-preflight.ts` and `attempt-integrity.ts`: external runtime and Git gates;
- `delivery.ts`: PR, CI, base refresh, merge;
- `recovery-flow.ts`, `automatic-recovery.ts`: Analyst evidence plus policy fresh-retry authorization and side-effect verification;
- `config-validation.ts`: path and role contracts.

The public `HarnessController` constructor and `tick()` contract remain unchanged.

## Documentation

- [Current architecture](./ARCHITECTURE.zh-CN.md): existing entities, states, authority, trust, and flows.
- [Controller/Fleet ADR](./docs/adr/0004-modular-controller-and-project-fleet.md): this change's durable boundaries.
- [Fleet runbook](./docs/fleet.zh-CN.md): multi-project configuration, isolation, supervision, and recovery.
- [Operator runbook](./docs/runbooks/operator.zh-CN.md): single-project setup, canary, run, recovery, upgrade, and rollback.
- [Telegram integration](./integrations/hermes-telegram/README.md): standalone Bridge and Hermes compatibility configuration.
- [Telegram cutover](./docs/runbooks/telegram-cutover.md): deployment, canary, and rollback.
- [Architecture decisions](./docs/adr/): durable reasons behind Attempt integrity, context closure, retry ownership, controlled compaction, and Fleet isolation.
- [Repository instructions](./AGENTS.md): AI reading order and change gates.
