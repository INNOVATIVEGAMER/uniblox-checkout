# Recap

Explain recent work in plain language — what changed and _why_ — for a reader who wants to understand it without reading the diff. Read-only: this command summarizes, it never edits code.

Two registers, each kept short:

- **Product** — the problem, what the change does about it, and what it deliberately leaves alone. Named examples and analogies welcome.
- **Code** — which files/functions changed and what each one does, in everyday words. No framework jargon; when a term is unavoidable, gloss it in one clause.

## Input (Optional)

- **$ARGUMENTS**: what to recap, and/or which register to favour.

```
Examples:
  /recap                       → the work done so far in this conversation
  /recap latest commit         → the most recent commit (HEAD)
  /recap <sha> | HEAD~2        → a specific commit
  /recap PR 831 | the PR       → a pull request
  /recap product               → product angle only
  /recap code                  → simplified-code angle only
  /recap the staff thing       → drill into one concept
                                 (add "with a real user flow" for a step-by-step walkthrough)
```

## How to respond

1. **Resolve scope from $ARGUMENTS.** No argument → the changes made so far in this session. A commit/PR reference → read it first (`git show`, `gh pr view` / `gh pr diff`) and recap that, not your memory. A concept ("the staff thing") → cover only that slice.
2. **Pick the register(s).** Default to both — product first, then code — each a few short sentences or a small table. If the argument names one (`product` / `code`), give only that. If it asks to drill into one piece, drop the two-register structure and just explain that piece.
3. **Write for a non-technical reader.** Short sentences. No `useEffect` / `zod` / `RLS` / `JWT`-style terms without a plain-words gloss. Prefer a concrete example or analogy over an abstract description.
4. **Be honest about the edges.** Say what did _not_ change, what's out of scope, and what only takes effect later — the caveats are often the most useful part.
5. **For a "real user flow" request,** name the actors (e.g. "Riya, a support engineer"), walk one concrete path step by step, and point out exactly where the change matters.
6. **Match length to the question.** A one-concept drill-down is a few sentences; a full PR recap is a short product paragraph plus a small file-by-file table. Never pad.
