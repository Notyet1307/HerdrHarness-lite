# Analyst and Telegram operator v1

Status: implementation branch; not deployed

## Outcome

Give the task-bound Analyst enough bounded evidence to distinguish runtime,
Controller, worktree-progress, and verification failures. Expose the durable
diagnosis and exact operator actions through Telegram without making the Bot or
Analyst a workflow authority.

## Invariants

- Harness Core and its ledger CAS remain the only workflow authority.
- The Analyst remains read-only, tool-free, task-bound, and unable to approve.
- Telegram remains an allowlisted private-chat transport and never writes the
  ledger directly.
- Every mutating command starts a ten-minute, single-use challenge bound to the
  exact operator option. Confirmation calls `decide --option` and verifies the
  resulting durable effect.
- Existing `status`, `incident`, and `approve` commands remain compatible.

## Execution tasks

### Task 1: Deepen bounded evidence

- Capture committed, staged, unstaged, and untracked work separately.
- Add bounded attempt runtime receipts and recent attempt history.
- Add bounded Controller heartbeat and task-specific log evidence.
- Redact raw Provider messages, tokens, dispatch prompts, and ambient files.
- Test dirty-worktree coverage and secret exclusion.

### Task 2: Structure Analyst reasoning

- Add primary cause, confidence, contributing factors, preservation constraints,
  and falsifiable hypotheses to Analyst advice.
- Keep the structure optional for old ledger records.
- Validate lengths, enums, evidence references, and maximum item counts.
- Downgrade an unsupported or out-of-pack recommendation to `hold`.

### Task 3: Add read-only operator commands

- `/harness why` renders the durable structured diagnosis.
- `/harness evidence` renders the evidence digest, references, and unknowns.
- `/harness actions` renders only fresh operator-projection actions.
- Keep all output bounded and free of issue bodies, raw logs, and credentials.

### Task 4: Generalize exact decision challenges

- Preserve `/harness approve` as a retry alias.
- Add `/harness retry`, `reassess <reason>`, `resolve <reason>`, and
  `cancel <reason>`.
- Bind the challenge to option ID, revision, incident, analysis, attempt, and
  HEAD through the Core-owned option ID.
- Confirm through `decide --option`; verify approval, reassessment, or
  cancellation in the ledger before reporting success.

### Task 5: Keep the Bridge transport-only

- Route the new fixed command vocabulary without a shell.
- Pass operator reasons as one argv value; never interpret them as commands.
- Keep callback parsing, user/chat allowlisting, offset persistence, and Bot
  Token handling unchanged.

### Task 6: Verification and review

- Run `npm run verify` in both repositories from isolated worktrees.
- Review the exact diffs for secret exposure, stale-action behavior, backward
  compatibility, and destructive-action confirmation.
- Publish separate PRs for Harness Core and the standalone Bridge.
- Do not merge or deploy until the cutover window is approved.

## Deployment window runbook

1. Wait until no Worker or Reviewer attempt is running and no Telegram decision
   challenge is outstanding.
2. Record fresh Harness operator status, Controller heartbeat, Bridge offset,
   local/remote SHAs, and both LaunchAgent PIDs.
3. Merge the Harness PR and Bridge PR; verify their remote merge SHAs and checks.
4. Build Harness in a staging path and run both repositories' full verification.
5. Stop the Telegram Observer, Bridge, then Controller. Do not edit the ledger.
6. Replace deployed code/build artifacts and update configs only if the reviewed
   version requires it.
7. Start Controller, Bridge, then Observer; ensure only one Bot update consumer.
8. Run read-only canaries: `/harness status`, `why`, `evidence`, and `actions`.
9. On a disposable fixture lane, verify an expired challenge and a stale
   revision change no ledger state. Then verify one reassessment challenge.
10. Confirm the production Controller heartbeat, Bridge offset advance, and
    absence of Telegram `409 Conflict` or replayed historical notifications.
11. If any canary fails, restore the prior binaries/configs and restart in the
    same order; preserve the ledger and task worktrees throughout rollback.
