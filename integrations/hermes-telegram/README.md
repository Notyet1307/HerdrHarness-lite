# Harness Telegram integration

The recommended transport is the standalone
[`harness-telegram-bridge`](https://github.com/Notyet1307/harness-telegram-bridge).
It removes the custom Hermes callback dependency while preserving the existing
Harness status, incident, and exact-approval CLIs.

```text
Harness ledger + Controller log + heartbeat
  -> one Observer per lane
  -> deliveryCommand
  -> one standalone Bridge per Bot Token
  -> Telegram

Telegram /harness and callbacks
  -> Bridge
  -> lane status/approval commands
  -> Harness policy and ledger CAS
```

The Controller does not import this integration. Observer state, Bridge offset,
Telegram messages, and callbacks are transport facts, never workflow truth.

## Choose one transport

| Mode | Observer config | Bot update consumer | Status |
| --- | --- | --- | --- |
| Standalone Bridge | `bridge.standalone.config.example.json` with `deliveryCommand` | Bridge | Recommended |
| Hermes compatibility | `bridge.config.example.json` without `deliveryCommand` | Harness-specific Hermes Gateway | Existing deployments only |

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

The Observer sends one card JSON object to `deliveryCommand` on stdin. Plain text
messages carry `parseMode: "plain"`; approval and hold cards use validated HTML
and bounded callback data.

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

Multiple lanes:

```text
/harness
/harness exposure status
/harness exposure incident
/harness exposure why
/harness exposure actions
/harness exposure retry
```

`/harness` returns one compact line per lane when more than one lane exists.
Callbacks carry the lane ID; the Bridge rejects an unknown lane and never edits
the ledger directly.

Observer proactively sends only task start, terminal state, incidents, Analyst
decisions, exact approval cards, and automation health changes. Normal
Worker/Reviewer/publish/merge-wait progress remains available through
`/harness`, avoiding notification noise.

Operator cards are ten-minute, single-use challenges bound to the exact option,
job, revision, incident, analysis, Attempt, lane, and HEAD. The Bridge accepts
one allowlisted user in a private chat. Abandoning the challenge writes no
operator action; confirmation still passes through `decide --option` and the
Harness ledger CAS. The standalone Bridge supports the expanded command set;
the Hermes compatibility plugin intentionally retains its legacy
`status|incident|approve` vocabulary.

## Multi-repository lanes

The standalone Bridge owns its lane map in its own `config.json`; do not use
`fleet.config.example.json` for standalone mode. Each lane maps to one Observer
config and one pair of Harness status/approval commands.

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
