# PR Fix

Fix issues identified in PR reviews directly without agent delegation. You handle both root cause analysis and fixing yourself, following the pr-fix skill.

## Skill Used

| Skill                                                                  | Purpose                         |
| ---------------------------------------------------------------------- | ------------------------------- |
| [pr-fix-guide](../skills/pr-fix-guide/SKILL.md)                        | Root cause analysis + fix guide |
| [principal-architect.md](../agents/principal-architect.md) (reference) | Architectural thinking lens     |
| [sde2.md](../agents/sde2.md) (reference)                               | Code quality lens               |

## Required Input

- **PR Number**: $ARGUMENTS (e.g., `8`)

If no PR number provided, ask the user for it.

## Flow

```
+---------------------------------------+
|             /pr-fix 8                 |
+-----------------+---------------------+
                  |
                  v
+---------------------------------------+
|          Fetch PR Reviews             |
|  - Get PR details                     |
|  - Get reviews + inline (--paginate)  |
|  - Split at your last push            |
+-----------------+---------------------+
                  |
                  v
+---------------------------------------+
|      Root Cause Analysis (yourself)   |
|  - Read the code under the reviewers' |
|    Base Rules table                   |
|  - Research root causes               |
|  - Walk both lanes                    |
|  - Generalize: grep the class's sites |
|  - Look it up (gated)                 |
|  - Decide what you'll actually do     |
+-----------------+---------------------+
                  |
                  v
+---------------------------------------+
|        Fix Issues (yourself)          |
|  - TodoWrite: one todo per class      |
|  - Blocking first, then minor         |
|  - Verify fixes                       |
+-----------------+---------------------+
                  |
                  v
+---------------------------------------+
|  Report Completion — the ONLY output  |
+-----------------+---------------------+
```

---

## Execution

### Phase 1: Gather Review Context

**Do this yourself. Do NOT spawn any agents.**

1. **Fetch PR details:**

   ```bash
   gh pr view {pr_number} --json number,title,body,headRefName,baseRefName,author,url
   ```

2. **Extract GitHub issue** from PR body (`Closes #123`)

3. **Get all review feedback.** `--paginate` is not optional — both endpoints cap at 30 items, oldest first (skill → Step 1):

   ```bash
   # Resolve owner/repo
   gh repo view --json owner,name --jq '"\(.owner.login)/\(.name)"'

   gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews --paginate
   gh api repos/{owner}/{repo}/pulls/{pr_number}/comments --paginate
   ```

4. **Split them at your last push** — anything reviewed after it is this round's findings and is what you fix; anything before it is context for recurrence and for your own prior replies. If nothing was reviewed after it, there is nothing to fix — say so and stop.

   ```bash
   gh pr view {pr_number} --json commits --jq '.commits[-1].committedDate'
   ```

5. **Get changed files:**

   ```bash
   gh pr diff {pr_number}
   ```

### Phase 2: Root Cause Analysis

**Do this yourself. Do NOT spawn any agents.**

Read the pr-fix skill at `.claude/skills/pr-fix-guide/SKILL.md` and follow Part 1 (Root Cause Analysis):

**Load the Base Rules table from [pr-review-guide](../skills/pr-review-guide/SKILL.md).** You are reading existing code with a finding in hand and nothing written yet — the same activity the two reviewers perform on the same code, so read it against the same thirteen rows.

For EACH issue:

1. Read the relevant file(s) and surrounding code context
2. Understand what the reviewer is pointing at
3. **Research the root cause** — is it the line they flagged, or something deeper? What's the real shape of the problem?
4. **Walk it through both lanes** (skill → Step 3) — architect for boundaries, data model, contracts, security, scale; SDE2 for types, error handling, edge cases, redundancy, naming. One merged pass drifts to whichever lane you thought of first
5. **Generalize before fixing** (skill → Step 3) — name the pattern, grep for its other sites, and record every one in the plan's `Sites` column. Then ask what let them diverge: if someone could add a new wrong site tomorrow with no check failing, you are fixing instances, not the defect. An axis an earlier round already flagged is the strongest signal that the earlier fix was an instance patch
6. **Look it up** (skill → Step 4) — gated. A finding about how a dependency behaves is `library-behavior.md`; one about the shape of a mechanism the fix introduces is `dont-design-in-a-vacuum.md`. Validate before relying on it, and carry the result into your PR reply at the strength you have
7. **Decide the disposition** (skill → Step 3) — this PR, or a new issue. What this change caused is fixed here; what was already broken is filed now with `gh issue create`, so the number exists for the Done table
8. Decide what you'll actually do — agree with the reviewer, improve on their suggestion, or take a different tack

Do NOT blindly accept the reviewer's suggested fix. Research and reason from the code.

None of this reaches chat. The user verifies by reading the code, not a written analysis — the Done table at the end records what the analysis concluded.

### Phase 3: Fix Issues

**Do this yourself. Do NOT spawn any agents.**

Follow Part 2 (Fixing) of the skill:

1. Turn the analysis into a TodoWrite list — one todo per class, naming its sites. This replaces the printed plan; do not emit a plan table and do not wait on one
2. Fix blocking rows first, then minor — a class takes the highest severity among its sites
3. Fix issues one at a time but do NOT stop for user confirmation between fixes
4. Only pause if a fix is genuinely ambiguous or requires a new architectural decision — ask about that one fix, not the whole run
5. Verify all fixes with typecheck and lint at the end

### Phase 4: Report Completion

**This is the only thing you print.** One row per class, blocking first. No "Changes Made", no "Verification" section, no "Next Steps". Verification results go in one trailing line.

```markdown
## Done: #{pr_number}

| #   | Severity    | Pattern                    | Sites                           | Fix                        |
| --- | ----------- | -------------------------- | ------------------------------- | -------------------------- |
| 1   | ❌ Blocking | {the class, in one phrase} | `a.ts:42`, `a.ts:88`, `b.ts:17` | {what was done — one line} |
| 2   | ⚠️ Minor    | {the class, in one phrase} | `c.ts:78` (only site)           | {what was done — one line} |

Filed out of scope: #{n} ({one phrase})
Typecheck + lint: clean.
```

Drop the `Filed out of scope` line when nothing was filed.

`Sites` is every instance the grep found, not the one the reviewer named. A single-site finding says `(only site)`; a row that leaves the column implicit is a sweep that did not happen.

If typecheck or lint surfaced an issue that was then fixed, that's fine — report the final state (`clean`). If something is genuinely not clean, say so on that trailing line.

---

## Issue Priority

Fix issues in this order:

| Priority | Type     | Indicators                          |
| -------- | -------- | ----------------------------------- |
| 1st      | Blocking | "must", "required", REQUEST_CHANGES |
| 2nd      | Minor    | "consider", "suggestion", "nit"     |

## Error Handling

| Error                            | Action                               |
| -------------------------------- | ------------------------------------ |
| PR not found                     | Ask user to verify PR number         |
| No reviews found                 | Inform user, nothing to fix          |
| No reviews since your last push  | Inform user, nothing to fix          |
| Analysis disagrees with reviewer | Surface disagreement clearly to user |
| Fix requires new arch decision   | Ask user (no patches!)               |

## Important Notes

- **Architect-first thinking:** Read the actual code and reason from first principles -- reviewer suggestions are input, not instructions
- **One output:** Nothing reaches chat until the work is done — no raw-comment dump, no plan table, no progress narration. The exceptions are a one-line "nothing to fix" stop, and a short question about one genuinely ambiguous fix
- **Same lens as the review:** Part 1 reads the code against `pr-review-guide`'s Base Rules, through both lanes. The reviewers apply that table to your diff next round; applying it here, before the fix has a shape, is the pass that costs nothing
- **A finding is a class, not a line:** Grep for the pattern's other sites and fix all of them in this round. Widen along the finding's own axis, never onto an unrelated one
- **Terse output, not terse thinking:** The Done table is the whole of what you print — no root-cause prose, no rationale, no "issues addressed" narrative. The analysis behind it is unbounded
- **No patches:** Follow the plan; if a specific fix becomes ambiguous mid-flight, pause on that fix and ask
- **One at a time:** Fixes are applied incrementally (blocking first, then minor), but without stopping between them
- **Nothing is dropped, but not everything is this PR:** Every finding ends in a fix or an issue number. What this change caused is fixed here; what was already broken is filed. See `.claude/rules/no-follow-up-deferral.md`.
