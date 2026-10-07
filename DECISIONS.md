# Decisions

This file records the decisions behind the service. Each material decision follows the brief's shape: Context, Options considered, Choice, Why, Consequences. The full design, with the invariant IDs (I#) and test IDs (T#) used below, is in [`architecture.html`](architecture.html).

Sections marked with an issue number are filled in by that issue, together with the code they describe.

## System invariants

_Consolidated table (I1–I15, where each is enforced, and the test that proves it): #7. Each issue adds the invariants it enforces._

- **I12 (a cart changes only while it is open):** PUT and DELETE lock the cart row `FOR NO KEY UPDATE` and require `status = 'open'`, in the same transaction as the write. That one guard covers `pending_payment` and `checked_out`. The T24 locked-status rows prove it; #3 adds the end-to-end versions.
- **I10 (money):** totals never go negative, `total = subtotal − discount`, and `discount = floor(subtotal × percent / 100)`. The pure functions are in `src/domain/money.ts`, and T27 proves them. The database CHECKs arrive with orders in #3.

## Ambiguities and chosen semantics

_Filled in by each issue as it resolves them: checkout (#3), coupons (#4), pending payments (#5)._

### Carts

- **"Add" and "change" are one PUT that sets the quantity.** The brief's "add an item" and "change its quantity" both map to `PUT /carts/:id/items/:productId { quantity }`. See the decision below.
- **The stock check at PUT is soft.** It compares the quantity with the stock at that moment, under no product lock, and reserves nothing. It exists to fail early with a useful 409. Checkout makes the authoritative check under the product lock (#3). The view's `available` flag tells the client when a line has gone short since.
- **A line holds at most 1000 units, and a cart at most 50 lines.** Both caps bound the money arithmetic (see Money). The quantity cap is in the PUT schema and a CHECK. The line cap is checked in the PUT, under the cart lock. Changing an existing line is never blocked by the line cap.
- **Prices are live.** Cart lines store no price. Each view reads the current price, and the order snapshots it once, at checkout.
- **Carts have no `updated_at`.** The architecture lists one, but nothing reads it, and a column with that name that never changed would mislead. Carts keep `created_at`.
- **The view's `orderId` and `coupon`, and `details: { orderId }` on the two locked-status errors, are not there yet.** No orders or coupons table exists. #3 adds `orderId`, and #4 adds `coupon` with the preview.

## Material decisions

### Decision: Stack

**Context:** The brief grades correctness under concurrent and repeated requests. Every claim about locking and transactions has to be testable for real, not simulated, and the whole thing has to be explainable line by line inside a 4–6 hour timebox.

**Options considered:**

- **In-memory store with a mutex.** Trivial, but it says nothing about multiple instances, which the brief asks about.
- **SQLite.** No row-level locks, so the concurrency design would be a different design.
- **PostgreSQL with Prisma.** It hides the locking clauses we need to show.
- **PostgreSQL with Drizzle.**

For HTTP, Express and Fastify were the alternatives to Hono. For validation, the alternatives were `@hono/zod-validator` and Hono's bare `validator()` with a hand-written zod call.

**Choice:**

- Node 22, TypeScript and Hono.
- PostgreSQL 16 in Docker Compose, with Drizzle as the ORM and migration tool.
- zod at every boundary, through `@hono/zod-validator` and one shared hook.
- Vitest against a real `checkout_test` database.

**Why:**

- **Postgres** gives us row locks, conditional updates, partial unique indexes and CHECK constraints, so the database enforces the invariants and the application code orchestrates.
- **Drizzle** keeps queries SQL-shaped: `FOR NO KEY UPDATE`, savepoints and conditional updates stay visible in the code a reviewer reads.
- **Hono** is small, and its `onError` lets one handler own the error envelope.
- **`@hono/zod-validator`:**
  - It maps header names back to the schema's own casing, which the checkout's `Idempotency-Key` header needs.
  - Its hook receives the request context, so the Content-Type check sits next to the parse.
  - Its default failure response is outside our envelope, which is why every route passes the shared hook.

**Consequences:**

- The test suite needs Docker running. It refuses any database whose name does not end in `_test`, because every test truncates every table.
- `fileParallelism: false`, because the test files share one database.

### Decision: Explicit app wiring

**Context:** Routes need the database, and later issues need the payment gateway and the config, which hold the TTL and the coupon values. The question is how they reach the routes, so that tests can build an app with a fresh database pool and a fake gateway.

**Options considered:**

- A module-level pool singleton.
- Hono context variables set by middleware.
- Factories that take their dependencies explicitly.

**Choice:**

- `createDb(config)` returns `{ db, pool }`.
- `createApp({ db })` mounts router factories such as `productsRoutes({ db })`. Each factory takes only what it uses.
- `createApp` gains `config` and `gateway` with #3, the first issue that has a use for them. #3 lists that wiring change.

**Why:**

- A test can build a second app with a different lock timeout next to the first one, which the `LOCK_TIMEOUT` test does.
- Each factory's signature says which dependencies it touches.
- No parameter exists before something reads it.

**Consequences:** `server.ts` and the test helper are the only places that assemble the graph.

### Decision: PUT sets the quantity, and DELETE is idempotent

**Context:** A client that times out on "add to cart" retries. The brief grades the service on repeated requests, and only checkout is meant to carry an idempotency key.

**Options considered:**

- `POST /carts/:id/items { productId, quantity }` that adds to the quantity, with an idempotency key on every cart write.
- `PUT /carts/:id/items/:productId { quantity }` that sets the quantity, and a `DELETE` that returns 404 for an absent line.
- The same PUT, and a `DELETE` that returns 200 for an absent line.
- For telling an add from a change: `INSERT … ON CONFLICT DO UPDATE` with `RETURNING (xmax = 0)`, or a plain SELECT under the cart lock followed by an INSERT or an UPDATE.

**Choice:**

- PUT sets the quantity: 201 when it adds the line, 200 when it changes it.
- DELETE of an absent line returns 200 with the cart.
- Both run in one READ COMMITTED transaction that first locks the cart row `FOR NO KEY UPDATE` and checks that the cart is open. PUT then reads the product (404, soft stock check), looks for the line, counts the lines if it is new (422 `CART_LINE_LIMIT`), and inserts or updates. The view is built in the same transaction.

**Why:**

- "Add 1 keyboard" sent twice gives 2 keyboards. "Set the keyboard quantity to 1" sent twice still gives 1. Every cart write is retry-safe without a key, and a retried DELETE gets the answer the first one got.
- The cart lock serialises every write to that cart's lines. So the existence check, the line count and the INSERT can't interleave with another request on the same cart: five identical PUTs give one 201 and four 200s (T8), and two new lines racing for the 50th slot give one 201 and one 422.
- `FOR NO KEY UPDATE` is enough, because only non-key columns change. It doesn't block the `FOR KEY SHARE` lock that a `cart_items` insert takes on its product row, so carts holding the same product never wait on each other.
- `xmax = 0` relies on a system column that Postgres doesn't document for this use, and the line cap would still need a count under a lock.
- At READ COMMITTED, each statement takes a fresh snapshot. A PUT that waited for the cart lock therefore sees the line that the previous holder inserted.

**Consequences:**

- A client can't add "one more" without knowing the current quantity. It reads the cart first.
- The 201 or 200 tells the client which case happened, but the body is the same cart view either way.

_Further decisions arrive with the issues that make them:_

- Row locks, lock order and READ COMMITTED: #3.
- The idempotency key table, with final and transient outcomes: #3.
- Atomic phases instead of an outbox: #3.
- The fake gateway: #3.
- The required price guard: #3.
- Coupon generation and the advisory lock: #4.
- Holding unknown payment outcomes: #5.
- The report snapshot: #6.

## Transaction, concurrency and idempotency strategy

_#3 (reserve, charge, finalize, lock order, key storage rule) and #5 (pending recovery)._

Every lock wait is bounded: the pool sets `lock_timeout` from `LOCK_TIMEOUT_MS` on every connection. A wait past that limit fails with Postgres error `55P03`, which the error handler maps to `503 LOCK_TIMEOUT`.

## Money and rounding rules

### Decision: Integer paise, floor once

**Context:** The brief requires money "without floating-point rounding errors", and discounts that are deterministic and never make a total negative.

**Options considered:**

- Decimal strings with a decimal library.
- Postgres `numeric`.
- Integer minor units.

For rounding, the options were round-half-up, banker's rounding, and floor.

**Choice:**

- Money is an integer number of **paise**, end to end. The API only sends `*Paise` integers.
- Every money column is `bigint`, read with Drizzle `{ mode: 'number' }`.
- The functions in `src/domain/money.ts`:
  - `lineTotal = unitPrice × quantity`
  - `subtotal = Σ lineTotal`
  - `discount = floor(subtotal × percentOff / 100)`, applied **once, at order level**
  - `total = subtotal − discount`

**Why:**

- **Integer arithmetic on safe integers is exact.** `Math.floor(n / 100)` is exact for any integer `n` below 2^53: IEEE division is correctly rounded, and `n / 100` is never within 0.01 of the next integer, while the rounding error is far below that.
- **The bounds keep every intermediate value safe.** A unit price is capped at 1,000,000,000 paise (₹1 crore, enforced by the PATCH schema), a line quantity at 1000, and a cart at 50 lines (`MAX_CART_LINES`, which the cart PUT enforces with 422 `CART_LINE_LIMIT`). So a full cart's `subtotal × 100` is at most 5 × 10^15, below 2^53 ≈ 9 × 10^15. Without the line cap, about 90 lines at the caps would pass 2^53. T27 includes a full cart at the caps.
- **Floor is deterministic and can't overshoot.** It favours the store by under one paisa. With `percentOff ≤ 100`, the discount never exceeds the subtotal, so the total is never negative.
- **The seed exposes a rounding slip.** The cable costs 34999 paise, so 10% off gives 3499 with floor and 3500 with `Math.round`. A rounding slip fails T27.

**Consequences:**

- Allocating the discount to individual lines (needed for partial refunds) is deferred.
- `bigint` columns read as JS numbers rely on the caps. Aggregates in the report (#6) cast with `::bigint` and `mapWith(Number)`, because node-postgres returns `int8` as a string.

## Error model

### Decision: One envelope, one table of codes

**Context:** The brief asks for errors that are "distinguishable and useful to an API client".

**Choice:**

- Every error is `{ error: { code, message, details? } }`.
- Each code's HTTP status, and whether a checkout stores it as the key's final answer, are defined once, in the `ERRORS` table in `src/errors.ts`. `new AppError(code, details)` reads both from it.
- The error handler maps the rest:
  - Hono's malformed-JSON exception becomes `VALIDATION_ERROR`.
  - A Drizzle query error whose Postgres code is `55P03` becomes `503 LOCK_TIMEOUT`.
  - Anything else becomes `500 INTERNAL`, logged with its Postgres code and constraint, and never returned to the client.
- Unknown routes use the same envelope (`404 NOT_FOUND`).
- Validation failures list each failing field in `details` as `{ path, message }`.

**Why:**

- Clients branch on a stable `code`, not on message text.
- One table means the stored error and the live error for a checkout can't disagree (#3).
- The status gives the class of problem:
  - 400: malformed.
  - 404: unknown resource.
  - 409: conflict with current state.
  - 422: semantically invalid.
  - 503: safe to retry.
- Hono's JSON validator silently reads a body with a non-JSON Content-Type as `{}`. Without an explicit check, that request would get a misleading "empty PATCH" error, so the shared validation hook rejects the Content-Type itself.

_The checkout codes and the final-versus-transient table: #3._

## Implemented versus deferred

_#7._

## Multiple instances and production scale

_#7._

## How AI tools were used

_#7._

## What I would examine with another two hours

_#7._

## Mutation log

Each test that guards an enforcement was run once with that enforcement removed, to confirm it fails.

| Removed                                                          | Test that fails                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| The Content-Type check in the validation hook                    | T25 rows "non-JSON Content-Type" and "missing Content-Type"   |
| `strictObject` on the PATCH body (plain `object`)                | T25 row "unknown field beside a valid one"                    |
| `lock_timeout` on the pool                                       | "returns 503 LOCK_TIMEOUT …" (the PATCH waits instead)        |
| `Math.floor` in `discount` (replaced with `Math.round`)          | T27 "floors the discount: the cable at 34999 …"               |
| The cart lock (`FOR NO KEY UPDATE`) in PUT and DELETE            | T8 gets `{201:1, 500:4}`: all five see no line, then four inserts hit the primary key (23505). The concurrent line-cap test gets `{201:2}` and 51 lines |
| The line count moved before the cart lock                        | The concurrent line-cap test gets `{201:2}`. T8 still passes, so the count needs its own test |
| The line-cap check                                               | T24 "allows the 50th line, rejects the next new line …" (201 instead of 422), and the concurrent line-cap test |
| The status guard in PUT and DELETE                               | All eight T24 locked-status rows                              |

On the barrier: with the cart lock present, every PUT blocks on `SELECT … FROM carts … FOR NO KEY UPDATE`. With it removed, every PUT blocks on the `INSERT INTO cart_items`, whose foreign-key check needs `FOR KEY SHARE` on the cart row that the barrier holds `FOR UPDATE`. So the barrier still lines the requests up, and they fail at the INSERT.

## Time spent

_#7._
