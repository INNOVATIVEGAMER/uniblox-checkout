# Code Comment Rules

## The Default Is No Comment

Most code carries no comments. A comment earns its place **only** when it
captures something a competent reader **cannot** recover from the code itself —
a non-obvious piece of product logic, or a genuinely complex mechanism whose
intent the code alone doesn't convey.

Before writing one, ask: _would a reader who already understands the code learn
anything from this that the code doesn't tell them?_ If no, don't write it.

## Never Comment What the Code Already Says

Do **not** annotate a property, field, parameter, type member, enum case, or
config/schema key with a comment that says **what it is**. The name and type
already say it; the comment is noise that drifts out of sync.

The same applies inside a function body: a comment that narrates the statement
beneath it ("loop over the sections", "return the total") adds nothing. Remove
it.

Keep a comment on a field or line **only** when it carries what the declaration
cannot — a non-obvious constraint, an easily-missed edge case, or _why_ a value
is what it is. If it merely restates the name, the type, or the operation on the
next line, delete it.

## When to Add Comments in Code

Only comment when the **logic itself** is non-obvious — not to explain design
decisions, tradeoffs, or rationale, and not to label what a symbol is.

| Situation                                                                                                    | Where it goes          |
| ------------------------------------------------------------------------------------------------------------ | ---------------------- |
| Non-obvious product or algorithmic logic (a cancellation guard, a bitwise trick, an easily-missed edge case) | Code comment           |
| Restating what a name, type, field, or adjacent line already says                                            | Nowhere — delete it    |
| Forward-looking placeholder for tracked follow-up work                                                       | `// TODO(#N):` in code |
| Tradeoff explanation ("why not X")                                                                           | PR comment             |
| Known limitation or architectural gap                                                                        | PR comment             |
| Design rationale or "why we chose this approach"                                                             | PR comment             |

## TODO Comments

Only add a TODO when it points at a **tracked issue or milestone** — `// TODO(#295):` or `// TODO(M11.6):`. A TODO without an issue number is not permitted: if the follow-up work isn't tracked, the work belongs in this PR (see `no-follow-up-deferral.md`).

Do not use TODOs to annotate known limitations, missing features with no scheduled work, or architectural gaps.

## Anti-Patterns

- Do not annotate a property, field, parameter, type member, enum case, or schema key with a comment that only says what it is — the declaration already says it
- Do not narrate the code beneath a comment ("loop over the sections", "build the payload") — the code is the narration
- Do not add multi-line comments explaining why a dev-only pattern is acceptable
- Do not document tradeoffs inline (e.g. "we use X not Y because...")
- Do not add "keep in sync" comments — if sync is required, enforce it at compile time instead
