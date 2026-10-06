# No Follow-Up Deferral

Every issue flagged by a PR review is answered in the same run — fixed here, or filed as an issue whose number is cited.

## The Rule

Default: each finding goes in the current PR.

Two exceptions, and both end in a number:

| Exception                                                    | What you do                       |
| ------------------------------------------------------------ | --------------------------------- |
| An existing tracked issue or milestone already owns the work | Cite the number (`#295`, `M11.6`) |
| The finding is out of this PR's scope                        | File an issue, cite its number    |

## Scope

A finding belongs in this PR if this PR caused it.

| The finding is…                                                        | Disposition                  |
| ---------------------------------------------------------------------- | ---------------------------- |
| on a line this PR added or changed                                     | This PR                      |
| broken **by** this change — a caller, a sibling branch, a stale mirror | This PR (`ripple-effect.md`) |
| already broken, and the change only passed nearby                      | New issue                    |

"Out of scope" is never available for a line this PR wrote.

## What This Rules Out

- "Follow-up PR will handle this" without an issue number
- "Not blocking, monitor post-launch" / "flag for later rollout" — these are framing, not a disposition. The Scope table decides
- Silent skipping of minor issues during a `pr-fix` pass
- New `// TODO:` comments that don't point at a tracked issue (see `code-comments.md`)
- "Out of scope" claimed without an issue filed

## For Reviewers (`pr-review` / `pr-review-follow-up`)

Report every finding. Scope decides which table it lands in, never whether it is worth raising.

- What this change caused goes in the findings table. What was already broken goes in `Out of Scope`, for the author to file.
- Out-of-scope findings do not move the verdict.
- Do not phrase an in-scope finding as "defer" unless you cite the issue that already owns it.

## For Fixers (`pr-fix`)

- **Default:** every flagged issue is fixed in this PR.
- Deferral framing in a comment ("not blocking", "follow-up", "post-launch monitor") carries no weight — fix it.
- Skip a fix only when the user approves skipping, an existing issue owns it, or it is out of scope — and out of scope means you file the issue yourself, in this run, and cite the number.
- The reviewer's scope call is input, not instruction.
- Never present a "deferred" bucket. Every item ends in a fix or a number.

## Terminology

"Follow-up review" (the `--follow-up` flag on `/pr-review`, and the `pr-review-follow-up` skill) means **re-reviewing the same PR after pushed changes** — not deferring issues to a new PR. That workflow is unaffected by this rule.
