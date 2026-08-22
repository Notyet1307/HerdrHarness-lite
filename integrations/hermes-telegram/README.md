# Harness Telegram integration

The recommended transport is the standalone
[`harness-telegram-bridge`](https://github.com/Notyet1307/harness-telegram-bridge).
It removes the custom Hermes callback dependency while preserving the existing
Harness status, incident, and exact-approval CLIs.

```text
Harness / Fleet authority
  -> versioned read-only Transport projection
  -> Project Observer / Fleet Observer
  -> JSON envelope without Telegram HTML
  -> one standalone Bridge per Bot Token
  -> Telegram HTML and buttons

Telegram callback -> Bridge routeId -> Harness challenge CLI
  -> current Core-owned operator option -> decide + ledger CAS
```

The Controller does not import this integration. Observer state, Bridge offset,
Telegram messages, and callbacks are transport facts, never workflow truth.
Use the repository
[`Telegram transport cutover`](../../docs/runbooks/telegram-cutover.md) runbook
for deployment, canary, and rollback.

## Choose one transport

| Mode | Observer config | Bot update consumer | Status |
| --- | --- | --- | --- |
| Standalone Bridge | `bridge.standalone.config.example.json` with `deliveryCommand` | Bridge | Recommended |
| Hermes compatibility | `bridge.config.example.json` without `deliveryCommand` | Harness-specific Hermes Gateway | Existing deployments only |

Transport v2 uses [`project-observer-v2.config.example.json`](./project-observer-v2.config.example.json)
and [`fleet-observer.config.example.json`](./fleet-observer.config.example.json).
Omitting `transportVersion` keeps the existing v1 payload and state path for a
rolling upgrade.

Never run both consumers with the same Bot Token. An existing dedicated Bot can
be reused after the old consumer is stopped. Use a second Bot when the migration
must have no polling interruption.

## Standalone Bridge setup

1. Copy `bridge.standalone.config.example.json` once per Harness lane.
2. Give every lane a unique 1-32 character lowercase `laneId`, `harnessConfig`,
   `approvalState`, `observerState`, and `controllerLog`.
3. Point `deliveryCommand` to the standalone Bridge `send-card` command.
4. Configure the Bridge with the same lane ID and the lane's `hermes-status.js`
   and `hermes-approval.js` commands.
5. Store the Bot Token in its own mode `0600` file. Keep real tokens and real
   Telegram user IDs out of Git, plist arguments, logs, and documentation examples.
6. Start the Bridge as the only update consumer, then start one Observer per lane.

The v1 Observer sends one legacy card JSON object to `deliveryCommand`. The v2
Observers send a strict `project-view`, `fleet-view`, `diagnostic-view`, or
`event` envelope. Envelopes contain no Telegram HTML; the Bridge is the only
renderer. The Project Observer migrates existing Observer state version 2 to
version 3 while preserving offsets, automatic-recovery count, pending delivery
retries, and its current baseline. Fleet Observer state is independent.

Configuration files must use absolute paths, must not be symlinks or
group/other-writable, and should use mode `0600`. Every Harness lane must also
have an independent `stateDir`, `worktreeRoot`, and `herdr.session`.

Setup is complete only when:

- the Bridge starts without a Telegram `409 Conflict`;
- `/harness` returns the lane's live read-only status;
- an outbound canary reaches the intended private chat;
- an invalid or expired approval challenge changes no ledger state;
- Observer restart does not replay historical normal progress;
- Controller, Observer, and Bridge restart independently.
- Fleet Observer can restart without replaying its current process phases.
- the parent-directory contract check reports identical schema and fixture
  digests in both repositories.

## Commands and notification policy

Single lane:

```text
/harness
/harness status
/harness incident
/harness why
/harness evidence
/harness actions
/harness retry
/harness retry 0123456789ABCDEF
/harness reassess preserve the dirty worktree and analyze new evidence
/harness resolve bounded maintainer decision
/harness cancel bounded cancellation reason
```

Multiple routes:

```text
/harness
/harness exposure status
/harness exposure why
/harness exposure actions
/harness exposure health
/harness exposure diagnose 7
/harness exposure retry
/harness_health exposure
/harness_diagnose exposure 30
```

With Fleet configured, `/harness` renders the real Supervisor lease, heartbeat,
config drift and project process phases. It does not synthesize Fleet health by
joining project status strings. `blocked` remains a workflow state, not a process
health failure. Callbacks carry only the short lowercase `routeId`; the actual
Fleet `projectId` may contain uppercase letters, dots, or underscores and never
enters callback data.

Project Observer proactively sends only task start, terminal state, new
incidents/decisions, exact approval, automatic recovery, Controller/ledger
health transitions and quota exhaustion. Fleet Observer sends only Supervisor
down/up, config drift, process backoff/tripped/error/adopted/recovery, and
Controller health transitions. Normal Worker/Reviewer phases, validation ready,
checkpoint persistence, PR/CI waiting, heartbeat updates and diagnostic count
changes remain pull-only.

Operator cards are ten-minute, single-use challenges bound to the exact option,
job, revision, incident, analysis, Attempt, lane, and HEAD. The Bridge accepts
one allowlisted user in a private chat. Abandoning the challenge writes no
operator action; confirmation still passes through `decide --option` and the
Harness ledger CAS. The standalone Bridge supports the expanded command set;
the Hermes compatibility plugin intentionally retains its legacy
`status|incident|approve` vocabulary.

## Transport v2 read-only CLI

```bash
node dist/src/transport-cli.js project status --config /absolute/project-observer-v2.json --json v2
node dist/src/transport-cli.js project health --config /absolute/project-observer-v2.json --json v2
node dist/src/transport-cli.js project diagnose --config /absolute/project-observer-v2.json --days 7 --json v2
node dist/src/transport-cli.js fleet status --config /absolute/fleet-observer.json --json v2
node dist/src/transport-cli.js fleet diagnose --config /absolute/fleet-observer.json --days 30 --json v2
```

Project/Fleet projections omit task bodies, raw evidence, result summaries,
absolute private paths, raw Provider output, auth paths, tokens and transcripts.
Provider/model display values are stable SHA-256 IDs. Diagnostic views contain
aggregates only and preserve `partial`, `corrupt`, and `unknown` explicitly.

The committed schema and seven golden fixtures live under `schemas/` and
`test/fixtures/telegram-transport-v2/`. From the parent directory:

```bash
node HerdrHarness-lite/scripts/check-telegram-transport-contract.mjs harness-telegram-bridge
cd HerdrHarness-lite && npm run canary:telegram-transport -- ../harness-telegram-bridge
```

## Multi-repository routes

The standalone Bridge owns its route map in its own `config.json`. Each route
maps to one actual Fleet project ID, one Project Observer config, and fixed
view/approval/diagnose argv. Fleet Observer repeats the projectId-to-routeId map
so its envelopes are callback-safe; Bridge startup reads the real fleet-view and
rejects any configured projectId missing from that view.

Bridge Fleet config keeps the Fleet Observer `configPath` separate from the
fixed `transport-cli.js fleet` / `fleet-diagnose` argv prefixes, matching the
Project command convention; Bridge appends only allowlisted view/day and
`--json v2` arguments.

`fleet.config.example.json` belongs only to the legacy Hermes plugin. In that
mode, set `HERDR_HARNESS_FLEET_CONFIG` for the Hermes Gateway and every Observer.
Fleet mode takes precedence over `HERDR_HARNESS_TELEGRAM_CONFIG`.

## Hermes compatibility

When `deliveryCommand` is absent, Observer uses `hermesBin`, `hermesProfile`, and
`target` for text delivery and `harness-card` for cards. The plugin in this
directory registers `/harness` and callback routing for that profile.

Keep this mode only while an existing deployment still needs it. A standalone
cutover is complete when the Bridge is healthy, Observer uses
`deliveryCommand`, and the Harness-specific Hermes Gateway is stopped. Other
Hermes profiles and gateways are outside that cutover.
