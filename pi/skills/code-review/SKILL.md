---
name: code-review
description: Pi-adapted Matt Pocock two-axis code review using fresh foreground subagents for Standards and Spec; required for HerdrHarness worker self-review and independent reviewer attempts.
metadata:
  upstream: mattpocock/skills
  upstream-path: skills/engineering/code-review/SKILL.md
  adapter: pi-subagents
---

# Pi two-axis code review

Preserve the Matt Pocock `code-review` contract: review the committed diff from
one fixed point along two independent axes, **Standards** and **Spec**. This
file only adapts the subagent interface and Harness result handoff to Pi.

## 1. Pin the review identity

Use the Base SHA supplied by the Harness dispatch as the fixed point and the
supplied Head SHA (or current committed `HEAD` inside a worker self-review) as
the review target.

In a Worker self-review, run and record:

```bash
git rev-parse <base-sha>^{commit}
git rev-parse HEAD
git merge-base --is-ancestor <base-sha> HEAD
git diff <base-sha>...HEAD
git log <base-sha>..HEAD --oneline
```

Fail closed if the refs do not resolve, ancestry fails, the requested Head SHA
does not equal `HEAD`, or the three-dot diff is empty. A worker must create its
implementation checkpoint commit before this review.

In a top-level Reviewer attempt, generic shell access is unavailable. Read the
Harness-generated `review-evidence.txt` named in the dispatch instead. It binds
the Base SHA, exact Head SHA, ancestry, clean tracked state, commit list, and
three-dot diff. Missing or inconsistent evidence is a blocking gap.

## 2. Resolve evidence

Read repository standards such as `AGENTS.md`, `CONTRIBUTING.md`, and other
explicit coding-standard files. Resolve the issue/spec using
`docs/agents/issue-tracker.md` and the issue number supplied by the dispatch.
Fetch the issue before launching children and include the relevant spec text in
the Spec task. Missing spec or standards evidence is an explicit gap.

The Standards axis also uses this Fowler smell baseline as judgement calls,
never automatic violations; documented repository standards take precedence:

- Mysterious Name
- Duplicated Code
- Feature Envy
- Data Clumps
- Primitive Obsession
- Repeated Switches
- Shotgun Surgery
- Divergent Change
- Speculative Generality
- Message Chains
- Middle Man
- Refused Bequest

Skip checks already enforced by tooling.

## 3. Launch both axes once, fresh and foreground

Use one Pi `subagent` tool call with two tasks. Do not launch background work,
do not fork the parent conversation, and do not pass Harness dispatch IDs,
pane/agent handles, lifecycle commands, result paths, or controller state to
either child.

```text
subagent({
  artifacts: false,
  agentScope: "user",
  context: "fresh",
  async: false,
  tasks: [
    {
      agent: "herdr-harness-review-axis",
      task: "<self-contained Standards brief>"
    },
    {
      agent: "herdr-harness-review-axis",
      task: "<self-contained Spec brief>"
    }
  ]
})
```

Keep `artifacts: false`: child reports return inline to the parent without
writing `.pi-subagents/` debug files into the reviewed worktree. Do not replace
this with post-review deletion or a wider Harness Git allowlist.

The Standards brief must contain the fixed-point identity, diff evidence, commit list,
standards-source paths, the full smell list above, and these rules: cite every
documented-standard violation; label smells as judgement calls; repository
rules override smells; stay under 400 words.

The Spec brief must contain the same diff identity and commit list plus the
spec text. Report missing/partial requirements, incorrect implementation, and
scope creep, quoting the relevant requirement for each finding; stay under
400 words.

Both briefs must tell the child not to run project validation commands; the
parent owns the single recorded validation run.

If either child fails, is interrupted, returns no evidence, or does not finish,
the review is incomplete. Do not substitute the surviving axis or the parent's
opinion.

## 4. Aggregate without collapsing the axes

Keep the two reports under `Standards` and `Spec`. Do not merge or rerank across
axes. In a Worker self-review, run the required validation normally. In a
top-level Reviewer attempt, call `review_validate` exactly once; it runs the
Harness-configured argv in a disposable writable copy and returns the exact
exit status.

- In a Worker attempt, return the reports to the Worker. The Worker applies
  accepted fixes, commits the final clean state, then writes its own worker
  result. This skill never writes a reviewer result during worker self-review.
- In a top-level Reviewer attempt, never edit product source or write a result
  file directly. Call `review_submit` exactly once with only status, summary,
  and findings; the Harness-owned tool binds the job, attempt, lane, and exact
  reviewed Head SHA before writing the external result channel.

For a top-level Reviewer result:

- `changes` when either axis has an actionable blocking finding;
- `pass` only when both axes completed, validation succeeded, and neither axis
  has a blocking finding;
- `blocked` when evidence, spec, either axis, or required validation is
  incomplete;
- `failed` only for an unrecoverable execution failure.

Translate actionable findings into the Harness finding schema with severity,
summary, and concrete evidence. The durable JSON result is authoritative;
prose is only a summary.
