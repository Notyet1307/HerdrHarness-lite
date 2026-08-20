# HerdrHarness Lite

HerdrHarness Lite is a single-slot, persistent, fail-closed controller for delivering one eligible GitHub Issue through fresh Worker and Reviewer Attempts, Git verification, PR checks, merge observation, and archival.

[简体中文](./README.zh-CN.md)

## Scope

The Controller selects an OPEN, ready-labelled, unassigned, unblocked Issue, or the first OPEN child of a strict Map frontier. It owns workflow transitions in one JSON ledger while GitHub, Git, durable role results, Herdr, and Pi retain their own fact boundaries.

This project is not a general multi-agent platform, a parallel scheduler, an OS sandbox, or a replacement for GitHub/Git truth. Analyst and Telegram integrations never become workflow authorities.

## Safety invariants

- One Controller writes one `stateDir`; one tick persists at most one transition.
- A Map is never claimed and its first OPEN child cannot be skipped.
- Worker and Reviewer use fresh Attempts; blocked Agent context is never resumed.
- Worker completion requires a Harness-owned durable result plus Git verification.
- Reviewer remains fresh, read-only, exact-HEAD, two-axis, and independently validated.
- Runtime events, Herdr status, child completion, and short probes are observations, not delivery truth.
- Analyst advises only; policy or an exact human gate authorizes recovery.
- Pi RPC auto-retry and Pi-owned auto-compaction remain disabled. Worker RPC alone may use the snapshot-bound, one-shot controlled threshold compaction; Reviewer compaction stays disabled.
- Credentials never enter results, receipts, the ledger, documentation, or copied credential files.

## Prerequisites and exact installation

Required: Node.js `>=22.16.0`, Git, an authenticated GitHub CLI, Herdr, Pi, Codex CLI, and a local checkout of the target repository. Docker is required only when `preflight.dockerRequired` is enabled.

```bash
npm ci
pi install npm:pi-subagents@0.42.1
pi install /ABSOLUTE/PATH/HerdrHarness-lite
npm run build
```

`npm ci` runs the package `prepare` script and generates ignored `dist/`. The explicit build command is safe to repeat after source updates.

## Minimal configuration

Copy [`harness.config.example.json`](./harness.config.example.json) to a private path outside the repository, then replace:

- `repo`, `localPath`, and `baseRef`;
- independent `stateDir`, `worktreeRoot`, and `herdr.session`;
- absolute skill, extension, Analyst, and validation paths;
- Worker/Reviewer provider and model selectors.

Preserve the example's complete role argv, ambient-discovery hardening flags, tools, thinking levels, and extension order. Keep the visible `reviewerArgv` provider/model aligned with the active Reviewer profile. Never place the state directory inside the source checkout or worktree root.

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
```

`dist/` is a local generated artifact and must not be committed.

## Tick canary

`tick` is mutating: it may preflight, claim an Issue, or advance the active Job. Use a disposable lane or an explicitly authorized real frontier, and ensure no other Controller owns the same `stateDir`.

```bash
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
node dist/src/cli.js tick --config /ABSOLUTE/PATH/harness.config.json
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
```

Read back the ledger after each manual tick. An `attempt_dispatched` action is not completion.

## Run

After the tick canary and state readback are correct:

```bash
node dist/src/cli.js run \
  --config /ABSOLUTE/PATH/harness.config.json \
  --poll-ms 15000
```

Use `--max-cycles N` for a bounded foreground run. A supervisor may restart the process, but must never start a second writer for the same state directory.

## Status and decisions

```bash
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json --operator
node dist/src/cli.js decide \
  --config /ABSOLUTE/PATH/harness.config.json \
  --option OPTION_ID \
  --actor 'maintainer identity' \
  --reason 'bounded evidence-based reason'
```

Always obtain the current option from `status --operator`; `decide` rejects stale bindings. Read status again to verify the durable effect. Compatibility recovery commands remain documented in the operator runbook.

## Documentation

- [Current architecture](./ARCHITECTURE.zh-CN.md): entities, states, authority, trust, flows, modules, compatibility boundaries.
- [Operator runbook](./docs/runbooks/operator.zh-CN.md): full setup, canary, run, recovery, upgrade, and rollback procedure.
- [Telegram integration](./integrations/hermes-telegram/README.md): standalone Bridge and Hermes compatibility configuration.
- [Telegram cutover](./docs/runbooks/telegram-cutover.md): deployment, canary, and rollback.
- [Architecture decisions](./docs/adr/): durable reasons behind Attempt integrity, context closure, retry ownership, and TypedHandoff.
- [Repository instructions](./AGENTS.md): AI reading order and change gates.
