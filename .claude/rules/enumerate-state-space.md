# Enumerate the State Space

When code branches on a finite set of states, enumerate the **whole set** and the **obligations each branch owes**, then check every cell. Filling only the cell you were pointed at leaves the rest to be discovered one at a time — one review round each.

## What counts

| State space                                         | Obligations each branch owes              |
| --------------------------------------------------- | ----------------------------------------- |
| Query status (`loading \| error \| empty \| ready`) | header, body, actions, screen-reader text |
| HTTP handler outcomes                               | status code, body shape, log line, metric |
| Tagged union / `match` arms / `switch` over an enum | same return shape, same invariants held   |
| Enum column values                                  | every reader, every CHECK, every label    |
| CLI exit paths                                      | exit code, stderr message, cleanup        |

Both axes must be closed sets. If you cannot write them down, it is not a state space and this rule does not apply.

## Anti-pattern: one cell per round

Round 1 gives the `error` branch a body. Round 2 finds `error` has no dismiss action. Round 3 finds `loading` has no actions either. Round 4 finds none of the non-`ready` branches carry a title. Every fix was correct; every one missed the shape of the defect.

## Correct pattern

Write the grid before touching code:

```
           header   body   actions   announced
loading      ok      ok      MISS       n/a
error       MISS     ok      MISS       MISS
empty        ok      ok      MISS       n/a
ready        ok      ok       ok        n/a
```

Fill every empty cell in one change. Report every empty cell as one finding.

## Rules

- Before changing one branch of a state machine, list every state and every obligation. Fix all the cells the change implicates, not the one that was reported.
- **When reviewing:** a finding on one branch is a finding on the axis. Enumerate the sibling branches and report them as a single finding covering N sites — never one site per round.
- Grep for sibling instances before reporting. Two queries in one file, two dialogs in one folder, two handlers on one route — the second instance is usually already there.
- When more than two cells are empty, report the grid rather than prose. It is shorter and it is checkable.
- A branch no caller can reach is a cell too. Confirm the state is enterable before building it out — an upstream gate may already handle it.

**Exception:** open-ended input — free text, an arbitrary error from a third party, an unbounded id space — has no closed set to enumerate. Give it a default branch and move on.

**Paired rules:**

- `ripple-effect.md` — the same instinct across _space_ (callers, callees, adjacent code). This rule covers _states_ at one branch point.
- `no-follow-up-deferral.md` — every cell is fixed in this PR. The grid is how you find them all at once instead of one per round.
