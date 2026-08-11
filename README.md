# HerdrHarness Lite

English | [简体中文](./README.zh-CN.md)

HerdrHarness Lite is a small, fail-closed controller for delivering GitHub issues. A durable state machine coordinates GitHub, Git, Herdr, fresh Pi Workers, independent Reviewers, and a Codex Analyst. Agent sessions, terminal output, notifications, and chat replies are never delivery truth.

Herdr owns worktrees and durable panes. Worker and top-level Reviewer Attempts use interactive Pi by default and may independently select a supervised Pi RPC runner in a Herdr pane. Hermes is no longer required by the recommended Telegram path; it is retained only as a backward-compatible transport.

## Read this first

- **Operate or recover:** follow **Agent operating procedure** in order and obey each stop condition.
- **Deploy Telegram:** read **Current architecture**, then [`integrations/hermes-telegram/README.md`](./integrations/hermes-telegram/README.md).
- **Change the controller:** read **How the system works**, **Capabilities and boundaries**, and the implementation entry points.
- **Review design history:** read [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md); treat code, config, and tests as current truth when that analysis differs.

## Current architecture

The control plane and notification plane are deliberately independent:

```text
Control plane
GitHub + Git <-> Controller <-> durable ledger
                    |-> Herdr pane -> fresh Pi Reviewer (interactive or durable RPC runner)
                    |-> Herdr pane -> fresh Pi Worker (interactive or durable RPC runner)
                    `-> task-bound Codex Analyst when evidence is needed

Notification and operator plane
ledger + Controller JSONL + heartbeat
                    -> Observer -> deliveryCommand -> standalone Telegram Bridge -> Bot
Telegram /harness + callbacks
                    -> Bridge -> status / approval CLI -> Harness policy + ledger CAS
```

Harness Core is the only workflow authority. The Controller performs automatic transitions; recovery authority can enter only through the exact deterministic policy gates and ledger CAS. The Observer may disappear, notifications may be delayed, and Telegram may be offline without changing task truth or granting recovery authority.

| Component | Responsibility | Authority boundary |
| --- | --- | --- |
| Controller (`src/controller.ts`) | One durable transition per `tick`; effects, verification, recovery, publish, and merge observation | Sole automatic transition writer under the state-directory lease |
| Herdr + Pi | Worktree/pane host and fresh Worker/Reviewer execution, with an optional supervised RPC runner per lane | Runtime and liveness only; neither RPC terminal nor Herdr state replaces durable result plus Harness Git verification |
| Codex Analyst | Bounded evidence analysis for blocked work | Recommends `hold` or a policy-allowed fresh retry; never approves or writes state |
| Observer (`src/hermes-observer.ts`) | Reads ledger, Controller JSONL, and heartbeat; maintains a retrying notification outbox | No workflow-state authority; it may create only transport outbox/challenge state. The filename is retained for compatibility and standalone mode does not require Hermes |
| [Harness Telegram Bridge](https://github.com/Notyet1307/harness-telegram-bridge) | Sends cards, polls `/harness` and callbacks, and invokes existing status/approval CLIs | Transport only; stores Telegram offset and never edits the ledger directly |
| Telegram user | Reads status and accepts or declines an exact approval challenge | Human intent is still revalidated by the Harness policy and ledger CAS |

### Attempt contracts after the refactor

This refactor does not add a second orchestrator. The Controller, ledger, Git verification, and Reviewer gates remain the workflow truth. The change is that every Worker/Reviewer Attempt now consists of three explicit, verifiable data contracts:

| Contract | Bound data | Control gained |
| --- | --- | --- |
| `ExecutionSnapshot` | Runtime adapter, Pi executable/exact qualified version, complete argv, resource/context digests, credential mode, Docker host, and result channel | A restarted Controller consumes the same plan; configuration, version, or resource drift fails closed before a new side effect |
| `AttemptContextEnvelope` | Attempt identity, trusted policy digests, untrusted issue/handoff/evidence, exact Git target, runtime view, and writeback contract | Each role receives only the context needed for this Attempt; global or candidate instructions cannot gain authority through ambient discovery |
| `TypedHandoff` | Reviewer findings or approved recovery/CI rework, bound to source revision/digests and the next lane/base/HEAD | Continuation is no longer a free-form brief; stale, wrong-lane, or wrong-HEAD handoffs cannot be consumed |

Data for one Attempt flows as follows:

```text
current config + live preflight
        -> ExecutionSnapshot
trusted baseSha root policy + untrusted issue / evidence / TypedHandoff
        -> role-scoped AttemptContextEnvelope
Snapshot + Envelope + rendered prompt
        -> planDigest
        -> AttemptRuntimePort
             |-> herdr-pi-cli -> interactive Pi
             `-> pi-rpc -> foreground runner in Herdr pane -> Pi SDK host
        -> atomic durable result
        -> Harness result / Git / Reviewer gates
        -> ledger transition
```

On the RPC path the Controller never owns Pi stdin/stdout. The pane runner owns the pipes, while the Controller writes one intent and reads atomic receipts. A Controller restart therefore observes the same Attempt instead of replaying its prompt. Credential contents never enter the envelope, prompt, or spool: Worker RPC lets Pi share subscription OAuth through the canonical pathname and native lock; Reviewer RPC binds the canonical `models.json` digest and parses only the supported custom provider in memory.

| Lane | `herdr-pi-cli` | `pi-rpc` | Unchanged completion gate |
| --- | --- | --- | --- |
| Worker | Herdr interactive agent | Durable runner + SDK host + canonical subscription OAuth | `worker_submit` durable result + Git provenance |
| Top-level Reviewer | Herdr interactive agent | Durable runner + SDK host + digest-bound custom model config | `review_submit` + exact HEAD + isolated validation |
| Reviewer axis children | Started in the foreground by the top-level Reviewer | Still use the immutable child wrapper and are not migrated to RPC | Both Standards and Spec axes must return substantive results |

Pi `agent_settled`, a runner terminal, pane `done`, and child completion are runtime facts only. They never bypass the durable result, Git fixed point, Reviewer decision, or GitHub merge. See **Attempt execution plan and context trust** for the full trust boundary.

### Notifications and Telegram operations

The recommended deployment runs three independent long-lived processes: Controller, Observer, and the standalone Bridge. Notification failure does not stop the Controller; Controller failure is reported by Observer heartbeat monitoring.

| Event | Proactive delivery |
| --- | --- |
| Observer startup, task start, task terminal state | One concise informational message |
| Incident or new Analyst decision | Incident/hold card with bounded evidence |
| One policy-authorized low-risk infrastructure retry | Informational notice only; no approval challenge |
| Any other policy-allowed fresh retry | Ten-minute, single-use approval card bound to job, revision, incident, analysis, lane, and action |
| Ledger, Controller log, preflight, or heartbeat failure/recovery | Health alert or recovery message |
| Normal Worker/Reviewer/publish/merge-wait progress | No push; query it with `/harness` |

Single-lane commands:

```text
/harness
/harness status
/harness incident
/harness approve
/harness approve CHALLENGE
```

For multiple lanes, use `/harness <lane> [status|incident|approve [challenge]]`. Inline approval buttons call the same exact-bound approval CLI. **Keep blocked** consumes that challenge without creating recovery approval.

Transport choices:

| Mode | Observer configuration | Telegram update consumer | Use |
| --- | --- | --- | --- |
| Standalone Bridge (recommended) | Set `deliveryCommand` to Bridge `send-card` | Bridge | Current architecture; no Hermes callback dependency |
| Hermes compatibility | Omit `deliveryCommand`; configure `hermesBin`, `hermesProfile`, and `target` | Harness-specific Hermes Gateway | Existing installations only |
| No notification plane | Do not run Observer or Bridge | None | Core delivery remains fully functional |

One Bot Token can have only one `getUpdates` consumer. An existing dedicated Bot may be reused only after its previous consumer is stopped; a zero-interruption migration requires a second Bot. Keep the token in a mode `0600` file outside Git, never inline in JSON, a plist, or command arguments. The Bridge accepts exactly one allowlisted user in a private chat.

## Agent operating procedure

This section is an operating contract. Read all six steps before running a command. The README does not expand user authorization; a read-only request stops after `status`. Read state before acting. `run` and `tick` acquire an exclusive state-directory lease and reject a concurrent Controller. Replace uppercase command placeholders with values from the current machine.

### 1. Preflight

Copy [`harness.config.example.json`](./harness.config.example.json). Preserve its complete role arguments; replace only repository values, paths, provider/model selectors, and the validation command.

The runtime requires Node.js `>=22.16.0`, Git, GitHub CLI authenticated for the target repository, Herdr, Pi, `pi-subagents`, and Codex CLI. On first installation or after updating this repository, run:

```bash
npm ci
npm run build
pi install npm:pi-subagents
pi install /ABSOLUTE/PATH/HerdrHarness-lite
gh auth status
gh repo view OWNER/REPOSITORY
herdr session list --json
pi --list-models WORKER_PROVIDER
pi --list-models REVIEWER_PROVIDER
/ABSOLUTE/PATH/codex --version
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
```

Telegram is optional and is installed after this core preflight. Do not put a Bot Token in `harness.config.json`; the standalone Bridge owns its separate restricted token file and config.

If the configured named Herdr session is not running, start or attach it:

```bash
herdr session attach SESSION_NAME
```

Confirm every item:

- the `gh` identity can operate issues, pull requests, and labels in the target repository;
- `localPath` is the target clone and `baseRef` exists;
- `stateDir` and `worktreeRoot` are outside the product repository;
- the configured Herdr session reports `running: true`;
- Pi's current agent directory lists the selected Worker and Reviewer models;
- `analyst.argv` pins the real Codex CLI with `--codex-bin`;
- `status` reads the ledger; if `activeJob` exists, continue it instead of claiming another task.

Preflight is complete only when every check has real output and no identity, path, provider, or active-job uncertainty remains.

The Controller also performs automatic live preflight. Before it durably
selects a ready issue, it probes both configured Pi Providers and, when
`preflight.dockerRequired=true`, resolves and verifies the active local Docker
Unix socket plus Compose V2. It repeats the relevant Provider and Docker check
before each attempt pane is created. `preflight_failed` makes no claim or agent
dispatch; one-shot `tick` returns failure, while long-running `run` stays alive
and retries after the configured poll interval.

### 2. Start with manual `tick`

Use manual mode for the first real task:

```bash
node dist/src/cli.js tick --config /ABSOLUTE/PATH/harness.config.json
```

Each successful `tick` writes at most one durable transition. Continue from its result:

| Result | Next action |
| --- | --- |
| `idle` | No executable issue exists; stop or wait for the queue to change |
| `preflight_failed` | No agent was dispatched; `tick` returns failure, while long-running `run` keeps the safety gate closed and retries on its next poll |
| `selected`, `claimed`, `worktree_created` | Check the message, then run one more `tick` |
| `attempt_prepared`, `attempt_pane_ready`, `attempt_agent_ready` | Run one more `tick`; the next dispatch may remain attached for a long time |
| `attempt_reconciling` | The same Attempt identity is being observed once more; run one more `tick` and do not start another Controller |
| dispatch command has not returned | Wait; inspect with `status` and read-only Herdr commands only, and do not start a concurrent `tick` |
| `attempt_dispatched`, `attempt_completed`, `ci_recovered`, `base_refreshed`, `published`, `merged` | Run one more `tick` to consume the next stage |
| `publish_retry` | Correct the retryable publish condition named in the message, then run `tick` |
| `waiting_for_merge` | Wait for GitHub required checks/merge, then run `tick`; do not bypass GitHub |
| `blocked`, `analysis_recorded`, `waiting_for_approval` | Follow **Recover a blocked job** |
| `archived` | The slot is free; the next `tick` may select another issue |

For any other `ok:false`, run `status` first and correct the exact condition in the message. Repeating a command does not grant recovery authority.

Interactive dispatch calls Herdr `agent prompt --wait`. An RPC Attempt persists one `dispatch.json`; its pane runner sends the prompt once and waits for a terminal receipt. Either path may remain attached for a long run. Silence does not mean the prompt was lost and never authorizes a concurrent replay.

A manual step is complete when the ledger advanced exactly once or is intentionally waiting on an agent/external condition, with no concurrent Controller.

### 3. Inspect progress

Read the Harness ledger first:

```bash
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json --operator
```

When `activeJob.activeAttempt.executionSnapshot.adapter=herdr-pi-cli`, take the agent name from the handle and inspect Herdr:

```bash
herdr --session SESSION_NAME agent get AGENT_NAME
herdr --session SESSION_NAME agent read AGENT_NAME \
  --source recent-unwrapped --lines 40
```

The Pi footer shows the effective `(provider) model • thinking`. Configuration expresses intent; the live footer and a real probe establish the selected runtime.

An RPC Worker/Reviewer has no Herdr interactive-agent record. Inspect its ledger ExecutionSnapshot and the Attempt's `runtime/ready.json`, `accepted.json`, `terminal.json`, and `terminated.json` receipts. An assistant failure exposes only fixed `failureClass`, `retryable`, `failureStage`, and child `{code, signal}` fields. A runner failure additionally exposes allowlisted `failureDomain`/`failureCode`, a safe diagnostic fingerprint, and bounded lifecycle state; child stderr, Provider payloads, raw exception messages, and stacks remain excluded. Never try to reconnect or recreate the runner-owned stdin/stdout pipes.

Plain `status` returns the complete ledger. `status --operator` returns the stable operator projection: current mode/phase and only the actions that are valid for the exact revision, incident, analysis, Attempt, and HEAD bindings.

Inspection is complete when `activeJob.state`, `revision`, attempt ID/phase, effective provider/model, and whether the job is working, waiting, or blocked are all known.

### 4. Move to continuous `run`

After one manual end-to-end canary, start:

```bash
node dist/src/cli.js run \
  --config /ABSOLUTE/PATH/harness.config.json \
  --poll-ms 15000
```

Use `--max-cycles N` for a bounded trial. Without it, `run` is a foreground long-running process; this repository does not install a daemon. Closing the terminal that owns the process stops the Controller, so unattended deployments must use a service manager such as launchd or systemd. A durable Herdr pane does not replace the Controller service.

`run` and `tick` use the same Controller. A later cycle claims another eligible issue only after GitHub reports the PR merged and the job is archived. A blocked job holds the single active slot; `run` cannot bypass an Analyst hold or any required human approval.

Configuration is loaded once when `run` starts. Restart the process after changing a provider, model, thinking level, path, or validation command.

### 5. Recover a blocked job

Recovery starts from the live operator projection, not from a memorized mapping between incident classes and commands:

```bash
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json --operator
node dist/src/cli.js decide --config /ABSOLUTE/PATH/harness.config.json \
  --option DECISION_ID --actor OPERATOR --reason "Evidence checked; execute this exact option"
```

If `state=blocked` and no Analyst decision exists, run exactly one `tick`, then read `status --operator` again. The projection exposes only actions allowed by the current job, revision, incident, analysis, Attempt, and Git fixed point.

Two narrow infrastructure failures may receive one automatic fresh retry after the Analyst recommends that exact action. A Worker failure must be before prompt dispatch/acceptance, bound to the same base fingerprint, and have no Analyst unknowns. A Reviewer failure must have no result and remain bound to the same exact HEAD; review-outcome unknowns do not block this retry because the Controller independently rechecks the settled Attempt, clean tree, and unchanged HEAD. The Controller records the policy rule and consumed fingerprint in the ledger before acting. A repeated fingerprint or any failure outside these exact gates—including Worker failure after dispatch, CI rework, integrity/drift failure, or content decision—remains blocked for human action.

| Projected action | Human evidence required | Effect |
| --- | --- | --- |
| `approve_retry` | Explicit acceptance of the current Analyst fresh Worker/Reviewer recommendation | Records one bounded approval; Controller rechecks all bindings before creating a fresh attempt |
| `reassess` | The affected runtime, validation environment, or missing evidence changed and a bounded probe passed | Creates a successor incident and asks the Analyst again; grants no retry authority |
| `resolve_decision` | A concrete maintainer decision answering the projected final-round architecture question | Records `basis=human_decision` and prepares a fresh Worker brief with the decision and Reviewer findings |
| `cancel` | Explicit intent to retire the exact held pre-PR job | Archives it as cancelled and returns the issue to the ready queue on the next `tick` |

Operating sequence:

1. Stop continuous `run` before changing runtime or validation configuration.
2. Read `status --operator`; if it exposes no action you are authorized to take, stop.
3. Verify the evidence named by that action and obtain explicit human intent.
4. Run `decide` with the exact option ID and a concrete reason.
5. Read `status --operator` again, then continue with one `tick` at a time or restart `run`.
6. For a fresh attempt, verify the new agent identity and effective provider/model/thinking.

Option IDs are compare-and-swap bindings and become stale when any bound fact changes. Direct `approve`, `reassess`, `resolve-decision`, and `cancel` commands remain only for compatible integrations; interactive operators should use `decide`.

Same-Attempt reconciliation is automatic. It never replays a prompt or consumes the one-fresh-attempt policy budget. Recovery never resumes the old agent; a fresh Worker trusts committed work and durable results only. Integrity violations, stale identity, HEAD drift, forbidden actions, and unknown evidence remain blocked unless the live projection explicitly offers an action.

Recovery is complete only when the ledger records the chosen effect and the next permitted state is visible. It does not mean the GitHub issue is complete.

### 6. Agent completion and handoff

Only these facts support “the issue is complete”:

- the Worker durable result passed Git provenance verification;
- the Reviewer passed the exact HEAD;
- a PR was published;
- GitHub required checks and merge actually completed;
- the Harness observed the merge and archived the job.

If only recovery was completed, report the fresh attempt ID, lane, phase, and effective provider/model. Do not call the issue complete.

A handoff must include job ID, revision/state, issue, attempt ID, HEAD, PR, validations run, failures/skips, and the next permitted command.

## How the system works

### Sources of truth

| System | Authoritative facts |
| --- | --- |
| GitHub | Issue state, dependencies, queue labels, pull requests, required checks, and merge |
| Harness ledger | Claimed task/dependency snapshot, active job, revision, attempt, incident, Analyst advice, policy/human recovery authorization, and effect receipts |
| Git | Fixed base, implementation HEAD, commit provenance, and clean tree |
| Herdr / Pi | Worktrees, durable panes, and either interactive agents or the Worker/Reviewer RPC runner; execution and observability only |
| Observer / Telegram Bridge | No authoritative workflow facts; notification outbox and Telegram offset only |

No layer substitutes for another. Herdr `idle/done`, a Pi final reply, or a terminal screenshot is liveness evidence only; it cannot replace a durable result, Git verification, Reviewer decision, or GitHub merge.

### Normal state machine

```text
GitHub ready issue
  -> live Worker/Reviewer Provider and optional Docker preflight
  -> durable selection and claim
  -> task-bound Codex Analyst session
  -> isolated Herdr worktree
  -> fresh Pi Worker (interactive or RPC, selected by lane config)
  -> one focused self-check over the task diff
  -> durable result + Git verification
  -> fresh independent Pi Reviewer (interactive or top-level RPC)
      -> pass: publish PR
      -> changes: fresh Worker -> fresh Reviewer
  -> optional GitHub native auto-merge
  -> observe merge
  -> archive and release the slot
```

When safe progress is impossible:

```text
blocked incident
  -> bounded untrusted evidence
  -> Analyst advice
      -> hold: stop
      -> fresh retry recommendation
  -> deterministic Controller policy
      -> exact low-risk rule + unused fingerprint: record one automatic authorization
      -> otherwise: require exact human approval
  -> close old pane
  -> fresh Worker or Reviewer attempt
```

Operator presentation is a projection, not another state machine: `JobState + Incident + Analysis + live policy -> mode/phase + exact OperatorAction[]`. Adapters render these actions, while every write still passes through the Core recovery gates and ledger CAS.

Each `tick` performs at most one durable transition. A restarted process continues from the ledger instead of replaying an orchestration script.

### Role and information boundaries

| Role | When it runs | Information available | Authority and completion |
| --- | --- | --- | --- |
| Worker | Initial implementation, rework after actionable Reviewer findings, or approved Worker recovery | Immutable issue snapshot, task digest, base/branch, and an optional typed rework/recovery handoff | May modify the task worktree, validate, run one focused self-check, commit, and call `worker_submit`; cannot supply result identity, launch review subagents, push, or open a PR. Completion requires the Harness-bound durable result plus Git verification |
| Reviewer | After each Worker HEAD is accepted | Issue objective, fixed base, exact HEAD, Harness-generated Git evidence, and fixed validation argv | Has no generic shell/edit/write at the top level; preflights its real validation environment, independently reviews Standards and Spec, validates in a disposable copy, and returns `pass/changes/blocked` through `review_submit` |
| Analyst | A task-bound session starts after claim; it does not join the normal path and receives a decision turn only when blocked | Task snapshot, incident, and bounded ledger/Git/last-review evidence; may request at most `maxAnalystTurns` of whitelisted read-only evidence | May recommend `hold` or a policy-allowed fresh retry; cannot write state, mutate Git, operate Herdr, or approve itself |
| Human | Runtime/provider changes, risk acceptance, and recovery outside the narrow automatic allowlist | Exact revision, incident, analysis, and evidence | Sole authority for non-allowlisted retry approval; the Controller still rechecks policy, identity, and Git after approval |

Worker and Reviewer are separate top-level Pi agents. Review never continues inside the old Worker session.

### Attempt execution plan and context trust

Before any agent start or prompt side effect, each new Attempt persists an `ExecutionSnapshot + AttemptContextEnvelope + planDigest`. At selection, the task snapshot also binds the sorted GitHub dependency closure as `{number,state}` entries, so the Analyst and later Attempts see the same dependency facts that admitted the task; this is an immutable claim-time snapshot, not a live GitHub refresh. The execution snapshot binds the probed Pi executable/exact version, effective argv, role-resource/local-extension-closure digests, session/retry/compaction mode, Docker host, result channel, and explicit context manifest. The role-scoped envelope projects only identity, trusted authority digests, untrusted task data, exact Git target, bounded evidence, runtime selectors, and the allowed writeback contract into the final prompt. Restarts use only these bound values; plan, version, resource, environment, envelope, prompt, or bundle drift fails closed. A legacy snapshot-less running Attempt may only be observed. A legacy pre-dispatch Attempt cannot produce a new side effect.

Reviewer findings and approved recovery/CI decisions move through a versioned `TypedHandoff`, never a free-form continuation prompt. It binds source revision/digests and the next lane/base/HEAD, then moves atomically from `Job.pendingHandoff` into the next Attempt envelope. Handoffs and issue/evidence text remain untrusted task data: they can add obligations, references, and unknowns, but cannot widen tools, runtime, or repository-policy authority.

Pi context/session/prompt-template/theme discovery is disabled. The Harness reads at most one root policy directly from the `job.baseSha` Git object using Pi precedence (`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`), records path/mode/source SHA/digest, and injects a read-only bundle. A policy reference does not grant another candidate file instruction authority unless the Harness separately exports it into the manifest. The bundled Worker TDD adapter likewise treats candidate `CONTEXT.md`, ADRs, and rule files as data rather than ambient instructions. Candidate-Head rule files are review data for the top-level Reviewer and both fresh review-axis children. Pi CLI cannot disable only `SYSTEM.md` while retaining its default system prompt, so a `SYSTEM.md` in the bound user agent directory or candidate root blocks launch; the bound agent directory is explicitly injected into every Herdr pane.

With `workerRuntime=pi-rpc` or `reviewerRuntime=pi-rpc`, the Controller never owns RPC pipes. A foreground runner in the Herdr pane owns Pi stdin/stdout; the Controller writes O_EXCL intents and reads atomic receipts. The exact-version-pinned SDK host keeps settings and sessions in memory and keeps resources/context Attempt-bound. Worker uses the exact canonical `auth.json` pathname so subscription OAuth refresh shares Pi's normal lock. Reviewer instead captures strict-JSON bytes from the exact canonical `models.json`, requires their digest to match the execution plan, normalizes one supported standalone custom provider into a complete public `ProviderConfigInput`, and registers it through public `ModelRuntime.registerProvider` with an empty, non-persistent credential store. The normalization fills Pi-compatible model defaults, folds model overrides, and accepts only the deployed compat subset (`supportsStore`, `supportsDeveloperRole`, `requiresReasoningContentOnAssistantMessages`, and Pi 0.84 `thinkingFormat` values); built-in-provider overlays, OAuth providers, comments, and unsupported fields fail closed. The source file must be a private regular single-link file. Neither credential has a second disk file or link, appears in a receipt, or is returned to the Controller. The RPC Provider probe uses the same credential seam before selection and again before launch. The runner proves a fresh session, disables auto-retry and auto-compaction, and rejects credential/resource drift before accepting the prompt and after child exit. The runner accepts an explicit set of fully qualified exact Pi versions rather than one scattered hard-coded constant; the current qualified set is still only `0.84.0`, and every Attempt remains pinned to the exact inspected version. A new version blocks until its protocol and SDK behavior are tested and added to that set. `agent_settled` establishes only a runtime terminal; completion still requires the existing durable result and Git provenance. Reviewer RPC changes only the top-level Reviewer runtime; its two fixed review-axis children retain the existing immutable wrapper and capability ceiling.

### Review, rework, and Reviewer isolation

The Worker does not load `code-review` or receive `subagent`. Its bundled
`focused-self-check` performs one bounded pass over the current task diff;
the fresh Reviewer remains the only complete two-axis review.

The Reviewer receives a read-only snapshot of the exact implementation HEAD. It must first call `review_preflight`, which proves its source/validation paths, configured executable/version, and required Docker socket from inside the actual Reviewer process. Only then may it launch `subagent` once in the foreground, containing exactly one Standards child and one Spec child. Both children are limited to `read,grep,find,ls`. Their agent definition and subagent config are immutable Attempt-private snapshots resolved through a private project registry; user/candidate overrides, async defaults, and intercom injection are excluded. An immutable child-Pi wrapper rechecks the Attempt-bound runtime version immediately before each child and supplies an explicit empty append-system prompt, so a child cannot dynamically discover a global or candidate `APPEND_SYSTEM.md`. A failed preflight or failed, missing, or non-substantive axis cannot produce `pass` or `changes`.

`review_validate` executes the attempt-bound argv in a separate writable copy with a minimal environment and private cache/home/temp paths. Source, validation, state, and result paths are checked for two-way canonical overlap, including symlink aliases. `review_submit` atomically publishes the sole result outside the product worktree and cannot overwrite an existing result.

`worker_submit` likewise takes only outcome fields. The Harness-owned descriptor supplies job, attempt, lane, and result-path identity, and the atomic channel cannot overwrite an existing result.

If `reviewerValidationArgv` explicitly wraps its command with `/usr/bin/env
DOCKER_CONFIG=/absolute/path`, preflight reuses only that declared path so an
isolated HOME can find Compose plugins. Keep that directory credential-free;
the Harness does not copy the user's general Docker configuration.

This is a Pi tool-level write boundary, not an OS sandbox for malicious test code. Use a container or separate OS account when the validation command itself is untrusted.

Reviewer `changes` must contain actionable findings. The Harness binds those findings into a typed handoff for a fresh Worker, followed by a fresh Reviewer. Exhausted `maxReviewRounds`, missing findings, or incomplete evidence fails closed.

## Capabilities and boundaries

The Harness can:

- select the strict-frontier issue from one GitHub repository's `readyLabel` queue;
- create a durable claim and maintain one active job;
- create an isolated worktree and fresh Worker/Reviewer agents;
- bind each Attempt to an immutable execution snapshot and trusted context provenance;
- optionally run either top-level lane through the shared RPC adapter with one dispatch, structured terminal, and confirmed termination;
- verify durable results, Git provenance, exact review HEAD, and isolated Reviewer output;
- perform bounded rework plus one policy-authorized low-risk infrastructure recovery or a human-approved fresh recovery;
- publish a PR, request GitHub native auto-merge, observe merge, and claim another issue after archive;
- select provider/model/thinking independently for Worker and Reviewer.

The Harness does not:

- treat an agent reply, pane state, or uncommitted edits as completion;
- resume an old agent session or let the Analyst approve a retry;
- bypass branch protection, required checks, or GitHub's final merge decision;
- skip a blocked job occupying the active slot;
- schedule multiple active jobs concurrently;
- provide complete OS isolation for an adversarial validation command.

## Configuration reference

Treat [`harness.config.example.json`](./harness.config.example.json) as the single source of truth for complete role arguments. Do not reconstruct full argv from this README.

| Field | Meaning |
| --- | --- |
| `repo` | GitHub repository in `owner/name` form |
| `localPath` | Local clone used to refresh `baseRef` |
| `baseRef` | Target branch, usually `main` |
| `readyLabel` | Executable GitHub task label, for example `ready-for-agent` |
| `claimLabel` | Durable claim marker, for example `agent:claimed` |
| `stateDir` | Private ledger, events, Analyst receipts, attempt descriptors, Controller heartbeat, and exclusive lease |
| `worktreeRoot` | Root for Herdr task worktrees |
| `maxReviewRounds` | Maximum Reviewer/rework rounds |
| `maxAnalystTurns` | Maximum Analyst evidence turns |
| `preflight.piBin` | Pi executable used for bounded live Provider probes; defaults to `pi` |
| `preflight.dockerRequired` | Require local Docker daemon and Compose V2; bind only the resolved local Unix socket into Worker/Reviewer validation |
| `reviewerValidationArgv` | Fixed validation argv executed directly by the Harness without shell interpolation |
| `autoMerge` | Request GitHub native auto-merge after Reviewer pass |
| `workerRuntime` | `herdr-pi-cli` (default) or `pi-rpc`; RPC requires an explicit built-in `--provider`, exact built-in `--model`, and canonical subscription OAuth in private `auth.json` |
| `reviewerRuntime` | `herdr-pi-cli` (default) or `pi-rpc`; RPC requires an explicit custom `--provider`/`--model` backed by canonical private `models.json` |
| `workerArgv` / `reviewerArgv` | Pi role contracts validated by the Controller |
| `herdr.session` | Required named Herdr session |
| `analyst` | Command and arguments for the task-bound Codex Analyst wrapper |

Role contracts:

| Role | Required content | Tools | Thinking |
| --- | --- | --- | --- |
| Worker | `implement`, bundled `tdd`, bundled `focused-self-check`, and `worker-tools.js` | `read,bash,edit,write,grep,find,ls,worker_submit` | `high`, `xhigh`, or `max` |
| Reviewer | bundled `code-review`, bundled config isolator, explicit `pi-subagents`, and bundled `reviewer-tools.js` | `read,grep,find,ls,subagent,review_preflight,review_validate,review_submit` | `max` |
| Review-axis child | Fresh context with no inherited project context, skills, or extensions | `read,grep,find,ls` | `max` |

Worker and Reviewer both require `--no-approve --no-skills --no-session --no-extensions --no-context-files --no-prompt-templates --no-themes`. Worker loads only bundled `worker-tools.js`; Reviewer loads exactly the config isolator, `pi-subagents`, and `reviewer-tools.js` in that order. The Controller verifies skill/extension identity, exact tools, and bundled code. User-supplied runtime selectors are limited to `--provider` and `--model`; the Controller injects RPC `--mode rpc` and the explicit context bundle.

The Reviewer adapter is qualified against `pi-subagents` `0.42.1` exactly. Its two axes use one foreground `workflowScript`; the Harness accepts only a fixed `return await runs.all(<JSON>);` manifest and rejects the removed legacy `tasks` API or arbitrary script logic.

### Provider/model examples

Add or replace these selectors inside the example config's complete `workerArgv`, preserving every other required argument:

```text
"--provider", "openai-codex",
"--model", "gpt-5.6-luna",
"--thinking", "max"
```

Inside the complete `reviewerArgv`:

```text
"--provider", "baizhi-chat",
"--model", "deepseek-v4-flash",
"--thinking", "max"
```

The selections are independent. Automatic preflight makes one bounded live
call against each configured Provider before selection and repeats the current
lane before an attempt starts. For manual troubleshooting, confirm catalogs:

```bash
pi --list-models openai-codex
pi --list-models baizhi-chat
```

Bounded Worker probe example:

```bash
pi --no-session --no-approve --no-skills \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max \
  --tools read \
  -p "Read package.json and print only its name."
```

A Reviewer probe uses the same shape with its provider/model. `-p` and probe text are command-line probe inputs only and must not be added to role argv.

Pin the Analyst executable in `analyst.argv`:

```json
"--codex-bin", "/absolute/path/to/codex"
```

Service, SSH, and interactive-shell `PATH` values may differ, so prefer absolute binary and skill/extension paths.

## GitHub queue and auto-merge

The Harness selects only issues that are:

- `OPEN`;
- labelled with the configured `readyLabel`;
- unassigned;
- not blocked by an open dependency;
- absent from the durable ledger's processed set.

A parent issue with native sub-issues is a Map container and is never claimed. The first open executable child is the strict frontier. The task label may be `ready-for-agent`; no special `herdr-lite:ready` label is required. `claimLabel` only tells humans and automation that the Harness owns the task.

With `autoMerge` enabled, the Harness requests native auto-merge for the reviewed HEAD:

```text
gh pr merge --auto --match-head-commit <reviewed-sha> --merge
```

GitHub must allow auto-merge, and the target branch ruleset must define required checks. On PR HEAD drift or publish recovery, the Harness disables auto-merge before failing closed. It archives only after GitHub reports the PR merged.

If `baseRef` advances before publish, or while an open PR is waiting after required checks, the Controller suspends auto-merge, verifies the local and remote reviewed anchors, merges the new base into the clean task worktree without pushing, and requires a fresh Reviewer on the resulting exact HEAD. A merge conflict is aborted and fails closed for bounded Worker recovery; the Controller never resolves conflicts itself.

While the PR is open, the Controller reads GitHub's required checks for the exact reviewed HEAD. An explicit failed or cancelled check causes it to:

1. disable native auto-merge before changing ledger state;
2. record a `ci_failure` incident with check identity, state, link, and the bounded tail of `gh run view --log-failed` so the final error survives long setup logs;
3. retain the active slot and ask the task-bound Analyst for advice;
4. require exact human approval before each of at most two fresh Workers may rework the same branch;
5. verify that the remote branch still points to the previously reviewed PR HEAD, then require a fresh Reviewer before updating the same PR.

While a CI incident is blocked, newly completed failures on the same PR HEAD replace the stale incident and require fresh Analyst advice before approval.

The Controller does not auto-rerun CI or auto-rebase. If an operator reruns CI without changing the reviewed PR HEAD, a blocked job resumes only after every required check is pass/skipping on that exact HEAD; the CI rework count is not reset. A conflict-free base merge is only an integration refresh and must pass a fresh independent review plus GitHub CI. Each CI rework needs separate Analyst advice and exact human approval. A third required-check failure after two approved CI reworks becomes `ci_rework_exhausted` and permits only `hold` for code changes.

## State and audit data

`stateDir` contains:

- the single active-job snapshot and terminal-job summaries;
- compare-and-swap revisions and append-only save events;
- the exclusive Controller lease and liveness heartbeat;
- incidents, Analyst effect receipts, session identity, policy/human recovery authorizations, and reassessments;
- required-check failure evidence and the bounded CI rework count;
- per-attempt Reviewer source snapshots, validation copies, fixed-point evidence, descriptors, and external results.

Reassessment records survive terminal archive. If the exact task-bound Analyst session cannot be closed, a terminal job is not silently archived.

Never edit `state.json` or result JSON by hand.

## Development and verification

```bash
npm run typecheck
npm test
npm run verify
```

Tests use fake GitHub, Git, Herdr, and Analyst ports by default. Historical real canaries do not prove that providers, credentials, or GitHub rulesets are healthy now; operation and recovery require current live evidence.

Implementation entry points:

```text
src/model.ts       domain records and invariants
src/controller.ts  single-writer state machine
src/policy.ts      incident policy, operator projection, and result validation
src/recovery.ts    approval, reassessment, and cancellation gates
src/prompts.ts     Worker/Reviewer contracts
src/ports.ts       external boundaries
src/cli.ts         tick/run/status/recovery operator commands
src/hermes-observer.ts  ledger/log/heartbeat observation and retrying outbox
src/hermes-status.ts    bounded read-only Telegram views
src/hermes-approval.ts  exact, expiring Telegram approval challenge
src/adapters/      GitHub, Git, Herdr, Analyst, evidence, and state
```

For standalone Telegram delivery, safe Bot cutover, legacy Hermes compatibility, and multi-repository lanes, see [`integrations/hermes-telegram/README.md`](./integrations/hermes-telegram/README.md).

See [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md) for the complete state model and design analysis.
