# Project Stage

This is a **take-home assignment**: greenfield, timeboxed to 4-6 hours, and judged
by reviewers who will read the code, run the tests, and then question the author
on any line of it. Nothing is deployed and nothing depends on this code.

## What This Means

- **No backcompat, ever.** No feature flags, shims, deprecation comments or
  `_unused` renames. Rename in place, delete what is unused.
- **Migrations:** each schema change is a new Drizzle migration. A committed
  migration is never edited, because the commit history is part of what is graded.
- **Correctness over breadth.** The invariants in `architecture.html` come first.
  A deferred feature recorded in `DECISIONS.md` beats a half-built one.
- **Explainable over clever.** The author must be able to predict every behaviour
  under concurrent and repeated requests in a live interview. If a mechanism needs
  a paragraph to defend, prefer the plainer one.
- **Every non-obvious choice lands in `DECISIONS.md`**, in the Context / Options /
  Choice / Why / Consequences shape the brief asks for.
