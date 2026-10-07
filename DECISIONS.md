# Decisions

This file records the decisions behind the service. Each material decision follows the brief's shape: Context, Options considered, Choice, Why, Consequences. The full design, with the invariant IDs (I#) and test IDs (T#) used below, is in [`architecture.html`](architecture.html).

Sections marked with an issue number are filled in by that issue, together with the code they describe.

## System invariants

_Consolidated table (I1–I15, where each is enforced, and the test that proves it): #7. Each issue adds the invariants it enforces._

- **I1 (stock never goes below zero):** reserve locks the cart's products `ORDER BY id FOR NO KEY UPDATE` and checks every line before it decrements anything. `CHECK (stock >= 0)` is the backstop. T1 and T2.
- **I2 (a cart has at most one live order):** reserve locks the cart and requires `status = 'open'`. The partial unique index `orders_live_cart_uq` (`cart_id WHERE status <> 'failed'`) is the backstop. T5.
- **I3 (a retried checkout never creates a second order or charges twice):** the key is claimed as reserve's first statement, and a key that has an order or a stored response is replayed. The fake gateway's charges are idempotent per order ID. The key's primary key and `UNIQUE (order_id)` are the backstops. T3, T4, T30.
- **I5 (a checkout that fails before payment consumes nothing):** every check in reserve runs before its first write. The savepoint is defence in depth: removing it alone fails no test (see the mutation log). T21, T22.
- **I6 (a decline releases what it held), stock and cart:** `finalizeOrder` adds the reserved units back on top of the current stock and reopens the cart, in the transaction that marks the order failed. The coupon half arrives with #4. T13, T18.
- **I10 (money):** totals never go negative, `total = subtotal − discount`, and `discount = floor(subtotal × percent / 100)`. The pure functions are in `src/domain/money.ts`, and T27 proves them. Migration 0003 adds `total >= 0`, `total = subtotal − discount` and `line_total = unit_price × quantity` as CHECKs. The discount-formula CHECK needs `percent_off`, so it arrives with #4.
- **I11 (an order still explains itself after products change):** order lines snapshot the name, unit price, quantity and line total. T23.
- **I12 (a cart changes only while it is open):** PUT and DELETE lock the cart row `FOR NO KEY UPDATE` and require `status = 'open'`, in the same transaction as the write. That one guard covers `pending_payment` and `checked_out`. The T24 locked-status rows drive both states through a real checkout, and a decline reopens the cart for writes.
- **I13 (an order leaves `pending_payment` exactly once):** `finalizeOrder` claims the order with `UPDATE … WHERE status = 'pending_payment'`, and does nothing else when no row changed. Its race tests (T10, T11) need recovery, so they arrive with #5.
- **I14 (a committed key has exactly one replay source):** the claim and its outcome (the order ID set in reserve, or the stored error) commit in the same transaction. `CHECK (order_id IS NULL OR response_status IS NULL)` rules out both at once. T20.

## Ambiguities and chosen semantics

_Filled in by each issue as it resolves them: checkout (#3), coupons (#4), pending payments (#5)._

### Carts

- **"Add" and "change" are one PUT that sets the quantity.** The brief's "add an item" and "change its quantity" both map to `PUT /carts/:id/items/:productId { quantity }`. See the decision below.
- **The stock check at PUT is soft.** It compares the quantity with the stock at that moment, under no product lock, and reserves nothing. It exists to fail early with a useful 409. Checkout makes the authoritative check under the product lock (#3). The view's `available` flag tells the client when a line has gone short since.
- **A line holds at most 1000 units, and a cart at most 50 lines.** Both caps bound the money arithmetic (see Money). The quantity cap is in the PUT schema and a CHECK. The line cap is checked in the PUT, under the cart lock. Changing an existing line is never blocked by the line cap.
- **Prices are live.** Cart lines store no price. Each view reads the current price, and the order snapshots it once, at checkout.
- **Carts have no `updated_at`.** The architecture lists one, but nothing reads it, and a column with that name that never changed would mislead. Carts keep `created_at`.
- **The view's `orderId` is the cart's live order.** It is the pending order while a payment is in flight and the paid order once checked out. A declined order is not live, so a reopened cart shows `null`. The two locked-status errors carry the same `details: { orderId }`.
- **The view's `coupon` is not there yet.** #4 adds it with the preview.

### Checkout

- **`expectedTotalPaise` is required.** The client sends the total it showed the customer, and a mismatch gets `409 PRICE_CHANGED` with the current breakdown. The cart view's `totalPaise` is exactly the value checkout accepts, because both price the lines with `priceLines` in `src/domain/money.ts`.
- **The first business outcome of a key is final (the Stripe rule).** Once reserve has started, a final error (`CART_NOT_FOUND`, `CART_CHECKED_OUT`, `INSUFFICIENT_STOCK`, `PRICE_CHANGED`, `CART_EMPTY`) is stored on the key, and the same key replays it even after the cause is fixed. A new attempt needs a new key.
- **Only a hold on the cart is transient.** `CART_PAYMENT_PENDING` is stored nowhere, so the same key can succeed once the other payment resolves. Stock held by a payment that is still in flight is a final `INSUFFICIENT_STOCK`: the client can't know whether that payment will release it.
- **A decline reopens the cart.** The order is `failed`, its stock is released, and the cart is `open` with its lines intact. The same key replays the 402, and a new key can pay.
- **An unknown payment outcome holds the reservation.** When the gateway throws or times out, the order stays `pending_payment` and the response is 202 with `Retry-After: 5`. Retrying the same key replays the current state. Resolving these orders is #5.
- **A zero total is never charged.** A cart can total 0 today through a product priced at 0, and with a 100% coupon in #4. It is paid with `payment_ref` null and no gateway call.
- **The cart ID is lowercased before hashing.** Postgres compares UUIDs case-insensitively, so without this the same cart sent in upper case would be a different request and get 422.

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

- `createDb(config, { max })` returns `{ db, pool }`. `max` sizes the pool. Only the tests pass it, because a 20-way concurrency test needs more than pg's default of 10 connections.
- `createApp({ config, gateway, db })` mounts router factories such as `productsRoutes({ db })` and `checkoutRoutes({ db, gateway, config })`. Each factory takes only what it uses.
- `server.ts` passes a `FakeGateway`. Tests pass a fresh fake, a gated one, or a stub through `appWith(gateway)`, on the same pool.

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
- For telling an add from a change: `INSERT … ON CONFLICT DO UPDATE` with `RETURNING (xmax = 0)`, or, under the cart lock, an `UPDATE … RETURNING` followed by an INSERT when it matched no row.

**Choice:**

- PUT sets the quantity: 201 when it adds the line, 200 when it changes it.
- DELETE of an absent line returns 200 with the cart.
- Both run in one READ COMMITTED transaction that first locks the cart row `FOR NO KEY UPDATE` and checks that the cart is open. PUT then reads the product (404, soft stock check) and updates the line. If the update matched no row, it counts the lines (422 `CART_LINE_LIMIT`) and inserts. The view is built in the same transaction.

**Why:**

- "Add 1 keyboard" sent twice gives 2 keyboards. "Set the keyboard quantity to 1" sent twice still gives 1. Every cart write is retry-safe without a key, and a retried DELETE gets the answer the first one got.
- The cart lock serialises every write to that cart's lines. So the UPDATE, the line count and the INSERT can't interleave with another request on the same cart: five identical PUTs give one 201 and four 200s (T8), and two new lines racing for the 50th slot give one 201 and one 422.
- `FOR NO KEY UPDATE` is enough, because only non-key columns change. It doesn't block the `FOR KEY SHARE` lock that a `cart_items` insert takes on its product row, so carts holding the same product never wait on each other.
- `xmax = 0` relies on a system column that Postgres doesn't document for this use, and the line cap would still need a count under a lock.
- At READ COMMITTED, each statement takes a fresh snapshot. A PUT that waited for the cart lock therefore sees the line that the previous holder inserted.

**Consequences:**

- A client can't add "one more" without knowing the current quantity. It reads the cart first.
- The 201 or 200 tells the client which case happened, but the body is the same cart view either way.

### Decision: Row locks, one lock order, READ COMMITTED

**Context:** Twenty customers can check out the last three lamps at once, and two carts can hold the same products in opposite order. Stock must never oversell, and no request may fail with a deadlock.

**Options considered:**

- Row locks (`SELECT … FOR NO KEY UPDATE`) taken in one global order.
- A conditional update only: `UPDATE products SET stock = stock − q WHERE stock >= q`.
- SERIALIZABLE, with a retry loop.
- Optimistic version columns.
- An in-process mutex.

**Choice:**

- Reserve locks the cart, then the cart's products in one statement: `SELECT … WHERE id IN (…) ORDER BY id FOR NO KEY UPDATE` (`lockProducts`). Postgres takes the row locks after the sort, so they are taken in ID order. `finalizeOrder` locks the cart, then claims the order, then (for a decline) locks the products through the same `lockProducts`.
- Every check runs on the locked rows: every short line is reported in one 409. Then one `UPDATE products … FROM cart_items` decrements every line.
- Both transactions run at READ COMMITTED. Every lock wait is bounded by `lock_timeout`.

| Transaction   | Locks, in order                                                    |
| ------------- | ------------------------------------------------------------------ |
| Reserve       | key (insert) → cart → products by ID. Then it updates its own key row |
| finalizeOrder | cart → order (conditional update) → products by ID, declines only  |
| Cart PUT / DELETE | cart                                                           |
| PATCH product | the product row                                                    |

**Why:**

- **Deterministic and explainable.** Each step can be read off the code, with no retry loop. Contention is per product, and a hot product serialises only reserve phases, never payment calls.
- **No deadlock.** Every transaction that takes more than one row lock takes cart, then products by ID, in that relative order. The key can't be part of a cycle: only the reserve that inserted a key writes to it, and a request waiting on a conflicting claim holds nothing, because the claim is its first statement.
- **The conditional update alone** can't report every short line at once, and needs a rollback when line 3 fails after lines 1 and 2 succeeded. **SERIALIZABLE and version columns** need a retry loop, and under contention for limited stock most attempts fail and retry. **A mutex** breaks with a second instance.
- **READ COMMITTED is deliberate.** After a lock wait, the waiter's next statement sees the newest committed row, such as a cart that is now `pending_payment`, with no serialisation error. At REPEATABLE READ the same point raises `40001`.
- **The live order is read in a second statement.** After a lock wait, Postgres re-reads only the locked row (EvalPlanQual). A row joined in the same locking statement would come from the snapshot taken before the wait, and would miss the order the previous holder just created. So `lockOpenCart` locks the cart alone, then reads the live order.
- **`FOR NO KEY UPDATE`** is enough, because only non-key columns change, and it doesn't block the `FOR KEY SHARE` lock that a foreign-key insert takes.

**Consequences:**

- A lock held past `LOCK_TIMEOUT_MS` is `503 LOCK_TIMEOUT`. In reserve it rolls back everything, including the key claim, so the same key can be retried (T17).
- At flash-sale scale, a stock-reservation table or partitioned counters would replace the hot-row lock.

### Decision: An idempotency key table, with final and transient outcomes and no state column

**Context:** A client that times out on checkout retries. The retry must never create a second order or charge twice, and must get a truthful answer while the first request is still running.

**Options considered:**

- The key as a column on the order row.
- A key table with an `in_progress` / `completed` state column.
- A key table whose committed row always has exactly one replay source: its order, or its stored response.

**Choice:**

- `idempotency_keys (key PK, request_hash, order_id UNIQUE NULL, response_status, response_body, created_at)`.
- **The claim:** reserve's first statement is `INSERT … ON CONFLICT (key) DO NOTHING RETURNING key`. An empty result is a conflict, and a separate SELECT then loads the committed row:
  - a different `request_hash` → `422 IDEMPOTENCY_KEY_REUSED`;
  - an `order_id` → replay the order's current state: 201 paid, 202 pending, 402 failed;
  - a stored response → replay it.

  Every replay carries `Idempotent-Replayed: true`. Nothing was written, so the transaction just ends.
- **The hash** is SHA-256 of `[cartId, expectedTotalPaise, paymentToken]`, after zod has parsed and normalised them.
- **The storage rule** is the `final` flag on each code in the `ERRORS` table. Reserve's steps run inside a savepoint. A final error rolls back to the savepoint, stores `toErrorBody(err)` on the key, commits, and only then is returned. Anything else (a transient code, a 500, a 503) rolls back the whole transaction, key included. A 400 never reaches the claim.

**Why:**

- **Claiming first makes a race on one key safe.** The second request waits on the uncommitted insert while holding no other lock, then sees the committed row in its next statement. A SELECT-then-INSERT claim lets both pass the SELECT, and one fails on the primary key with a 500 (mutation log, T3).
- **No state column, so no false 409.** A committed key always points at an order or a stored response. So a retry while the payment is still in flight gets a truthful 202 with the order, not a "request in progress" 409. Finalize never needs to touch the key.
- **A key on the order row** can't store a failure that never created an order, and a key reused on another cart becomes a constraint violation (a 500) instead of a 422.
- **Final versus transient** follows Stripe: once a request has begun executing, its outcome is final. A conflict with another payment in flight on the same cart is not an outcome of this request, so it is not stored.

**Consequences:**

- Keys are global, because there is no auth to scope them by, and they are kept forever. Both are deferred.
- A key whose first attempt failed on a business rule can never pay. The client needs a new key, which is what Stripe does too.

### Decision: Atomic phases, not an outbox

**Context:** The charge is a call to a foreign system. A network call must never hold row locks, and a charge must never happen inside a transaction that could still roll back.

**Options considered:**

- No payment step: a commit counts as paid.
- Atomic phases with a reservation: reserve (transaction 1), charge (no transaction), finalize (transaction 2). This is the shape Stripe uses, as written up by Brandur Leach.
- A transactional outbox and a worker that charges and finalizes.
- A workflow engine (Temporal, a saga orchestrator).

**Choice:** one synchronous request in three phases. Reserve commits a `pending_payment` order holding its stock. The charge runs with no transaction open, under `AbortSignal.timeout(GATEWAY_TIMEOUT_MS)`. Then `finalizeOrder(orderId, resolution)` marks the order paid (the cart becomes `checked_out`) or failed (the stock is restored on top of the current value, and the cart reopens). Any thrown error from the charge is an unknown outcome: nothing is written, and the response is 202. The response is always built from the order as it is after finalize, by `toCheckoutResponse(loadOrderView(…))`.

**Why:**

- It covers every failure the brief names with no worker and no broker. The pending order row is the durable record of the intent to charge, so a crash at any point leaves something that recovery (#5) can resolve.
- **The outbox** solves a different problem: writing to the database and publishing to a broker atomically. We have no broker and no consumers. It needs an always-on relay, makes every checkout asynchronous (always 202, then poll), and its relay can publish twice. It becomes the right tool once there are downstream side effects, such as a receipt email.
- **A workflow engine** is a correct pattern for a much bigger problem than ours.
- **No payment step** can't show a reservation surviving a failed payment.
- **T3 checks the boundary directly:** while the charge is held at the gate, no backend may be idle in transaction. Charging inside a transaction fails it.

**Consequences:**

- If finalize fails with a 500 or 503 after the charge, that request gets the error. The order stays pending and the key already points to it, so a retry replays 202 until #5's recovery resolves it.
- The decline restores stock as `stock + quantity`, never an absolute value read at reserve time, so an admin PATCH during the payment is kept (T18).

### Decision: A fake gateway shaped like Stripe

**Context:** The brief forbids depending on private services or credentials, and the tests need declines (and, in #5, timeouts) on demand.

**Options considered:**

- Stripe's test mode.
- `stripe-mock`.
- Our own in-process fake behind a `PaymentGateway` interface.

**Choice:** `PaymentGateway.charge(input, signal)` returns `approved` with a `paymentRef`, or `declined` with a reason. A throw means the outcome is unknown. `FakeGateway` maps Stripe's own test tokens (`pm_card_visa`, `pm_card_chargeDeclined`, `pm_card_chargeDeclinedInsufficientFunds`). Any other token is declined with `invalid_payment_method`. Charges are recorded in a `Map` keyed by order ID, so a repeated charge returns the recorded result and nothing is charged twice. Test-only control lives in `test/helpers/gate.ts`: `gated(gateway, { at: 'before' | 'after' })` holds `charge()` until `release()`, and honours the abort signal.

**Why:**

- Stripe's test mode needs a secret key, network access and an account, is rate limited, and can't produce a timeout on demand. `stripe-mock` is stateless, and its README says it returns success rather than errors. Stripe's own guidance for automated tests is to mock the gateway.
- The interface is in-process and typed, so its results are not zod-parsed. A real HTTP adapter would parse them at its own boundary.

**Consequences:** the fake's records are per process and lost on restart. A real PSP is shared, so with one the limit goes away. The timeout tokens, `retrieve()` and `cancel()` arrive with #5.

### Decision: A required price guard

**Context:** Cart prices are live, and an admin can change a price between "view cart" and "pay".

**Options considered:** charge the current price silently; lock the price when the item is added; an optional guard; a required `expectedTotalPaise`.

**Choice:** `expectedTotalPaise` is required. Reserve prices the locked lines with `priceLines` and compares the result with the expected total. A mismatch is a final `409 PRICE_CHANGED` with `{ subtotalPaise, discountPaise, totalPaise }`.

**Why:** the customer is never charged a total they didn't see, in either direction. The breakdown lets the client show the new total and retry with a new key. Locking prices at add time would need a price column on every cart line, and the expiry rules that come with it.

**Consequences:** a client must read the cart before paying. The cart view's `totalPaise` and checkout share one pricing function, so the view's total is always accepted first time (T21).

_Further decisions arrive with the issues that make them:_

- Coupon generation and the advisory lock: #4.
- Holding unknown payment outcomes: #5.
- The report snapshot: #6.

## Transaction, concurrency and idempotency strategy

Checkout is one request in three phases (see "Atomic phases, not an outbox"):

1. **Reserve** (`reservePhase`, one READ COMMITTED transaction):
   1. claim the key;
   2. open a savepoint;
   3. lock the cart and require it to be open;
   4. load the lines, and get 422 if there are none;
   5. lock the products in ID order, and get 409 listing every short line;
   6. price the lines, and check the price guard;
   7. write: decrement stock, insert the order and its line snapshots, set the cart to `pending_payment`, and point the key at the order.
2. **Charge:** no transaction and no connection are held. A zero total is approved without a call.
3. **Finalize** (`finalizeOrder`): approved or declined, using the conditional update on the order. An unknown outcome writes nothing.

The lock order, isolation level and key storage rule are in the decisions above. Pending recovery: #5.

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
- **The bounds keep every intermediate value safe.** A unit price is capped at 1,000,000,000 paise (₹1 crore, enforced by the PATCH schema and backed by the `products_price_paise_range` CHECK, so a seed or SQL write can't exceed it either), a line quantity at 1000, and a cart at 50 lines (`MAX_CART_LINES`, which the cart PUT enforces with 422 `CART_LINE_LIMIT`). So a full cart's `subtotal × 100` is at most 5 × 10^15, below 2^53 ≈ 9 × 10^15. Without the line cap, about 90 lines at the caps would pass 2^53. T27 includes a full cart at the caps.
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

**Checkout codes, and what each does to the idempotency key:**

| Status | Code                      | Key                                                   |
| ------ | ------------------------- | ----------------------------------------------------- |
| 400    | `VALIDATION_ERROR`        | Not stored: rejected before the claim                 |
| 400    | `IDEMPOTENCY_KEY_INVALID` | Not stored. One code for missing, empty and too long  |
| 402    | `PAYMENT_FAILED`          | Replayed from the order, with `details: { orderId, reason }` |
| 404    | `CART_NOT_FOUND`          | Final                                                 |
| 409    | `CART_CHECKED_OUT`        | Final, with `details: { orderId }`                    |
| 409    | `CART_PAYMENT_PENDING`    | Transient, with `details: { orderId }`                |
| 409    | `INSUFFICIENT_STOCK`      | Final, with every short line in `details`             |
| 409    | `PRICE_CHANGED`           | Final, with the current breakdown                     |
| 422    | `CART_EMPTY`              | Final                                                 |
| 422    | `IDEMPOTENCY_KEY_REUSED`  | Not stored; the existing row is unchanged             |
| 500    | `INTERNAL`                | Rolled back in reserve. After reserve, the key already points to the order |
| 503    | `LOCK_TIMEOUT`            | Rolled back in reserve. After reserve, the key already points to the order |

T20 asserts each row: final codes have a stored response and replay with `Idempotent-Replayed: true`, and the others leave no key row. `402` uses the error envelope because a declined payment is an error for the client. `PRICE_CHANGED` is a 409, a conflict with current state, and not a 422, because the same request was valid a moment ago.

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
| The cart lock (`FOR NO KEY UPDATE`) in PUT and DELETE            | T8 gets `{201:1, 500:4}`: all five update no row, then four inserts hit the primary key (23505). The concurrent line-cap test gets `{201:2}` and 51 lines |
| The line count moved before the cart lock                        | The concurrent line-cap test gets `{201:2}`. T8 still passes, so the count needs its own test |
| The line-cap check                                               | T24 "allows the 50th line, rejects the next new line …" (201 instead of 422), and the concurrent line-cap test |
| The status guard in PUT and DELETE                               | All eight T24 locked-status rows                              |
| `FOR NO KEY UPDATE` in `lockProducts`                            | T1 gets `{201:3, 500:17}` and T2 `{201:1, 500:19}`: every request passes the stock check on the stale value, and the decrements past zero hit `products_stock_nonneg` (23514) |
| The stock check as `stock > 0` instead of `stock >= quantity`    | T2 gets `{201:1, 500:19}`                                     |
| `ON CONFLICT DO NOTHING` on the key claim                        | T3: the nine losers get 500 (23505 on the key) instead of a replayed 202 |
| The charge run inside an open transaction                        | T3: one backend is idle in transaction while the gate is held |
| `cartId` in the request hash                                     | T4: the key on another cart replays 201 instead of 422; the concurrent pair gets `[201, 202]` |
| `.toLowerCase()` on the cart ID                                  | T4 "uppercase form of the cart id" gets 422 instead of a replay |
| The pending-status guard in `lockOpenCart`                       | T5: the four losers reach the order insert and hit `orders_live_cart_uq` (23505), so 500 instead of 409 |
| `final: true` on `CART_PAYMENT_PENDING`                          | T5: the losing key retried replays `CART_PAYMENT_PENDING` instead of `CART_CHECKED_OUT`; T20 "stores nothing" finds a key row |
| Product locks taken one line at a time, in a random order        | T7 fails with deadlocks (`40P01`), 3 runs out of 3            |
| The stock restore in `finalizeOrder`                             | T13: stock 2 instead of 3                                     |
| Reopening the cart in `finalizeOrder`                            | T13: the cart is not `open` with `orderId: null`              |
| The key claim committed in its own transaction before reserve    | T17: a key row exists after the 503                           |
| The decline writing back the stock read at reserve time          | T18: stock 3 instead of 11                                    |
| The savepoint, with the order insert moved before the checks     | T22: an order row survives the 409                            |
| The price guard                                                  | T20 `PRICE_CHANGED` and T21                                   |

On the barriers: in T1 and T2 every checkout blocks on `lockProducts` (the lamp row), and without the lock it blocks on the `UPDATE products` instead. In T3 the first request blocks on the cart lock and the other nine on its uncommitted key claim. In T5 all five block on the cart lock.

Two notes:

- **Removing the savepoint alone fails no test.** Every check already runs before the first write. With the savepoint kept, even moving the order insert before the checks passes every test, because the final error rolls the insert back. It is defence in depth.
- **Removing `ORDER BY` from `lockProducts` fails no test (T7 passes, 3 runs out of 3).** A single `id IN (…)` statement scans the products in the same order in every transaction. Locking one line at a time in the cart's own order doesn't change it either, because the cart lines come from the `(cart_id, product_id)` primary key, already in product order. Only an order that really differs between transactions deadlocks. So T7 guards against per-line locking in an arbitrary order, and doesn't prove that `ORDER BY` is needed.

On the barrier: with the cart lock present, every PUT blocks on `SELECT … FROM carts … FOR NO KEY UPDATE`. With it removed, every PUT blocks on the `INSERT INTO cart_items`, whose foreign-key check needs `FOR KEY SHARE` on the cart row that the barrier holds `FOR UPDATE`. So the barrier still lines the requests up, and they fail at the INSERT.

## Time spent

_#7._
