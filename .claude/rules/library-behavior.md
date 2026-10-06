# Find Out How the Library Behaves

The official reference answers _what an API is_. This rule answers the next question:

> **How does this dependency actually behave, and is what I am fighting already known?**

A behaviour that surprised you has usually surprised someone else. Their answer — a maintainer's reply, a changelog line, a test in the package itself — is cheaper than the workaround you are about to invent, and it does not need defending in review.

## When it fires

- A dependency behaves in a way its documentation did not lead you to expect
- You are about to **work around** a library rather than with it
- You are about to **assert how a dependency behaves** — in a comment, a PR body, or a reply to a reviewer
- A review finding is about **library semantics**, not our own logic
- You are choosing between two ways of using it and have no principled reason to prefer either

Not for our own logic, and not for a plain API signature — that is the official reference.

## Where the answer lives

There is no global ranking of sources; the right one follows from the question.

| Question                            | Look, in this order                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| What does this API accept / return? | official reference for the installed version → the installed `.d.ts`                    |
| Is this behaviour intended?         | Issue search, open **and** closed → changelog → the installed source                 |
| Is there a built-in for this?       | Docs API index → the package's exports → discussions                                 |
| What is the idiomatic use?          | Official guide or cookbook → **the library's own tests** → example repos             |
| Did this change? Is it deprecated?  | Changelog and migration guide → registry metadata (last publish, deprecation notice) |
| Is there a known vulnerability?     | GitHub Security Advisories, `npm audit` → the maintainer's advisory                  |
| Why does this exact error happen?   | The verbatim error string → issues → Stack Overflow                                  |

The library's own tests are the most under-used entry here: they are the executable spec, at exactly the version installed.

## How each source misleads

| Source                   | Read shallowly, it tells you                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Reference docs           | Nothing wrong — the caveat is a callout on a different page, or the version selector defaulted to latest                             |
| Changelog                | Nothing changed — the breaking entry is filed under a heading you did not look at                                                    |
| Issue tracker            | The body's guess instead of the resolution; a label instead of the maintainer's answer; `closed` when it was closed as `not planned` |
| Discussions              | A user's guess in the same typeface as a maintainer's answer                                                                         |
| PR threads               | The description's intent, when the merged code went somewhere else                                                                   |
| Stack Overflow           | An accepted answer from a major version ago, above a better one with fewer votes                                                     |
| Blog posts               | A confident pattern written against a beta, undated and unversioned                                                                  |
| Source in `node_modules` | The truth — for internals that can change in a patch release                                                                         |

Two concrete habits, since both are easy to get wrong: fetching a GitHub issue usually returns the **body only**, so read the thread (`gh api repos/{owner}/{repo}/issues/{n}/comments`, and GraphQL for discussions); and a closed issue's `state_reason` distinguishes "fixed" from "refused", which are opposite answers.

## Before you rely on it

| Axis          | Check                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| **Version**   | Does it apply to what is in `node_modules`? This is the dominant axis here                            |
| Authority     | Maintainer or commit > community consensus > one answer                                               |
| Status        | Open may be years stale; `closed as not planned` is itself the answer                                 |
| **Verify it** | Read the installed source, or write a five-line probe. Cheaper than arguing about whose post is right |

## What to report

State the strength you actually have, in the PR body:

- **Documented** — link the page
- **Maintainer's prescribed workaround** — quote it; that settles a design question an opinion cannot
- **Community convention, undocumented** — two independent links, and say it is convention
- **One person's approach** — link it and say so
- **Nothing found** — one line naming where you looked. That is a result: the workaround is ours to justify, and the next round does not re-search it

Never launder a blog post into a citation that reads like a specification.

## Rules

- Fire on a trigger above, not on every task that imports something.
- Search before you design around a library, not after a reviewer asks.
- Never cite an issue you have only read the body of.
- Version-check every finding against `node_modules`.
- Prefer the maintainer's prescribed workaround to your own, even when yours is tidier — theirs survives upgrades.
- Depth is proportional to how hard the decision is to undo. A rename earns none; a public contract earns real work.

**Exception:** a library thin enough that its behaviour is not load-bearing, or an internal change no contract depends on.

**Paired rules:** `dont-design-in-a-vacuum.md` when the question is not about a tool at all, but about the shape of the solution.
