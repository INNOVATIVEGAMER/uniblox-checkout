# Decisions

This file records the decisions behind the service. Each material decision follows the brief's shape: Context, Options considered, Choice, Why, Consequences. The full design, with the invariant IDs (I#) and test IDs (T#) used below, is in [`architecture.html`](architecture.html).

Sections marked with an issue number are filled in by that issue, together with the code they describe.

## System invariants

_Consolidated table (I1–I15, where each is enforced, and the test that proves it): #7. Each issue adds the invariants it enforces._

- **I1 (stock never goes below zero):** reserve locks the cart's products `ORDER BY id FOR NO KEY UPDATE` and checks every line before it decrements anything. `CHECK (stock >= 0)` is the backstop. T1 and T2.
- **I2 (a cart has at most one live order):** reserve locks the cart and requires `status = 'open'`. The partial unique index `orders_live_cart_uq` (`cart_id WHERE status <> 'failed'`) is the backstop. T5.
- **I3 (a retried checkout never creates a second order or charges twice):** the key is claimed as reserve's first statement, and a key that has an order or a stored response is replayed. The fake gateway's charges are idempotent per order ID. The key's primary key and `UNIQUE (order_id)` are the backstops. T3, T4, T30.
- **I4 (a coupon is held by at most one live order, and redeemed at most once):** reserve locks the coupon `FOR NO KEY UPDATE` and requires `status = 'available'`. The partial unique index `orders_live_coupon_uq` (`coupon_id WHERE status <> 'failed'`) is the backstop. T6.
- **I5 (a checkout that fails before payment consumes nothing):** every check in reserve runs before its first write. The savepoint is defence in depth: removing it alone fails no test (see the mutation log). T21, T22.
- **I6 (a decline releases what it held):** `finalizeOrder` adds the reserved units back on top of the current stock, reopens the cart and makes the coupon `available` again, in the transaction that marks the order failed. T13, T18.
- **I7 (a reservation is never released while its charge could still land):** a thrown charge holds the order. Recovery releases only after the gateway reports a decline, or after `cancel()` confirms that nothing was charged and nothing can be from then on. T12, T14, T31.
- **I8 (a coupon's status agrees with its live order):** `reserved` while the order is pending, `redeemed` once it is paid, `available` after a decline. Reserve and `finalizeOrder` change the coupon in the same transaction as the order. A CHECK can't span two rows, so the only backstop is `CHECK ((status = 'redeemed') = (redeemed_at IS NOT NULL))` on the coupon itself. T6, T13.
- **I9 (at most one coupon per milestone):** `UNIQUE (coupons.milestone)` is the guarantee. Generation takes `pg_advisory_xact_lock` first, so concurrent calls queue instead of colliding on the constraint. T9.
- **I10 (money):** totals never go negative, `total = subtotal − discount`, and `discount = floor(subtotal × percent / 100)`. The pure functions are in `src/domain/money.ts`, and T27 proves them. Migration 0003 adds `total >= 0`, `total = subtotal − discount` and `line_total = unit_price × quantity` as CHECKs. Migration 0004 adds `discount = COALESCE(subtotal × percent_off / 100, 0)` and the pairing `(coupon_id IS NULL) = (percent_off IS NULL)`. Postgres integer division truncates, which equals floor for non-negative values, so the CHECK matches `discount()` exactly.
- **I11 (an order still explains itself after products change):** order lines snapshot the name, unit price, quantity and line total, and the order stores the coupon's `percent_off`. T23.
- **I12 (a cart changes only while it is open):** PUT and DELETE lock the cart row `FOR NO KEY UPDATE` and require `status = 'open'`, in the same transaction as the write. That one guard covers `pending_payment` and `checked_out`. The T24 locked-status rows drive both states through a real checkout, and a decline reopens the cart for writes.
- **I13 (an order leaves `pending_payment` exactly once):** `finalizeOrder` claims the order with `UPDATE … WHERE status = 'pending_payment'`, and does nothing else when no row changed. Two reconciles on one order change it once (T10), and so do recovery and the original request's own finalize (T11).
- **I14 (a committed key has exactly one replay source):** the claim and its outcome (the order ID set in reserve, or the stored error) commit in the same transaction. `CHECK (order_id IS NULL OR response_status IS NULL)` rules out both at once. T20.
- **I15 (the report reconciles with the orders and coupons, and reading it mutates nothing):** `GET /admin/report` reads every figure in one `READ ONLY` transaction at `REPEATABLE READ`, and no GET route calls recovery. T26 checks the report against the orders list and a database snapshot taken around every GET.

## Ambiguities and chosen semantics

_Filled in by each issue as it resolves them._

### Carts

- **"Add" and "change" are one PUT that sets the quantity.** The brief's "add an item" and "change its quantity" both map to `PUT /carts/:id/items/:productId { quantity }`. See the decision below.
- **The stock check at PUT is soft.** It compares the quantity with the stock at that moment, under no product lock, and reserves nothing. It exists to fail early with a useful 409. Checkout makes the authoritative check under the product lock (#3). The view's `available` flag tells the client when a line has gone short since.
- **A line holds at most 1000 units, and a cart at most 50 lines.** Both caps bound the money arithmetic (see Money). The quantity cap is in the PUT schema and a CHECK. The line cap is checked in the PUT, under the cart lock. Changing an existing line is never blocked by the line cap.
- **Prices are live.** Cart lines store no price. Each view reads the current price, and the order snapshots it once, at checkout.
- **Carts have no `updated_at`.** The architecture lists one, but nothing reads it, and a column with that name that never changed would mislead. Carts keep `created_at`.
- **The view's `orderId` is the cart's live order.** It is the pending order while a payment is in flight and the paid order once checked out. A declined order is not live, so a reopened cart shows `null`. The two locked-status errors carry the same `details: { orderId }`.
- **The view's `coupon` is `null` unless the request previews one.** `GET /carts/:id?couponCode=` fills it in (see Coupons).

### Checkout

- **`expectedTotalPaise` is required.** The client sends the total it showed the customer, and a mismatch gets `409 PRICE_CHANGED` with the current breakdown. The cart view's `totalPaise` is exactly the value checkout accepts, because both price the lines with `priceLines` in `src/domain/money.ts`.
- **The first business outcome of a key is final (the Stripe rule).** Once reserve has started, a final error (`CART_NOT_FOUND`, `CART_CHECKED_OUT`, `INSUFFICIENT_STOCK`, `PRICE_CHANGED`, `CART_EMPTY`, `COUPON_INVALID`, `COUPON_ALREADY_REDEEMED`) is stored on the key, and the same key replays it even after the cause is fixed. A new attempt needs a new key.
- **Only a hold on the cart or the coupon is transient.** `CART_PAYMENT_PENDING` and `COUPON_RESERVED` are stored nowhere, so the same key can succeed once the other payment resolves. Stock held by a payment that is still in flight is a final `INSUFFICIENT_STOCK`: the client can't know whether that payment will release it.
- **A decline reopens the cart.** The order is `failed`, its stock is released, and the cart is `open` with its lines intact. The same key replays the 402, and a new key can pay.
- **An unknown payment outcome holds the reservation.** When the gateway throws or times out, the order stays `pending_payment` and the response is 202 with `Retry-After: 5`. Retrying the same key replays the current state. See Pending payments below.
- **A zero total is never charged.** A cart can total 0 through a product priced at 0, or with a 100% coupon (T19). It is paid with `payment_ref` null and no gateway call.
- **The cart ID is lowercased before hashing.** Postgres compares UUIDs case-insensitively, so without this the same cart sent in upper case would be a different request and get 422. The coupon code is normalised by `couponCodeSchema` for the same reason.

### Coupons

- **A coupon is a bearer code.** Anyone holding the code can use it. There is no customer identity to tie it to.
- **Milestones count every paid order**, discounted or not. Pending and failed orders don't count. The k-th milestone is reached at paid order k × n. A count, not a sequence: a sequence leaves gaps when a transaction rolls back, so it would count failed checkouts.
- **One coupon per call, oldest unrewarded milestone first.** Nothing lapses. The 201 carries `remainingEligible`, the milestones still waiting after this one. Nothing waiting is `409 NO_ELIGIBLE_MILESTONE` with `{ paidOrders, nextMilestoneAt }`.
- **`percent_off` is frozen** on the coupon when it is generated, and copied onto the order at reserve. Changing `COUPON_PERCENT_OFF` later affects only new coupons, and an order always shows the discount it was charged. Changing `COUPON_EVERY_N_ORDERS` later is deferred, because it would re-map past milestones.
- **At most one coupon per order, and no expiry.**
- **A coupon held by a pending payment is `409 COUPON_RESERVED`, transient.** It may become available again if that payment is declined.
- **The preview checks the coupon whatever the cart's status.** It is a view, not a checkout: on the cart whose own pending order holds the coupon, it returns `COUPON_RESERVED`.

### Pending payments

- **Polling a 202 means re-POSTing the checkout with the same key.** It replays the order's current state, and once the order is older than `PAYMENT_PENDING_TTL_SECONDS` it resolves the order first. `GET /orders/:id` shows the order and never resolves it.
- **The TTL is measured on the database clock:** `created_at < now() - make_interval(secs => ttl)`. Clock skew between app instances can't make an order stale early.
- **An abandoned order fails with reason `abandoned`.** That is the reason recovery gives when it cancels a charge the gateway never recorded. If the original request's late charge is finalized first, or a second recovery sees the cancel's tombstone, the stored reason is `cancelled` instead. Both mean that nothing was charged.
- **`stillPending` counts every order still pending after a reconcile.** That includes orders younger than the TTL, which reconcile leaves alone, and stale orders whose recovery failed.

### Reporting

- **Only paid orders count as sold.** Revenue, discounts and quantities sum paid orders only. A pending order may still fail, and a failed order sold nothing.
- **Gross is the sum of subtotals, discounts the sum of discounts, and net the sum of totals.** Every order satisfies `total = subtotal − discount` (I10), so net always equals gross less discounts.
- **Quantities come from the order lines, the name from the product as it is now.** The lines are the record of what was sold (I11). The name is the current one, so a renamed product isn't split across two rows; the order views keep the name each line was sold under.
- **`rewarded` is the highest milestone with a coupon**, the same figure coupon generation reads, so `unrewarded` always equals what `POST /admin/coupons` can still generate.
- **Reconciliation means four checks hold:** summing `GET /admin/orders?status=paid` gives the sales figures; `ordersByStatus` matches the list's length per status; redeemed coupons equal paid orders with a coupon; reserved coupons equal pending orders with a coupon. The report and the list are separate requests, so they agree only when no checkout commits between them. T26 checks them with nothing running.
- **The orders list isn't paginated.** Pagination is deferred.

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

### Decision: Admin routes have no authentication

**Context:** `PATCH /admin/products/:id`, `POST` and `GET /admin/coupons`, `GET /admin/orders` and `POST /admin/payments/reconcile` change prices and stock, mint discounts, expose every order, and make gateway calls. The brief asks for admin APIs but no users or auth.

**Options considered:**

- No authentication, with the routes grouped under `/admin`.
- A shared admin token in config, checked by a middleware on `/admin/*`.

**Choice:** no authentication. Every admin route lives under `/admin`, so one middleware on that prefix can guard them all later.

**Why:**

- The brief allows it, and nothing is deployed.
- A token from config would protect nothing a reviewer runs locally, and would add a header to every admin request in the tests and `requests.http`.

**Consequences:**

- Anyone who can reach the server can change prices, generate coupons and trigger reconcile. Reconcile is safe to call repeatedly, because it resolves only orders past the TTL and each order exactly once (I13), but each call can make two gateway calls per stale order.
- Idempotency keys are global for the same reason (see the idempotency decision).

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
| Reserve       | key (insert) → cart → products by ID → coupon. Then it updates its own key row |
| finalizeOrder | cart → order (conditional update) → products by ID, declines only → coupon |
| Cart PUT / DELETE | cart                                                           |
| Coupon generation | advisory lock → coupon insert                                  |
| PATCH product | the product row                                                    |

**Why:**

- **Deterministic and explainable.** Each step can be read off the code, with no retry loop. Contention is per product, and a hot product serialises only reserve phases, never payment calls.
- **No deadlock.** Every transaction that takes more than one row lock takes cart, then products by ID, then coupon, in that relative order. `finalizeOrder` writes the coupon after the products on both paths. Written before them on a decline, it could deadlock with a reserve on another cart: finalize holding coupon C and waiting on product P, while the reserve holds P and waits on C. No test can force that interleaving, so the order is kept by reading the code, and stated in `finalizeOrder`'s comment. The key can't be part of a cycle: only the reserve that inserted a key writes to it, and a request waiting on a conflicting claim holds nothing, because the claim is its first statement.
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
- **The hash** is SHA-256 of `[cartId, couponCode ?? null, expectedTotalPaise, paymentToken]`, after zod has parsed and normalised them.
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

**Choice:** one synchronous request in three phases. Reserve commits a `pending_payment` order holding its stock. The charge runs with no transaction open, under `AbortSignal.timeout(GATEWAY_TIMEOUT_MS)`. Then `finalizeOrder(db, orderId, resolution)` marks the order paid (the cart becomes `checked_out`) or failed (the stock is restored on top of the current value, and the cart reopens). Any thrown error from the charge is an unknown outcome: nothing is written, and the response is 202. The response is always built from the order as it is after finalize, by `toCheckoutResponse(loadOrderView(…))`.

**Why:**

- It covers every failure the brief names with no worker and no broker. The pending order row is the durable record of the intent to charge, so a crash at any point leaves something that recovery can resolve.
- **The outbox** solves a different problem: writing to the database and publishing to a broker atomically. We have no broker and no consumers. It needs an always-on relay, makes every checkout asynchronous (always 202, then poll), and its relay can publish twice. It becomes the right tool once there are downstream side effects, such as a receipt email.
- **A workflow engine** is a correct pattern for a much bigger problem than ours.
- **No payment step** can't show a reservation surviving a failed payment.
- **T3 checks the boundary directly:** while the charge is held at the gate, no backend may be idle in transaction. Charging inside a transaction fails it.

**Consequences:**

- If finalize fails with a 500 or 503 after the charge, that request gets the error. The order stays pending and the key already points to it, so a retry replays 202 until recovery resolves it after the TTL.
- The decline restores stock as `stock + quantity`, never an absolute value read at reserve time, so an admin PATCH during the payment is kept (T18).

### Decision: A fake gateway shaped like Stripe

**Context:** The brief forbids depending on private services or credentials, and the tests need declines and timeouts on demand.

**Options considered:**

- Stripe's test mode.
- `stripe-mock`.
- Our own in-process fake behind a `PaymentGateway` interface.

**Choice:** `PaymentGateway.charge(input, signal)` returns `approved` with a `paymentRef`, or `declined` with a reason. A throw means the outcome is unknown. `retrieve(orderId, signal)` returns the recorded charge or `not_found`. `cancel(orderId, signal)` returns the recorded charge if there is one; otherwise it records a tombstone and returns `cancelled`, and any later `charge()` for that order is declined with `cancelled`. `tok_timeout_approved` and `tok_timeout_declined` record their outcome, then throw. `FakeGateway` maps Stripe's own test tokens (`pm_card_visa`, `pm_card_chargeDeclined`, `pm_card_chargeDeclinedInsufficientFunds`). Any other token is declined with `invalid_payment_method`. Charges are recorded in a `Map` keyed by order ID, so a repeated charge returns the recorded result and nothing is charged twice. Test-only control lives in `test/helpers/gate.ts`: `gated(gateway, { at: 'before' | 'after' })` holds `charge()` until `release()`, and honours the abort signal.

**Why:**

- Stripe's test mode needs a secret key, network access and an account, is rate limited, and can't produce a timeout on demand. `stripe-mock` is stateless, and its README says it returns success rather than errors. Stripe's own guidance for automated tests is to mock the gateway.
- The interface is in-process and typed, so its results are not zod-parsed. A real HTTP adapter would parse them at its own boundary.

**Consequences:** the fake's records are per process and lost on restart. After a restart, `retrieve()` says `not_found`, so recovery cancels and releases, which is right because the lost process can't charge anything either. A real PSP is shared, so with one the limit goes away.

### Decision: Hold unknown outcomes, and cancel before release

**Context:** A charge that throws or times out may have landed. Releasing its stock and coupon then could sell them twice and charge a customer for a failed order. Holding them forever blocks the cart and the stock.

**Options considered:**

- Release as soon as the charge call fails.
- Hold, and release once the TTL passes.
- Hold, and after the TTL ask the gateway what happened, cancelling at the gateway before any release.

**Choice:** hold. Once the order is older than `PAYMENT_PENDING_TTL_SECONDS`, `resolvePendingOrder` resolves it:

1. A zero total is paid, without calling the gateway.
2. Otherwise it calls `retrieve()`. An approved or declined record decides the order.
3. On `not_found`, it calls `cancel()`. `cancelled` fails the order with reason `abandoned`. If a charge landed between the two calls, `cancel()` returns it, and that charge decides the order.
4. Then `finalizeOrder`. If the gateway throws at any step, nothing is written and the order stays pending.

Config validation refuses to start unless `PAYMENT_PENDING_TTL_SECONDS` is at least 10 × `GATEWAY_TIMEOUT_MS`.

**Why:**

- **Releasing on failure** breaks I7 directly: an approved charge that only lost its response would leave a paid customer with a failed order.
- **The TTL alone** makes I7 depend on timing. A charge slower than the TTL lands on stock that was already released. T12 shows it: with the cancel removed, the held charge is approved after reconcile released everything.
- **Cancelling first** makes I7 hold whatever the timing. Once the cancel's tombstone is recorded, a late charge is declined.
- **The 10 × rule** keeps the cancel rare. By the time recovery runs, the original call has long been aborted by its own timeout, so a cancel only races charges that hung far past their deadline.

**Consequences:**

- Each `retrieve()` and `cancel()` is bounded by `GATEWAY_TIMEOUT_MS`, like `charge()`, so a hung PSP can't stall a PUT's phase 0. A timeout is a gateway error: the order stays pending (T31).
- With a real PSP, `cancel()` needs the PaymentIntent to exist, so the adapter would create it before confirming it.
- `finalizeOrder`'s conditional claim makes every race safe: two recoveries at once, or a recovery and the original request's late finalize, change the order exactly once (T10, T11).

### Decision: Recovery runs on the requests a stale hold would block, and on an admin reconcile

**Context:** A held order is resolved only if something runs recovery. There is no worker process, and the brief allows no external services.

**Options considered:**

- A scheduled reconciler.
- An admin reconcile only.
- Lazily, before the mutating requests that a stale hold would block, plus an admin reconcile.
- The same, but on GET requests too.

**Choice:** the lazy triggers plus the admin reconcile. Each trigger runs before its request opens a transaction:

| Request | Stale orders it resolves |
| --- | --- |
| Checkout | The cart's own order, the order holding the coupon, and orders holding any product in the cart |
| PUT | The cart's own order, and orders holding the product |
| DELETE | The cart's own order |
| `POST /admin/payments/reconcile` | Every stale order |

`findStalePending` takes a `StaleScope` union, so a trigger that forgets its filters fails to compile instead of recovering everything. Orders are resolved one at a time. A failure on one is logged, the order stays pending, and the request carries on, so its own checks decide the response.

**Why:**

- **Every block is covered.** A request that a stale hold would block resolves the hold first, so a stuck payment never produces a 409 `CART_PAYMENT_PENDING`, `COUPON_RESERVED` or `INSUFFICIENT_STOCK`. The stock trigger matters most, because checkout stores `INSUFFICIENT_STOCK` as the key's final answer.
- **Outside any transaction.** Run inside a PUT's transaction, recovery's finalize waits on the cart lock that the PUT already holds. T15 shows it with that mutation: the lock wait times out, and the PUT gets 409 instead of 200.
- **Never on GET.** Reads must not change state (I15), and repeated report requests must agree.
- **An admin reconcile alone** leaves carts stuck until an operator acts. **A scheduler** needs an always-on process. It is deferred (#7).

**Consequences:**

- A request that meets stale orders waits on the gateway for each of them, one at a time, up to two calls of `GATEWAY_TIMEOUT_MS` per order. Nothing caps how many orders one request resolves, so the first checkout after a gateway outage can carry every order the outage left behind.
- Concurrent requests that find the same stale orders each call the gateway for all of them, then queue on the cart lock in `finalizeOrder`. Only one claims each order (I13, T10), so the duplicate work is safe, but it is not free.
- Every checkout, PUT and DELETE runs `findStalePending`. The partial index `orders_pending_created_at_idx` `ON orders (created_at) WHERE status = 'pending_payment'` (migration 0005) keeps that cost proportional to pending orders, not to every order ever placed.
- Reconcile has no error response. A gateway error or lock timeout on one order leaves that order counted in `stillPending`.
- `resolved` lists only the orders this call claimed. When two recoveries race, the one that loses `finalizeOrder`'s claim leaves the order out (T10).
- Checkout reads the cart's product IDs before reserve, under no lock. A line added in between misses product recovery, but the PUT that added it ran its own.

### Decision: A reconciler, not Brandur's completer

**Context:** Brandur Leach's write-up of Stripe-style idempotency keys recovers interrupted requests with a completer, which re-drives each request from its last recovery point.

**Options considered:**

- A completer that re-sends the charge.
- A reconciler that asks the gateway what happened.

**Choice:** the reconciler. If the gateway approved the charge, it rolls forward. Otherwise it cancels at the gateway and rolls back.

**Why:**

- **Re-driving needs the payment token.** The token is never stored, which keeps card data out of the database.
- The `pending_payment` order is already the durable record of the intent to charge, and the gateway's record is the truth about the charge.

**Consequences:** an abandoned order is never retried. The customer's cart reopens, and they pay again with a new key.

### Decision: A required price guard

**Context:** Cart prices are live, and an admin can change a price between "view cart" and "pay".

**Options considered:** charge the current price silently; lock the price when the item is added; an optional guard; a required `expectedTotalPaise`.

**Choice:** `expectedTotalPaise` is required. Reserve prices the locked lines with `priceLines` and compares the result with the expected total. A mismatch is a final `409 PRICE_CHANGED` with `{ subtotalPaise, discountPaise, totalPaise }`.

**Why:** the customer is never charged a total they didn't see, in either direction. The breakdown lets the client show the new total and retry with a new key. Locking prices at add time would need a price column on every cart line, and the expiry rules that come with it.

**Consequences:** a client must read the cart before paying. The cart view's `totalPaise` and checkout share one pricing function, so the view's total is always accepted first time (T21).

### Decision: Coupon generation under an advisory lock, with UNIQUE (milestone)

**Context:** Two admins (or one retried call) can generate at once. Each call must reward a different milestone, and when two milestones are waiting, two concurrent calls should both succeed.

**Options considered:**

- `UNIQUE (milestone)` alone.
- `SELECT … FOR UPDATE` on the latest coupon row.
- `pg_advisory_xact_lock(<constant>)` as the transaction's first statement, plus `UNIQUE (milestone)`.

**Choice:** one READ COMMITTED transaction: take `pg_advisory_xact_lock(COUPON_GENERATION_LOCK)`, count paid orders, read `max(milestone)`, compute the next milestone with `milestoneProgress` (`src/domain/milestones.ts`), then insert. The code's random suffix can collide, so the insert uses `ON CONFLICT (code) DO NOTHING` and retries with a fresh suffix, up to 3 times. A third collision is a 500.

**Why:**

- **UNIQUE alone turns a race into errors.** Every concurrent caller reads the same `max(milestone)`, computes the same milestone and inserts it. One wins, and the rest hit 23505 on `coupons_milestone_unique`. `ON CONFLICT (code)` doesn't cover that constraint, so they get **500s**, not 409s. Measured with the lock removed and no barrier: 9 runs out of 10 gave `[201, 500, 500, 500, 500]` from 4 paid orders, where two coupons were due.
- **With the lock,** callers queue. Each reads the milestones its predecessors committed (READ COMMITTED takes a new snapshot per statement), so five calls with two milestones waiting give exactly two 201s and three 409s (T9). The UNIQUE stays as the guarantee.
- **A row lock on the latest coupon** has nothing to lock before the first coupon exists.
- **Reading the count at READ COMMITTED is safe** because a paid order is never un-paid (I13), so a stale count can only under-report eligibility.
- The advisory lock is transaction-scoped, so it is released on commit or rollback and can't leak, and it waits under the same `lock_timeout` as every row lock (503).

**Consequences:**

- Generation is serialized globally. At one admin call at a time that costs nothing.
- Removing UNIQUE (milestone) alone fails no test, because the lock already serializes (see the mutation log). It is a backstop, like the savepoint.

### Decision: A coupon preview that returns checkout's error

**Context:** The price guard requires `expectedTotalPaise`, so the client must be able to see the discounted total before paying.

**Options considered:**

- Attach the coupon to the cart.
- Guard the subtotal instead of the total.
- `GET /carts/:id?couponCode=` that previews, returning `200` with the coupon's status and no discount when it can't be used.
- The same preview, returning the error checkout would.

**Choice:** `GET /carts/:id?couponCode=` reads the coupon without a lock and runs the same `availableCoupon` guard as reserve. An available coupon gives `coupon: { code, percentOff }` and the discounted `discountPaise` and `totalPaise`. Otherwise it returns checkout's error: `422 COUPON_INVALID`, `409 COUPON_RESERVED` or `409 COUPON_ALREADY_REDEEMED`. The cart is checked first, so an unknown cart is 404.

**Why:**

- A preview never shows a total that checkout would reject. Both paths price with `priceLines`, so the preview's `totalPaise` is accepted first time (T21, with a cart where floor and round differ).
- It reserves nothing and writes nothing, so GET stays safe (T24 compares a snapshot of every table).
- Attaching the coupon to the cart adds a cart write and a release path for a coupon that may never be used.

**Consequences:** the preview is a snapshot. The coupon can be taken between the preview and the checkout, and checkout then returns the same error the preview would have.

### Decision: Coupon codes in uppercase Crockford base32

**Context:** Codes are typed by people and normalised by one shared schema, `couponCodeSchema` (trim, uppercase, then Crockford's decoding of `I` and `L` as `1` and `O` as `0`), used by the checkout body and the preview query.

**Options considered:** a mixed-case random suffix; sequential codes; an uppercase-only alphabet.

**Choice:** `SAVE{x}-M{k}-{8 characters}`, the suffix drawn with `crypto.randomInt` from Crockford's base32 alphabet (`0-9` and `A-Z` without `I`, `L`, `O`, `U`).

**Why:**

- A mixed-case code would never match after the schema uppercases the input.
- Crockford's alphabet drops the letters people confuse with digits, and its decoding reads a typed `I`, `L` or `O` as the digit it was mistaken for. No generated code contains those letters, the `SAVE{x}-M{k}-` prefix included, so the mapping never changes a real code.
- The random suffix means a bearer code can't be guessed from its milestone. 32^8 ≈ 10^12 values make the collision retry a formality.

**Consequences:** codes are case-insensitive for clients, and `O`/`0` and `I`/`L`/`1` are interchangeable. The length bound (1 to 64 after trimming) is a 400; any code inside it that doesn't exist is `422 COUPON_INVALID`.

### Decision: The report reads one READ ONLY REPEATABLE READ snapshot

**Context:** the report is several aggregates over orders, order lines and coupons. If a checkout commits between two of them, the figures disagree: gross revenue could include an order that `paidOrders` leaves out, or a coupon could be `redeemed` before its order counts as paid.

**Options considered:**

- One large SQL statement that computes everything.
- Several queries at READ COMMITTED, the level every other transaction uses.
- Several queries in one `READ ONLY` transaction at `REPEATABLE READ`.

**Choice:** `loadReport` (`src/modules/report/service.ts`) runs three queries, one per table, in `db.transaction(fn, { isolationLevel: 'repeatable read', accessMode: 'read only' })`. Counts per status use `count(*) FILTER (WHERE status = …)`, so a status with no rows reads 0 without a fill step. Every aggregate is cast to `bigint` and read with `.mapWith(Number)`, because node-postgres returns `bigint` and `numeric` as strings.

**Why:**

- **At READ COMMITTED each statement takes a new snapshot,** so the queries can straddle a commit.
- **REPEATABLE READ takes one snapshot at the first query** and every later query reads it, so the figures always describe the same instant. A read-only transaction never waits on row locks and can't hit a serialization failure, so it costs nothing extra.
- **One large statement** gets the same consistency, but is harder to read and to explain than three short queries.
- **`READ ONLY`** turns an accidental write in the report into an error (`25006`), which backs up I15.

**Consequences:**

- The report is a point in time. A checkout committing during it shows up on the next call.
- Neither the isolation level nor `READ ONLY` is proven by a test: no test commits a checkout between the report's queries. Both fail no test when removed (see the mutation log).
- Each call scans every order. Counters kept by `finalizeOrder` or a read replica fix that at scale; both are deferred.

## Transaction, concurrency and idempotency strategy

Checkout is one request in three phases (see "Atomic phases, not an outbox"):

1. **Reserve** (`reservePhase`, one READ COMMITTED transaction):
   1. claim the key;
   2. open a savepoint;
   3. lock the cart and require it to be open;
   4. load the lines, and get 422 if there are none;
   5. lock the products in ID order, and get 409 listing every short line;
   6. if a coupon is given, lock it by code and require it to be available (422, 409 final, or 409 transient);
   7. price the lines with the coupon's `percent_off`, and check the price guard;
   8. write: decrement stock, insert the order (with `coupon_id` and `percent_off`) and its line snapshots, set the coupon to `reserved`, set the cart to `pending_payment`, and point the key at the order.
2. **Charge:** no transaction and no connection are held. A zero total is approved without a call.
3. **Finalize** (`finalizeOrder`): approved or declined, using the conditional update on the order. Approved redeems the coupon; declined makes it available again. An unknown outcome writes nothing.

The lock order, isolation level and key storage rule are in the decisions above.

**Pending recovery** runs before any transaction opens, on the checkout, PUT and DELETE that a stale hold would block, and on `POST /admin/payments/reconcile`. It reads the stale orders, asks the gateway with no connection held, then calls the same `finalizeOrder` as phase 3. Its decline path locks the cart, then the products by ID, then the coupon, the same order as reserve. See "Hold unknown outcomes, and cancel before release".

**The report** is the only transaction not at READ COMMITTED: one `READ ONLY` transaction at `REPEATABLE READ`, so all its figures come from one snapshot. It takes no locks. See "The report reads one READ ONLY REPEATABLE READ snapshot".

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
| 409    | `COUPON_RESERVED`         | Transient: the coupon is held by a pending payment    |
| 409    | `COUPON_ALREADY_REDEEMED` | Final                                                 |
| 422    | `CART_EMPTY`              | Final                                                 |
| 422    | `COUPON_INVALID`          | Final: no coupon has this code                        |
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
| `FOR NO KEY UPDATE` on the coupon in reserve                     | T6: one checkout waits on the barrier at `UPDATE coupons`, the other four on `orders_live_coupon_uq` behind it, then get 500 (23505) instead of 409 `COUPON_RESERVED` |
| The `reserved` check in `availableCoupon`                        | T6: the four losers reach the order insert and hit `orders_live_coupon_uq` (23505), so 500 instead of 409 |
| Setting the coupon to `reserved` in reserve                      | T6, T13 (the coupon is `available` while pending), T20 "COUPON_RESERVED stores nothing", T24 reserved-preview row |
| Redeeming the coupon on approval in `finalizeOrder`              | T6, T13, T19: the coupon is not `redeemed`                    |
| Releasing the coupon on a decline in `finalizeOrder`             | T13: the coupon stays `reserved`                              |
| The coupon discount in `priceLines`                              | T6, T19, T21, T22, T24, and T4 lowercase: every coupon checkout gets `PRICE_CHANGED` |
| `couponCode` in the request hash                                 | T4 "the same key with a coupon" replays 201 instead of 422; T13's same key without the coupon replays instead of 422 |
| `.toUpperCase()` in `couponCodeSchema`                           | T4 lowercase coupon code, T21 and T24 previews, and the unit test |
| The Crockford alias `.overwrite` in `couponCodeSchema`           | The unit test "reads a typed I or L as 1 and O as 0"         |
| `pg_advisory_xact_lock` in generation                            | T9 fails with "1 request(s) finished without blocking on the barrier". Without a barrier, 5 parallel calls over 4 paid orders gave `[201, 500, 500, 500, 500]` 9 runs out of 10 (23505 on `coupons_milestone_unique`) |
| `AND status = 'pending_payment'` in `finalizeOrder`'s claim      | T10: stock 4 instead of 3, because both reconciles restore it. T11: `resolved_at` and `redeemed_at` are rewritten when the original request finalizes, here 4 ms later |
| `finalizeOrder` returning the status when its claim lost         | T10: both reconciles list the order, instead of exactly one |
| The `GATEWAY_TIMEOUT_MS` signal on `retrieve()` (a signal that never aborts) | T31 "retrieve() hangs": the test times out instead of rejecting with `TimeoutError` |
| The `cancel()` call in recovery (release on `not_found`)         | T12: the held charge is approved after release, instead of the `cancelled` tombstone. T31 "between retrieve and cancel" rows and "cancel() throws" |
| A `cancel()` error treated as `cancelled`                        | T31 "cancel() throws after not found": the order is released while a charge could still land |
| A charge returned by `cancel()` ignored (always `abandoned`)      | T31 "a charge that lands between retrieve and cancel" and "a decline that lands …" |
| A `retrieve()` or `cancel()` error treated as not found / cancelled | T31 both "throws" rows, the reconcile row, and T15's gateway-failure row |
| The per-order `try/catch`, moved around the whole loop           | T31 "one failing order does not abort reconcile": the second order stays pending |
| The TTL clause in `findStalePending`                             | T14: the early reconcile resolves the order. T16 and all six T15 "blocked by a fresh pending order" rows |
| The cart clause in `findStalePending`                            | T15 "a PUT of another product on the cart" and "a DELETE on the cart" |
| The coupon clause in `findStalePending`                          | T15 "checkout by another cart using the held coupon" |
| The product clause in `findStalePending`                         | T15 "checkout by another cart wanting the held lamps", "a PUT of the held product on another cart", and the gateway-failure row |
| The checkout recovery hook                                       | The three T15 checkout rows |
| The PUT recovery hook                                            | The two T15 PUT rows, and the gateway-failure row |
| The DELETE recovery hook                                         | T15 "a DELETE on the cart" |
| DELETE's recovery run inside a transaction that holds the cart lock | T15 "a DELETE on the cart": 409 instead of 200, after a `55P03` lock timeout is logged |
| Pointing the key at the order in reserve                         | T16: the retry gets 500 ("has neither an order nor a response") instead of a replayed 202 |
| The paid filter on the report's revenue sums                     | T26: gross, discounts and net include the failed and pending orders |
| The paid filter on the report's quantity query                   | T26: `quantityByProduct` gains the failed keyboard, the pending monitor and the stale cable |
| `recoverStale({ scope: 'all' })` added to the report route       | T26: the first report resolves the stale order, so `ordersByStatus` shows 1 pending and 2 failed |

On the barriers: in T1 and T2 every checkout blocks on `lockProducts` (the lamp row), and without the lock it blocks on the `UPDATE products` instead. In T3 the first request blocks on the cart lock and the other nine on its uncommitted key claim. In T5 all five block on the cart lock. In T6 all five block on the coupon lock in reserve; their product locks don't contend, because the five carts share no product. In T9 all five block on `pg_advisory_xact_lock`, which `pg_stat_activity` reports as `wait_event_type = 'Lock'`, `wait_event = 'advisory'`. In T10 both reconciles block on `finalizeOrder`'s cart lock, after their lock-free read and gateway calls.

Five notes:

- **Removing the savepoint alone fails no test.** Every check already runs before the first write. With the savepoint kept, even moving the order insert before the checks passes every test, because the final error rolls the insert back. It is defence in depth.
- **Removing `UNIQUE (milestone)` fails no test (T9 passes, 3 runs out of 3).** The advisory lock already serializes generation, so no duplicate milestone is ever inserted. It is the backstop, like the savepoint.
- **Checkout's cart clause can't be isolated by a checkout row.** The cart's lines are its order's lines, so the product clause also matches. The PUT of another product and the DELETE are the rows that catch the missing cart clause.
- **Running the report at READ COMMITTED, or without `READ ONLY`, fails no test.** No test commits a checkout between the report's queries, and the report writes nothing. Both are recorded in "The report reads one READ ONLY REPEATABLE READ snapshot".
- **Removing `ORDER BY` from `lockProducts` fails no test (T7 passes, 3 runs out of 3).** A single `id IN (…)` statement scans the products in the same order in every transaction. Locking one line at a time in the cart's own order doesn't change it either, because the cart lines come from the `(cart_id, product_id)` primary key, already in product order. Only an order that really differs between transactions deadlocks. So T7 guards against per-line locking in an arbitrary order, and doesn't prove that `ORDER BY` is needed.

On the barrier: with the cart lock present, every PUT blocks on `SELECT … FROM carts … FOR NO KEY UPDATE`. With it removed, every PUT blocks on the `INSERT INTO cart_items`, whose foreign-key check needs `FOR KEY SHARE` on the cart row that the barrier holds `FOR UPDATE`. So the barrier still lines the requests up, and they fail at the INSERT.

## Time spent

_#7._
