---
name: pr-fix-guide
description: Fix PR review issues directly without agent delegation. Combines root cause analysis and fixing into a single-agent flow.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Edit
  - Write
  - WebSearch
  - WebFetch
user-invocable: false
---

# PR Fix Guide

## Purpose

Fix issues raised in a PR review, start to finish, in one flow with no delegation.

Part 1 reads the code the way the two reviewers will — both lanes, the same rule table, while the fix has no shape yet. Part 2 writes the change.

**The analysis has no length limit. The output does.** Terseness is a property of what you print, never of how much you think.

## What Reaches Chat

One message, at the end: the Done table, any issues you filed, and the verification line. Nothing before it — no raw-comment dump, no plan table, no progress narration.

Two exceptions, each about one fix rather than the whole run:

| Case                                                                         | Output                        |
| ---------------------------------------------------------------------------- | ----------------------------- |
| Nothing was reviewed after your last push                                    | One line saying so. Stop      |
| A fix is genuinely ambiguous, needs an architectural call, or you decline it | One question or one statement |

The plan is real, it just isn't printed — it becomes the TodoWrite list that opens Part 2, which is where progress shows.

## Rules

The full ruleset lives in `.claude/rules/*.md` — those files are the spec. Don't try to keep all of them in working memory. Two lenses read them, at two different moments:

| Lens                                                                                           | When                 | What it is for                                                       |
| ---------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------- |
| **Base Rules** — [`pr-review-guide/SKILL.md`](../pr-review-guide/SKILL.md) → Base Rules        | Part 1, reading code | Deciding what the fix has to cover, before any of it is written      |
| **Reflex Check** — [`implement-guide/SKILL.md`](../implement-guide/SKILL.md) (Part 2 → Step 3) | Part 2, writing code | Catching what the edit itself smuggles in, at the moment you type it |

Base Rules is the same thirteen rows the reviewers will read your diff against. Load it in Step 3; never copy it here.

The Reflex Check fires on the action you are about to take. The same triggers fire when writing a fix patch as when writing fresh code — read it before each fix; open a full rule file only when a reflex actually fires.

Two reflexes specific to fixing (root-cause and don't-over-fix) live below in Part 2 → Fix Process.

`library-behavior.md` and `dont-design-in-a-vacuum.md` are the rules Part 1 invokes directly — see Step 4.

## Part 1: Root Cause Analysis

### Step 1: Gather Review Context

1. **Fetch PR details:**

   ```bash
   gh pr view {pr_number} --json number,title,body,headRefName,baseRefName,author,url
   ```

2. **Extract GitHub issue** from PR body (`Closes #123`)

3. **Get all review feedback.** `--paginate` is required — both endpoints cap at 30 items, oldest first.

   ```bash
   # Resolve owner/repo
   gh repo view --json owner,name --jq '"\(.owner.login)/\(.name)"'

   gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews --paginate
   gh api repos/{owner}/{repo}/pulls/{pr_number}/comments --paginate
   ```

4. **Split them at your last push.** Anything reviewed after it is unanswered; anything before it was answered by that push.

   ```bash
   gh pr view {pr_number} --json commits --jq '.commits[-1].committedDate'
   ```

   | Reviewed…            | Use it for                                                    |
   | -------------------- | ------------------------------------------------------------- |
   | after that timestamp | This round's findings — what you fix                          |
   | before it            | Context only — recurrence (Step 3) and your own prior replies |

   Read the earlier rounds; don't re-fix them. A finding you already declined, or answered differently than proposed, stays that way.

   If nothing was reviewed after your last push, there is nothing to fix. Say so and stop.

5. **Get changed files:**

   ```bash
   gh pr diff {pr_number}
   ```

### Step 2: Categorize Issues

Extract all issues from reviews and categorize:

| Category | Indicator                                       | Priority   |
| -------- | ----------------------------------------------- | ---------- |
| Blocking | "must", "required", "blocking", REQUEST_CHANGES | Fix first  |
| Minor    | "consider", "suggestion", "nit", COMMENT        | Fix second |

### Step 3: Analyze Root Causes — through the reviewers' lens

You are reading existing code with a finding in hand and nothing written yet — the same activity the two reviewers perform on the same code.

**Load the Base Rules table from [`pr-review-guide/SKILL.md`](../pr-review-guide/SKILL.md) and hold it over the code around each finding.** `enumerate-state-space.md` earns the most here — listing every state and every obligation is analysis work, and this is the moment for it.

For EACH issue:

1. **Read the relevant file(s)** and surrounding code context -- not just the flagged line
2. **Understand** what the reviewer is pointing at
3. **Research the root cause** -- is it the line they flagged, or something deeper? What's the real shape of the problem?
4. **Walk it through both lanes** in turn — a merged pass drifts to whichever you thought of first. Full definitions in `pr-review-guide` → Agent-Specific Focus.

   | Lane                | Ask of the code around the finding                                                                           |
   | ------------------- | ------------------------------------------------------------------------------------------------------------ |
   | Principal Architect | Does this cross a module boundary, a data model, an API contract, a security boundary? What scales badly?    |
   | SDE2                | Types, error handling, unhandled edge cases, redundancy, naming — what reads wrong to someone arriving cold? |

5. **Generalize before fixing** — the mirror of the reviewers' _Generalize Before Reporting_. A finding is a **class**, not a line.
   1. **Name the pattern** in one phrase — "query error renders as empty", "response literal duplicated across sibling routes", "enum arm missing from a switch".
   2. **Grep for it.** Sibling call sites, the other members of the enum, the other branches of the state machine, the other implementations of the interface.
   3. **Record every site** — in the todo while you work, in the Done table at the end. If the grep found one site, that is a result — say so.

   Then ask what let the sites diverge. **The test:** after your fix, could someone add a new site tomorrow that is wrong the same way, with no check failing? If yes, you are fixing instances, not the defect.

   | Shape                                                                                                                                | Fix                                                                 |
   | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
   | **Prose mirrors code** — a comment, docstring, prompt string, config example, doc, or PR body states what the code owns              | Delete the prose, or derive it from the source (`code-comments.md`) |
   | **A literal mirrors a definition** — a count, list, or set of names written out alongside the union, enum, or schema that defines it | Derive it from the definition                                       |
   | **A convention held by copy** — sibling call sites, modules, or branches each repeating a pattern nothing enforces                   | Enforce it in one place, or accept the copies and fix every one now |

   **Recurrence is the strongest signal.** If an earlier round flagged this same axis at a different line, the earlier fix was an instance patch. Escalate now rather than patching again.

6. **Decide the disposition** -- this PR, or an issue. What this change caused is fixed here; what was already broken is filed now, so the number exists for the Done table (`no-follow-up-deferral.md`):

   ```bash
   gh issue create --title "{one line}" --body "{what and where}"
   ```

7. **Decide what you'll actually do** -- this may agree with, improve on, or differ from the reviewer's suggestion
8. **Nothing is dropped** -- every finding ends in a fix or a number. No "deferred" bucket, and no weight given to "not blocking" framing.

Do NOT blindly accept the reviewer's suggested fix. Research and reason from the code.

### Step 4: Look It Up — gated

Skip this for most rounds. Our own logic, naming, dead code and comments have nothing to look up. It fires on two shapes, and which one decides where you look:

| The finding or fix is about…                                              | Rule                         |
| ------------------------------------------------------------------------- | ---------------------------- |
| how a dependency behaves — you are working around it, or it surprised you | `library-behavior.md`        |
| the shape of a mechanism the fix introduces                               | `dont-design-in-a-vacuum.md` |

Each rule maps the question to the source that answers it and to how that source misleads a shallow reader. Both end the same way: **validate before relying on it** — against the installed version for a library, against our own scale and stage for a pattern.

Carry the result into the PR reply at the strength you actually have. A link, and a quote where the source is authoritative, ends a disagreement in one round that an opinion would carry through three — and it is how you **decline** a suggestion without inviting another round.

---

## Part 2: Fixing

Turn the analysis into a TodoWrite list first — one todo per class, naming its sites. That list is the plan; it isn't printed, and you don't wait on it.

### Fix Process

**Before each change, run the Reflex Check from [`implement-guide/SKILL.md`](../implement-guide/SKILL.md) (Part 2 → Step 3).** Same triggers fire here — the reviewer comment is the _occasion_ for the edit, but the edit itself can still smuggle in a `useEffect` that orchestrates React state, a defensive existence check the schema already guarantees, a callback / mode-discriminator prop, a `// fix for X` comment, or a ripple gap downstream.

Two reflexes specific to fixing:

- _The reviewer flagged a symptom — is the symptom the root cause, or is the cause upstream?_
  -> Read enough surrounding code to find the cause, not just the flagged line. Fix the cause; the symptom resolves itself. The reviewer's suggested fix is **input, not instruction** — you may agree with it, improve on it, or differ.

- _About to fix the flagged line, plus "improve a few things while I'm here"?_
  -> Don't. Make the smallest change that **fully** addresses the comment — which, per Step 3, covers the class the finding is an instance of and every site the grep found, and nothing on a different axis. Cleanup on an unrelated axis belongs in its own PR.

1. **Fix blocking rows first, then minor.** A class takes the highest severity among its sites
2. **For each fix:**
   - Read the specific comment / inline-review thread fully — including any reviewer back-and-forth
   - Run the Reflex Check (above) at the moment of writing the change — same triggers, plus the two fix-specific ones

3. **Fix autonomously** -- do NOT stop for user confirmation between individual fixes

4. **Only pause if:**
   - The fix is genuinely ambiguous (the reviewer's intent is unclear)
   - The fix requires an architectural decision beyond the scope of the comment
   - A fix introduces a conflict with another pending fix

### Verify Fixes

1. **Run checks:**

   ```bash
   npm run typecheck
   npm run lint
   ```

2. **Review against original comments:**
   - Does each fix address the feedback?
   - Did every site the analysis found actually get changed?
   - Any unintended side effects?

3. **Fix any new issues introduced**

### Fix Output Format

One row per class, blocking rows first. No "Changes Made", no code snippets, no "Next Steps". Verification is one trailing line.

```markdown
## Done: #{pr_number}

| #   | Severity    | Pattern                    | Sites                           | Fix                        |
| --- | ----------- | -------------------------- | ------------------------------- | -------------------------- |
| 1   | ❌ Blocking | {the class, in one phrase} | `a.ts:42`, `a.ts:88`, `b.ts:17` | {what was done — one line} |
| 2   | ⚠️ Minor    | {the class, in one phrase} | `c.ts:78` (only site)           | {what was done — one line} |

Filed out of scope: #{n} ({one phrase}), #{n} ({one phrase})
Typecheck + lint: clean.
```

Drop the `Filed out of scope` line when nothing was filed.

**`Sites` is what Step 3 produced.** Every instance the grep found, not the one the reviewer named — one row per class, however many sites it spans. A single-site finding says `(only site)`; a row that leaves the column implicit is a sweep that did not happen.

If something is genuinely not clean, say so on that trailing line — don't pad the output with a verification section.

---

## Principles

1. **Architect-first thinking** -- understand root causes before fixing; reviewer suggestions are input, not instructions
2. **Address the actual feedback** -- read carefully, don't assume
3. **Follow loaded rules** -- `.claude/rules/` files are source of truth
4. **Terse output, not terse thinking** -- one table at the end is the whole of what you print; no root-cause prose, no rationale, no "issues addressed" narrative. The analysis behind it is unbounded
5. **One output** -- the Done table is the only thing you print. Pause mid-run only for a specific ambiguous fix or an architectural call, never to preview the plan
6. **No patches** -- proper solutions only
7. **Don't over-fix** -- widen along the finding's own axis (the class and its other sites, Step 3); change nothing on an unrelated axis while you are in there
8. **Research before fixing** -- if a fix involves a third-party library, verify correct usage via WebSearch
