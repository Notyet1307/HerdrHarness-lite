# Hermes Telegram Harness Fleet

Fleet mode keeps each Harness Controller, ledger, worktree, Herdr session, Observer, and approval challenge independent while exposing one Hermes Telegram command and callback entry point.

## Configure lanes

Copy `bridge.config.example.json` once per repository. Each copy must have:

- a unique `laneId` using 1-32 lowercase letters, digits, or hyphens;
- its own `harnessConfig`, `approvalState`, `observerState`, and `controllerLog`;
- a Controller heartbeat derived from `<stateDir>/controller-heartbeat.json`, independent of Controller log traffic;
- the same `telegramAllowedUser` as every other lane;
- a Harness config with a unique `stateDir`, `worktreeRoot`, and `herdr.session`.

Copy `fleet.config.example.json` and map every lane ID to its absolute bridge config path. The map key and the bridge's `laneId` must match. Fleet and bridge files must not be symlinks or group/other writable; use mode `0600`.

Set `HERDR_HARNESS_FLEET_CONFIG` to the absolute fleet config path for both the Hermes Gateway and every Observer process that invokes the `harness-card` CLI. Fleet mode takes precedence over the legacy `HERDR_HARNESS_TELEGRAM_CONFIG`. Keep one Observer process per lane; all Observers may send through the same Hermes profile and Telegram bot.

## Telegram commands

```text
/harness
/harness exposure
/harness exposure status
/harness exposure incident
/harness exposure approve
/harness exposure approve 0123456789ABCDEF
```

`/harness` returns one compact line per lane. Approval cards carry the lane ID in callback data; the Router accepts only a registered lane and then invokes that lane's existing exact-binding approval command. It never edits a ledger directly.

Without `HERDR_HARNESS_FLEET_CONFIG`, the existing single-instance commands and `hh:a:<token>` callbacks remain supported.
