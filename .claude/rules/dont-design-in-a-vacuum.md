# Don't Design a Mechanism in a Vacuum

Before inventing the shape of a solution, find out how this **class of problem** is already solved.

> **Someone has run this in production and written down what broke.**

This rule is about shapes, not APIs: idempotency, outbox, locking, caching, pagination, permission models, migration strategy, retry and backoff, multi-tenancy. Their answers live in write-ups and standards, not in an issue tracker.

## When it fires

- You are introducing a **mechanism the codebase has no precedent for**
- The decision is **hard to undo** — schema, public contract, auth boundary, data model, anything users or other services bind to
- You are weighing two approaches with **no principled reason** to prefer either
- You are about to call something "the standard approach"

Not for ordinary product work inside a pattern the codebase already established, and not for anything reversible in an afternoon.

## Where the answer lives

| Question                                | Look                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| What is the standard shape for X?       | Engineering write-ups from teams who run it, reference architectures, books               |
| What does the spec actually require?    | The normative source — RFC, WHATWG, W3C, MDN — not a summary of it                        |
| What breaks in practice?                | Postmortems, "what we learned" posts, and the pattern's **critics**                       |
| Is this a known anti-pattern?           | Search the pattern by name; framework and database guides that argue against it           |
| How do comparable codebases do it?      | Open-source projects on the same stack; their tests and migrations show the real shape    |
| Is there a name for what I am building? | Naming it is most of the search — an unnamed mechanism is usually a named one in disguise |

A personal blog is a perfectly good source here, where it would be a poor one for library behaviour. The trade is that authority is weaker, so corroboration matters more.

## How these mislead

- A company write-up describes **their** scale, team and constraints — the pattern may be solving a problem we do not have
- A pattern named in a book may predate the tools that make it unnecessary
- Posts are often undated and rarely say what they would do differently now
- "Best practice" with no stated tradeoff is marketing; a source that names no downside has not run it
- One team's choice is not consensus, and the loudest write-up is not the most common practice

## Before you rely on it

| Axis              | Check                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context match** | Scale, consistency needs, team size, deployment model. The dominant axis here — a pattern that is right at a thousand writes a second can be dead weight at ten |
| Project stage     | `project-stage.md` — greenfield, timeboxed, judged by reviewers; clean shape over rollout scaffolding                                                            |
| Our constraints   | One Postgres, local Docker only, a 4-6 hour timebox, and every choice must be explainable in a follow-up interview                                           |
| Consensus         | Two independent, non-derivative sources — not one post and three that cite it                                                                                   |
| Cost to carry     | Who maintains this in six months, and what does it cost to remove if it is wrong                                                                                |

The commonest failure is not picking a bad pattern — it is picking a **correct pattern for a bigger problem than ours**.

## What to report

In the plan's Architecture Decision, then the PR body:

- **The shape chosen**, and the one or two it was chosen over
- **Why it fits us** in one line — the context axis that decided it, not a general endorsement
- **What it costs**, taken from the critics rather than the advocates
- **Nothing found** — say so and name where you looked. An unprecedented mechanism deserves a stated reason, not silence

## Rules

- Name the pattern before searching for it; the name is most of the search.
- Read at least one source that argues **against** the approach before committing to it.
- Prefer a pattern the stack already supports to one that needs new machinery.
- Depth is proportional to reversibility — a schema or a public contract earns real research; an internal helper earns none.
- Do not adopt a pattern for a scale we do not have. Cite the context that makes it fit.
- Do not present a single write-up as consensus.

**Exception:** a mechanism entirely internal to one module, cheap to replace, that nothing else binds to.

**Paired rules:** `library-behavior.md` when the question is how a specific dependency behaves rather than what shape to build. `project-stage.md` decides whether a pattern's safety machinery is worth carrying here at all.
