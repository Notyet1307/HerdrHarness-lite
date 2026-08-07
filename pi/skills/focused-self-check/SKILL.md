---
name: focused-self-check
description: One bounded Worker pass over its own task diff before the independent Harness Reviewer runs.
---

# Focused Worker self-check

Run this once after implementation and appropriate validation. This is not a
two-axis code review and must not launch subagents.

1. Re-read the issue objective and any bounded rework or recovery brief.
2. Inspect only the current attempt diff from the Harness-supplied attempt Base
   SHA, plus `git status` and `git diff --check`.
3. Check for concrete omissions against the issue, obvious correctness or
   error-handling mistakes in changed paths, accidental scope expansion, and
   uncommitted/generated residue.
4. Fix only concrete issues found in that diff and rerun the smallest affected
   validation. Do not start a repo-wide smell audit or speculative refactor.
5. Commit the final state and verify the worktree is clean. If a product or
   architecture decision is still required, return `blocked` instead of
   guessing.

The fresh independent Reviewer owns the complete Standards and Spec review.
