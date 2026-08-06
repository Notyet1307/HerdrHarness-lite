# HerdrHarness Lite

English | [简体中文](./README.zh-CN.md)

HerdrHarness Lite is a small, fail-closed controller for delivering GitHub issues with fresh Pi Worker and Reviewer agents inside Herdr worktrees. It keeps workflow authority in a durable state machine instead of treating an agent session, terminal state, or chat response as delivery truth.

```text
GitHub ready issue
  -> durable claim
  -> task-bound Codex Analyst
  -> Herdr worktree
  -> fresh Pi Worker
  -> fresh independent Pi Reviewer
  -> pull request
  -> optional GitHub native auto-merge
  -> observed merge and archive
```

When work cannot continue safely:

```text
blocked incident
  -> bounded untrusted evidence
  -> Analyst advice
  -> exact human approval, when retry is allowed
  -> close the old pane
  -> fresh Worker or Reviewer attempt
```

## What the Harness guarantees

- Each `tick` performs at most one durable state transition.
- Worker completion is accepted only with a durable result and verified Git provenance.
- Reviewer pass is accepted only for the exact implementation HEAD and an allowed clean-tree result.
- Rework always uses a fresh Worker followed by a fresh Reviewer, up to `maxReviewRounds`.
- Analyst output is advice, never authority. A retry requires an exact human approval bound to the current revision, incident, and analysis.
- Infrastructure uncertainty, stale identity, evidence gaps, HEAD drift, and integrity violations fail closed.
- Provider changes apply only to future fresh attempts; a running agent is never silently changed or reused.

## Requirements

- Node.js `>=22.16.0`
- Git and GitHub CLI (`gh`) authenticated for the target repository
- Herdr with one named session running
- Pi with the required model/provider credentials
- `pi-subagents`
- Codex CLI for the persistent restricted Analyst wrapper

Install dependencies and build:

```bash
npm ci
npm run build
pi install npm:pi-subagents
pi install /absolute/path/to/HerdrHarness-lite
```

Start or attach the named Herdr session before running the Harness:

```bash
herdr session attach herdr-harness
herdr session list --json
```

## Configuration

Copy [`harness.config.example.json`](./harness.config.example.json) and replace every path with an absolute path.

Important fields:

| Field | Meaning |
| --- | --- |
| `repo` | GitHub repository in `owner/name` form |
| `localPath` | Local clone used to resolve and refresh `baseRef` |
| `baseRef` | Target branch, usually `main` |
| `readyLabel` | GitHub queue label, for example `ready-for-agent` |
| `claimLabel` | Durable GitHub claim marker; it is configurable, not hard-coded |
| `stateDir` | Private Harness state, event log, and Analyst receipts |
| `worktreeRoot` | Root for isolated Herdr task worktrees |
| `maxReviewRounds` | Maximum Reviewer/rework rounds |
| `maxAnalystTurns` | Bounded evidence turns allowed to the Analyst |
| `reviewerValidationArgv` | One fixed, shell-free validation argv run in a disposable copy |
| `autoMerge` | Request GitHub native auto-merge after an exact Reviewer pass |
| `workerArgv` / `reviewerArgv` | Native Pi arguments validated as role contracts |
| `herdr.session` | Required named Herdr session |
| `analyst` | Command and arguments for the Codex Analyst wrapper |

The Controller validates the role contracts before doing work:

| Role | Required skills | Tools | Thinking |
| --- | --- | --- | --- |
| Worker | `implement`, `tdd`, bundled `code-review` | read/write implementation tools plus `subagent` | `high`, `xhigh`, or `max` |
| Reviewer | bundled `code-review` only | `read,grep,find,ls,subagent,review_validate,review_submit` | `max` |
| Review-axis child | none inherited | `read,grep,find,ls` | `max` |

Both roles require `--no-approve --no-skills`. Reviewer additionally requires `--no-extensions` and exactly two explicit extensions: the declared `pi-subagents` package entrypoint and the bundled `reviewer-tools.js`. Skill/extension identity, Matt Pocock installer provenance, exact tools, and the bundled review code are checked. Only `--provider`, `--model`, and `--no-session` are allowed as optional runtime selectors; session reuse, prompt injection, ambient extensions, and wider tools are rejected.

Each Reviewer gets a read-only exact-HEAD source snapshot. Its `subagent` call is restricted to exactly two fresh `herdr-harness-review-axis` children, with a runtime ceiling of `read,grep,find,ls`; management actions and other agent profiles are blocked. `review_validate` runs the fixed argv once in a separate writable copy with private cache/home paths; `review_submit` alone writes the identity-bound result outside the product worktree. This is a Pi tool boundary, not containment for malicious test code: use a container or separate OS account if the validation command itself is adversarial.

### Explicit provider and model selection

Provider/model selection belongs in the role's native Pi argv. This example pins only future Reviewer attempts to Baizhi Chat and DeepSeek V4 Flash:

```json
{
  "reviewerArgv": [
    "--no-approve",
    "--no-skills",
    "--no-extensions",
    "--extension",
    "/absolute/path/to/.pi/agent/npm/node_modules/pi-subagents/index.ts",
    "--extension",
    "/absolute/path/to/HerdrHarness-lite/pi/extensions/reviewer-tools.js",
    "--provider",
    "baizhi-chat",
    "--model",
    "deepseek-v4-flash",
    "--skill",
    "/absolute/path/to/HerdrHarness-lite/pi/skills/code-review",
    "--tools",
    "read,grep,find,ls,subagent,review_validate,review_submit",
    "--thinking",
    "max"
  ]
}
```

Confirm the model exists in Pi's current catalog:

```bash
pi --list-models baizhi-chat
```

Run a bounded ephemeral probe before recovering from a provider outage:

```bash
pi --no-session --no-approve --no-skills \
  --provider baizhi-chat \
  --model deepseek-v4-flash \
  --thinking max \
  --tools read \
  -p "Read package.json and print only its name."
```

Do not put `-p` or probe text in `reviewerArgv`; they are rejected by the Harness. A config edit does not mutate an already-running attempt. Each standalone `tick` process reloads the config, but a continuous `run` process keeps the config loaded at its own startup. After changing provider settings, stop and restart `run` before any Controller transition creates the fresh Reviewer.

To verify what a running Pi actually selected, get `activeJob.activeAttempt.handle.agentName` from `status`, then inspect its recent Herdr output:

```bash
node dist/src/cli.js status --config /absolute/harness.config.json
herdr --session herdr-harness agent get AGENT_NAME
herdr --session herdr-harness agent read AGENT_NAME \
  --source recent-unwrapped --lines 40
```

The Pi footer shows the effective `(provider) model • thinking` selection. Treat this runtime display and a real probe as evidence; the config file alone does not prove provider health.

## GitHub setup

The Harness selects only issues that are:

- `OPEN`;
- labelled with the configured `readyLabel`;
- unassigned;
- not blocked by an open dependency;
- not already present in the durable Harness ledger.

A parent issue with native sub-issues is a Map container and is never claimed. The first open executable child is the strict frontier. The queue label can be `ready-for-agent`; no special `herdr-lite:ready` label is required. The configured `claimLabel` is for humans and automation to see that the Harness owns the task.

Authenticate and check the repository before the first run:

```bash
gh auth status
gh repo view owner/repository
```

If `autoMerge` is enabled, GitHub must allow auto-merge and the target branch ruleset must contain the intended required checks. The Harness never replaces branch protection.

## Commands

```bash
node dist/src/cli.js status --config /absolute/harness.config.json
node dist/src/cli.js tick --config /absolute/harness.config.json
node dist/src/cli.js run --config /absolute/harness.config.json \
  --poll-ms 15000
```

### Manual `tick` mode

Run the same `tick` command repeatedly. Each successful call advances one durable stage, such as claim confirmation, worktree creation, attempt preparation, pane creation, agent start, result acceptance, publish, merge observation, or archive.

The dispatch-stage `tick` intentionally calls Herdr with `agent prompt --wait`. It may remain attached for the entire Worker or Reviewer run. No output during that period does **not** mean the prompt was lost. Inspect the owned Herdr agent if needed; do not launch another `tick` merely because the first command is still waiting. After it returns, the next `tick` consumes and verifies the durable result.

### Continuous `run` mode

`run` calls the same Controller loop and sleeps between cycles:

```bash
node dist/src/cli.js run \
  --config /absolute/harness.config.json \
  --poll-ms 15000
```

Use `--max-cycles N` for a bounded manual test. Without it, `run` is a foreground continuous process; use `Ctrl-C` or an external service supervisor to stop it. The repository does not install a daemon by itself. Configuration is loaded once when that process starts, so restart `run` after changing a role's provider, model, or thinking level.

After a reviewed PR merges and the job is archived, the next cycle may claim the next eligible issue. A blocked job stays in the single active slot and cannot be skipped. `run` may keep polling, but it cannot bypass an Analyst hold or human approval gate.

## Normal review and rework

1. A fresh Worker implements and commits against the fixed base.
2. A fresh Reviewer independently checks Standards and Spec against the exact HEAD.
3. `pass` moves to publish.
4. `changes` with actionable findings creates a fresh Worker with a bounded findings brief, then another fresh Reviewer.
5. Exhausting `maxReviewRounds`, missing findings, incomplete evidence, or an uncertain review becomes a blocked incident.

Worker and Reviewer are separate top-level Pi agents. Review never continues inside the old Worker session.

## Failure recovery

Start every recovery from the durable state:

```bash
node dist/src/cli.js status --config /absolute/harness.config.json
```

Record these exact fields:

- `activeJob.revision`
- `activeJob.state`
- `activeJob.incident.id` and class/lane
- `activeJob.analysis.id` and action
- `activeJob.activeAttempt`
- `activeJob.headSha`

### 1. Ask the Analyst to diagnose a new block

If the job is `blocked` and `analysis` is `null`, one `tick` creates a bounded evidence pack and records Analyst advice:

```bash
node dist/src/cli.js tick --config /absolute/harness.config.json
```

The Analyst may request whitelisted read-only evidence, recommend one policy-allowed retry, or return `hold`. It cannot write controller state, mutate Git, operate Herdr, or approve itself.

### 2. Approve an allowed retry

Only approve when the current analysis action is `retry_fresh_worker` or `retry_fresh_reviewer` and you accept the evidence:

```bash
node dist/src/cli.js approve \
  --config /absolute/harness.config.json \
  --revision 23 \
  --incident incident-id \
  --analysis analysis-id \
  --actor operator-name \
  --reason "Evidence checked; approve one bounded fresh retry"
```

The command is compare-and-swap protected. Any changed revision, incident, or analysis is rejected. Approval records authority only. A later Controller tick rechecks policy and Git, closes the old pane, and creates a fresh attempt; it never resumes the old agent.

### 3. Reassess a held Worker or Reviewer provider failure

`hold` cannot be approved. If and only if the held incident is an exact Worker or Reviewer `infrastructure_exhausted` failure with no durable result, and the environment has materially changed:

1. stop the existing continuous `run` process, if any;
2. fix or switch the affected role's provider/model;
3. run a bounded ephemeral provider probe;
4. request a new Analyst decision with `reassess`.

```bash
node dist/src/cli.js reassess \
  --config /absolute/harness.config.json \
  --revision 21 \
  --incident held-incident-id \
  --analysis held-analysis-id \
  --actor operator-name \
  --reason "Affected role provider changed and an ephemeral read-tool probe passed"
```

`reassess` preserves the old revision/incident/analysis plus actor and bounded reason in the audit record, marks the operator statement as untrusted evidence, creates a successor incident with a fresh receipt key, and clears the old analysis. It does not grant retry authority, close/start an agent, or touch Git.

Run one standalone `tick` for the new Analyst decision. If it again returns `hold`, stop. If it recommends the lane-matched `retry_fresh_worker` or `retry_fresh_reviewer`, issue a new exact `approve` command for the new revision/incident/analysis. Continue with standalone ticks or start a new `run` process; either path now loads the changed provider configuration.

### 4. Failures that must remain stopped

Integrity violations, stale task identity, Analyst unavailability, forbidden actions, HEAD drift, and unknown evidence cannot be converted into retry authority by changing JSON or repeating commands. Keep them held until the underlying facts are corrected through an explicit supported path.

Never edit `state.json` or result JSON by hand. The snapshot, compare-and-swap revision, effect receipts, result identity, and Git checks form one trust boundary.

## Auto-merge and the next issue

With `autoMerge: true`, publish requests:

```text
gh pr merge --auto --match-head-commit <reviewed-sha> --merge
```

Required checks and final merge remain GitHub decisions. The Harness observes the PR; if its HEAD drifts, it disables auto-merge before failing closed. It archives only after GitHub reports the PR merged. A continuous `run` can then select the next eligible issue.

## State and audit data

`stateDir` contains:

- the single active job snapshot and terminal job summaries;
- compare-and-swap revision state;
- append-only save events;
- Codex Analyst effect receipts and session identity.
- per-attempt Reviewer snapshots, disposable validation copies, fixed-point evidence, descriptors, and external results.

Reassessment audit records survive terminal archive. The Analyst runs from its private state directory and receives only bounded untrusted task/evidence packets. Failure to close the exact recorded Analyst session keeps the terminal job unarchived.

## Development and verification

```bash
npm run typecheck
npm test
npm run verify
```

The tests use fake GitHub, Git, Herdr, and Analyst ports by default. Real canaries have also exercised named Herdr sessions, fresh Pi Worker/Reviewer agents, persistent Codex Analyst receipts, exact-SHA review, PR publication, native auto-merge observation, and terminal archive. Those canaries are historical evidence, not proof that a provider or GitHub setting is currently healthy; verify live runtime state before recovery.

The implementation stays intentionally small:

```text
src/model.ts       domain records and invariants
src/controller.ts  single-writer state machine
src/policy.ts      incident policy and result validation
src/recovery.ts    exact approval and reassessment gates
src/prompts.ts     Worker/Reviewer contracts
src/ports.ts       external boundaries
src/cli.ts         tick/run/status/approve/reassess
src/adapters/      GitHub, Git, Herdr, Analyst, evidence, state
```

See [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md) for the full state model and design analysis.
