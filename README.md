# HerdrHarness Lite

English | [简体中文](./README.zh-CN.md)

HerdrHarness Lite is a small, fail-closed controller for delivering GitHub issues. A durable state machine coordinates GitHub, Git, Herdr, fresh Pi Workers, independent Reviewers, and a Codex Analyst. Agent sessions, terminal output, and chat replies are never delivery truth.

This README has two reading paths:

- Agents installing, operating, inspecting, or recovering the Harness: start with **Agent operating procedure** and follow its steps and stop conditions.
- Humans understanding the system: start with **How the system works**, then read **Capabilities and boundaries**.

## Agent operating procedure

This section is an operating contract. Read all six steps before running a command. The README does not expand user authorization; a read-only request stops after `status`. Read state before acting, and allow only one Controller to write the ledger at a time. Replace uppercase command placeholders with values from the current machine.

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
dispatch; `run` exits so the operator can repair the environment and restart.

### 2. Start with manual `tick`

Use manual mode for the first real task:

```bash
node dist/src/cli.js tick --config /ABSOLUTE/PATH/harness.config.json
```

Each successful `tick` writes at most one durable transition. Continue from its result:

| Result | Next action |
| --- | --- |
| `idle` | No executable issue exists; stop or wait for the queue to change |
| `preflight_failed` | No agent was dispatched; repair the named Provider/Docker environment and rerun `tick`, or restart `run` |
| `selected`, `claimed`, `worktree_created` | Check the message, then run one more `tick` |
| `attempt_prepared`, `attempt_pane_ready`, `attempt_agent_ready` | Run one more `tick`; the next dispatch may remain attached for a long time |
| dispatch command has not returned | Wait; inspect with `status` and read-only Herdr commands only, and do not start a concurrent `tick` |
| `attempt_dispatched`, `attempt_completed`, `ci_recovered`, `base_refreshed`, `published`, `merged` | Run one more `tick` to consume the next stage |
| `publish_retry` | Correct the retryable publish condition named in the message, then run `tick` |
| `waiting_for_merge` | Wait for GitHub required checks/merge, then run `tick`; do not bypass GitHub |
| `blocked`, `analysis_recorded`, `waiting_for_approval` | Follow **Recover a blocked job** |
| `archived` | The slot is free; the next `tick` may select another issue |

For any other `ok:false`, run `status` first and correct the exact condition in the message. Repeating a command does not grant recovery authority.

Dispatch calls Herdr `agent prompt --wait` and may remain attached for the entire Worker or Reviewer run. Silence does not mean the prompt was lost.

A manual step is complete when the ledger advanced exactly once or is intentionally waiting on an agent/external condition, with no concurrent Controller.

### 3. Inspect progress

Read the Harness ledger first:

```bash
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
```

Take the agent name from `activeJob.activeAttempt.handle.agentName`, then inspect Herdr:

```bash
herdr --session SESSION_NAME agent get AGENT_NAME
herdr --session SESSION_NAME agent read AGENT_NAME \
  --source recent-unwrapped --lines 40
```

The Pi footer shows the effective `(provider) model • thinking`. Configuration expresses intent; the live footer and a real probe establish the selected runtime.

Inspection is complete when `activeJob.state`, `revision`, attempt ID/phase, effective provider/model, and whether the job is working, waiting, or blocked are all known.

### 4. Move to continuous `run`

After one manual end-to-end canary, start:

```bash
node dist/src/cli.js run \
  --config /ABSOLUTE/PATH/harness.config.json \
  --poll-ms 15000
```

Use `--max-cycles N` for a bounded trial. Without it, `run` is a foreground long-running process; this repository does not install a daemon.

`run` and `tick` use the same Controller. A later cycle claims another eligible issue only after GitHub reports the PR merged and the job is archived. A blocked job holds the single active slot; `run` cannot bypass an Analyst hold or human approval.

Configuration is loaded once when `run` starts. Restart the process after changing a provider, model, thinking level, path, or validation command.

### 5. Recover a blocked job

Start every recovery from exact state:

```bash
node dist/src/cli.js status --config /ABSOLUTE/PATH/harness.config.json
```

Record:

- `activeJob.revision`
- `activeJob.state`
- `activeJob.incident.id`, class, and lane
- `activeJob.analysis.id`, action, and summary
- `activeJob.activeAttempt.id`, lane, and phase
- `activeJob.headSha`
- `activeJob.ciFailure` and `activeJob.ciReworkCount`, when present

#### New block

When `state=blocked` and `analysis=null`, run exactly one `tick`. The Analyst receives a bounded evidence pack and records advice.

- `action=hold`: stop. A hold cannot be approved.
- `action=retry_fresh_worker` or `retry_fresh_reviewer`: present the evidence and advice to a human; run `approve` only after explicit human acceptance.

```bash
node dist/src/cli.js approve \
  --config /ABSOLUTE/PATH/harness.config.json \
  --revision REVISION \
  --incident INCIDENT_ID \
  --analysis ANALYSIS_ID \
  --actor OPERATOR \
  --reason "Evidence checked; approve one bounded fresh retry"
```

Approval is compare-and-swap protected. Continue with standalone ticks through `recovery_applied` and fresh-attempt preparation/dispatch. The Harness closes the old pane and never resumes the old agent.

Before approval, a blocked `infrastructure_exhausted` attempt with no recorded result is re-observed. If that exact attempt later produces a correctly bound durable result, the Controller runs the normal result and Git verification path instead of starting a fresh agent; an invalid or mismatched result remains fail-closed. This reconciles delayed delivery only and grants no recovery authority.

#### Maintainer resolved an exhausted architecture decision

`resolve-decision` is not a general override for Analyst `hold`. It is accepted only when the active, HEAD-bound Reviewer returned `changes` with a `major` or `critical` finding on the final allowed review round, and the Analyst held with unresolved questions. Record the concrete maintainer decision—not merely “retry”—in `--reason`:

```bash
node dist/src/cli.js resolve-decision \
  --config /ABSOLUTE/PATH/harness.config.json \
  --revision REVISION \
  --incident INCIDENT_ID \
  --analysis ANALYSIS_ID \
  --actor OPERATOR \
  --reason "Rerun-only supersedes ADR-0003; update the ADR and architecture, then validate the exact HEAD"
```

The ledger records `basis=human_decision` with the actor, decision, timestamp, revision, incident, and analysis bindings. The next `tick` consumes it into a fresh Worker brief containing both the decision and the blocking Reviewer findings. Any stale binding, non-final round, non-`changes` result, lower-severity-only finding, missing Analyst unknown, or HEAD mismatch fails closed.

#### Provider, Reviewer validation environment, or Analyst runtime repaired

Use `reassess` only when the incident is exactly one of these retryable cases:

- Worker/Reviewer `infrastructure_exhausted` with no durable result; or
- Reviewer `review_uncertain` with a durable `blocked` result bound to the current HEAD, after its external validation environment was repaired and probed; or
- `reviewer_preflight_dirty` discovered before the Reviewer received a pane/agent, after the residue was preserved or cleaned by an operator; or
- a pre-fix Worker `integrity_violation` where the completed result and observed worktree HEAD share the same seven-character prefix but differ only in the model-supplied suffix, after deploying and testing the Harness-owned HEAD resolver; or
- the first `ci_failure` remains bound to the current PR HEAD, after a previously missing or truncated external diagnostic was retrieved; or
- an Analyst execution failure recorded by the Controller itself.

Sequence:

1. stop continuous `run`;
2. change the failed role's provider/model, repair the Reviewer validation environment, or correct the Analyst executable;
3. pass one bounded probe under the affected isolation boundary;
4. if the old failure is not yet recorded, run `tick` until it becomes a blocked incident;
5. if the Analyst returned `hold` based on the old runtime, issue an exact `reassess`;
6. run one `tick` for the new Analyst decision;
7. if the new advice is a lane-matched fresh retry, obtain explicit human approval and run `approve`;
8. continue ticks until the fresh attempt is dispatched, or restart `run`;
9. verify the new agent's effective provider/model/thinking in the Herdr footer.

```bash
node dist/src/cli.js reassess \
  --config /ABSOLUTE/PATH/harness.config.json \
  --revision REVISION \
  --incident HELD_INCIDENT_ID \
  --analysis HELD_ANALYSIS_ID \
  --actor OPERATOR \
  --reason "Affected runtime changed and a bounded probe passed"
```

`reassess` requests new advice; it grants no retry authority. Stop if the new Analyst decision is still `hold`.

A fresh Worker retains committed work: it uses the same task worktree and receives a bounded recovery/rework brief based on the ledger's base or reviewed HEAD. Uncommitted agent state without a durable result is not trusted.

Integrity violations, stale task identity, HEAD drift, forbidden actions, and unknown evidence cannot become retryable through a config edit or repeated command. The sole compatibility migration is a legacy incident that misattributed pre-start residue to a Reviewer when the ledger proves no Reviewer handle was ever issued; exact `reassess` converts it to `reviewer_preflight_dirty`, still requiring fresh Analyst advice, human approval, and a clean-tree check before recovery.

To retire an exact held job before any PR exists, use `cancel` with the current revision, incident, analysis, actor, and reason. The next `tick` closes its pane, moves the claim label back to `readyLabel`, archives the old job as `cancelled`, and permits a new job to claim the issue. This preserves the integrity incident instead of converting it into retry authority.

```bash
node dist/src/cli.js cancel --config /ABSOLUTE/PATH/harness.config.json \
  --revision REVISION --incident INCIDENT_ID --analysis ANALYSIS_ID \
  --actor OPERATOR --reason "Retire this fail-closed run after correcting the runtime"
```

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
| Harness ledger | Active job, revision, attempt, incident, Analyst advice, human approval, and effect receipts |
| Git | Fixed base, implementation HEAD, commit provenance, and clean tree |
| Herdr / Pi | Worktrees, panes, and agent runtime; execution and observability only |

No layer substitutes for another. Herdr `idle/done`, a Pi final reply, or a terminal screenshot is liveness evidence only; it cannot replace a durable result, Git verification, Reviewer decision, or GitHub merge.

### Normal state machine

```text
GitHub ready issue
  -> live Worker/Reviewer Provider and optional Docker preflight
  -> durable selection and claim
  -> task-bound Codex Analyst session
  -> isolated Herdr worktree
  -> fresh Pi Worker
  -> one focused self-check over the task diff
  -> durable result + Git verification
  -> fresh independent Pi Reviewer
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
  -> exact human approval
  -> close old pane
  -> fresh Worker or Reviewer attempt
```

Each `tick` performs at most one durable transition. A restarted process continues from the ledger instead of replaying an orchestration script.

### Role and information boundaries

| Role | When it runs | Information available | Authority and completion |
| --- | --- | --- | --- |
| Worker | Initial implementation, rework after actionable Reviewer findings, or approved Worker recovery | Immutable issue snapshot, task digest, base/branch, and optional bounded rework/recovery brief | May modify the task worktree, validate, run one focused self-check, commit, and call `worker_submit`; cannot supply result identity, launch review subagents, push, or open a PR. Completion requires the Harness-bound durable result plus Git verification |
| Reviewer | After each Worker HEAD is accepted | Issue objective, fixed base, exact HEAD, Harness-generated Git evidence, and fixed validation argv | Has no generic shell/edit/write at the top level; preflights its real validation environment, independently reviews Standards and Spec, validates in a disposable copy, and returns `pass/changes/blocked` through `review_submit` |
| Analyst | A task-bound session starts after claim; it does not join the normal path and receives a decision turn only when blocked | Task snapshot, incident, and bounded ledger/Git/last-review evidence; may request at most `maxAnalystTurns` of whitelisted read-only evidence | May recommend `hold` or a policy-allowed fresh retry; cannot write state, mutate Git, operate Herdr, or approve itself |
| Human | Runtime/provider changes, risk acceptance, and recovery authorization | Exact revision, incident, analysis, and evidence | Sole authority for retry approval; the Controller still rechecks policy, identity, and Git after approval |

Worker and Reviewer are separate top-level Pi agents. Review never continues inside the old Worker session.

### Review, rework, and Reviewer isolation

The Worker does not load `code-review` or receive `subagent`. Its bundled
`focused-self-check` performs one bounded pass over the current task diff;
the fresh Reviewer remains the only complete two-axis review.

The Reviewer receives a read-only snapshot of the exact implementation HEAD. It must first call `review_preflight`, which proves its source/validation paths, configured executable, and required Docker socket from inside the actual Reviewer process. Only then may it launch `subagent` once in the foreground, containing exactly one Standards child and one Spec child. Both children are limited to `read,grep,find,ls`. A failed preflight or failed, missing, or non-substantive axis cannot produce `pass` or `changes`.

`review_validate` executes the attempt-bound argv in a separate writable copy with a minimal environment and private cache/home/temp paths. Source, validation, state, and result paths are checked for two-way canonical overlap, including symlink aliases. `review_submit` atomically publishes the sole result outside the product worktree and cannot overwrite an existing result.

`worker_submit` likewise takes only outcome fields. The Harness-owned descriptor supplies job, attempt, lane, and result-path identity, and the atomic channel cannot overwrite an existing result.

If `reviewerValidationArgv` explicitly wraps its command with `/usr/bin/env
DOCKER_CONFIG=/absolute/path`, preflight reuses only that declared path so an
isolated HOME can find Compose plugins. Keep that directory credential-free;
the Harness does not copy the user's general Docker configuration.

This is a Pi tool-level write boundary, not an OS sandbox for malicious test code. Use a container or separate OS account when the validation command itself is untrusted.

Reviewer `changes` must contain actionable findings. The Harness passes those findings as a bounded brief to a fresh Worker, followed by a fresh Reviewer. Exhausted `maxReviewRounds`, missing findings, or incomplete evidence fails closed.

## Capabilities and boundaries

The Harness can:

- select the strict-frontier issue from one GitHub repository's `readyLabel` queue;
- create a durable claim and maintain one active job;
- create an isolated worktree and fresh Worker/Reviewer agents;
- verify durable results, Git provenance, exact review HEAD, and isolated Reviewer output;
- perform bounded rework and human-approved fresh recovery;
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
| `stateDir` | Private ledger, events, Analyst receipts, attempt descriptors, and Controller heartbeat |
| `worktreeRoot` | Root for Herdr task worktrees |
| `maxReviewRounds` | Maximum Reviewer/rework rounds |
| `maxAnalystTurns` | Maximum Analyst evidence turns |
| `preflight.piBin` | Pi executable used for bounded live Provider probes; defaults to `pi` |
| `preflight.dockerRequired` | Require local Docker daemon and Compose V2; bind only the resolved local Unix socket into Worker/Reviewer validation |
| `reviewerValidationArgv` | Fixed validation argv executed directly by the Harness without shell interpolation |
| `autoMerge` | Request GitHub native auto-merge after Reviewer pass |
| `workerArgv` / `reviewerArgv` | Pi role contracts validated by the Controller |
| `herdr.session` | Required named Herdr session |
| `analyst` | Command and arguments for the task-bound Codex Analyst wrapper |

Role contracts:

| Role | Required content | Tools | Thinking |
| --- | --- | --- | --- |
| Worker | `implement`, `tdd`, bundled `focused-self-check`, and `worker-tools.js` | `read,bash,edit,write,grep,find,ls,worker_submit` | `high`, `xhigh`, or `max` |
| Reviewer | bundled `code-review` plus explicit `pi-subagents` and `reviewer-tools.js` extensions | `read,grep,find,ls,subagent,review_preflight,review_validate,review_submit` | `max` |
| Review-axis child | Fresh context with no inherited skills/extensions | `read,grep,find,ls` | `max` |

Worker and Reviewer both require `--no-approve --no-skills --no-extensions`. Worker loads only bundled `worker-tools.js`; Reviewer loads the two extensions declared by the example config. The Controller verifies skill/extension identity, exact tools, and bundled code. Optional runtime selectors are limited to `--provider`, `--model`, and `--no-session`.

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
- incidents, Analyst effect receipts, session identity, approvals, and reassessments;
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
src/policy.ts      incident policy and result validation
src/recovery.ts    approval, reassessment, and cancellation gates
src/prompts.ts     Worker/Reviewer contracts
src/ports.ts       external boundaries
src/cli.ts         tick/run/status/recovery operator commands
src/adapters/      GitHub, Git, Herdr, Analyst, evidence, and state
```

For one Telegram bot routing status and exact approvals across independent repository lanes, see [`integrations/hermes-telegram/README.md`](./integrations/hermes-telegram/README.md).

See [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md) for the complete state model and design analysis.
