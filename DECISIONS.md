# Decisions

This file covers the choices behind the service and why they were made. The full design (data model, state machines, lock order and the test plan) is in [`architecture.html`](architecture.html). Tests are named by ID (T1–T31), so `grep -r "T12" test/` finds the test behind a claim.

## System invariants

Each rule has a check in code that enforces it, a database constraint as a backstop where one is possible, and a test that fails if the check is removed.

| # | Rule | Enforced by | Test |
|---|---|---|---|
| I1 | Stock never goes below zero | Checkout locks the products in ID order and checks every line before decrementing. Backstop: `CHECK (stock >= 0)` | T1, T2 |
| I2 | A cart has at most one live order | Checkout locks the cart and requires it to be open. Backstop: a partial unique index on `orders.cart_id` | T5 |
| I3 | A retried checkout never creates a second order or charges twice | An idempotency key, claimed as checkout's first statement. The fake gateway's charges are idempotent per order | T3, T4, T30 |
| I4 | A coupon is redeemed at most once | Checkout locks the coupon and requires it to be `available`. Backstop: a partial unique index on `orders.coupon_id` | T6 |
| I5 | A checkout that fails before payment consumes nothing | Every check runs before the first write, inside a savepoint | T21, T22 |
| I6 | A declined payment releases its stock and coupon | `finalizeOrder` adds the stock back, makes the coupon available again and reopens the cart, in one transaction | T13, T18 |
| I7 | A reservation is never released while its charge could still land | A failed charge call holds the order. Recovery releases only after the gateway confirms nothing was charged (cancel before release) | T12, T14, T31 |
| I8 | A coupon's status matches its order | The coupon and the order change in the same transaction | T6, T13 |
| I9 | At most one coupon per milestone | An advisory lock serializes generation. Backstop: `UNIQUE (milestone)` | T9 |
| I10 | Money is exact and never negative | Integer paise, with the discount floored once. Backstop: CHECK constraints on every total | T27 |
| I11 | An order explains itself after products change | Order lines snapshot the name, unit price and quantity, and the order stores its discount percent | T23 |
| I12 | A cart changes only while it is open | Cart writes lock the cart and require `status = 'open'` | T24 |
| I13 | An order leaves `pending_payment` exactly once | `UPDATE … WHERE status = 'pending_payment'`, so the second resolver changes nothing | T10, T11 |
| I14 | A stored key has exactly one replay source | The key points either at an order or at a stored error, never both (a CHECK) | T20 |
| I15 | The report reconciles, and reading it changes nothing | One read-only snapshot. No GET route runs recovery | T26 |

**How the tests were checked:** each concurrency and payment test was run once with the code it guards removed, to confirm it fails. For example, removing the product lock turns T1 into `{201:3, 500:17}`, and removing cancel-before-release lets T12's slow charge land on stock that was already released. Two backstops fail no test, because the lock in front of them already prevents the problem: the savepoint, and `UNIQUE (milestone)`. They are kept anyway.

## Ambiguities and chosen semantics

- **Price changes after add-to-cart:** the cart shows live prices, and checkout requires `expectedTotalPaise`. A mismatch is `409 PRICE_CHANGED` with the new breakdown, so the customer is never charged a total they didn't see.
- **Stock changes after add-to-cart:** the add is a soft check (409 if above current stock) and reserves nothing. Checkout is the authoritative check.
- **"Add" and "change quantity":** one `PUT /carts/:id/items/:productId { quantity }` that sets the quantity. A retry is harmless. DELETE of a line that isn't there returns 200.
- **Quantity limits:** 1000 per line, 50 lines per cart. Both keep the money arithmetic far from overflow.
- **A failed checkout retried with the same key:** the first business outcome is final, as at Stripe. A new attempt needs a new key. Only a conflict with *another* payment in flight (`CART_PAYMENT_PENDING`, `COUPON_RESERVED`) isn't stored, so the same key can succeed later.
- **After a declined payment:** the cart reopens with its lines, and paying again needs a new key.
- **Coupons:** a bearer code, with at most one per order and no expiry. Every paid order counts toward the milestone, discounted or not. Each admin call generates one coupon, for the oldest unrewarded milestone, so nothing lapses. With nothing eligible, the call returns `409 NO_ELIGIBLE_MILESTONE`.
- **Seeing a discounted total before paying:** `GET /carts/:id?couponCode=` previews the discount without reserving anything. For an unusable coupon it returns the same error checkout would.
- **Admin PATCH of stock:** sets the units available to sell. A later decline adds its reserved units back on top.
- **The report:** only paid orders count as sold. Gross is the sum of subtotals, net the sum of totals, and discounts the difference.

## Material decisions

### Decision: Postgres row locks, taken in one order

**Context:** twenty customers can race for the last three lamps, and two carts can hold the same products in opposite order. We can't oversell, and no request may deadlock.

**Options considered:** a conditional `UPDATE … WHERE stock >= q` alone; SERIALIZABLE with a retry loop; optimistic version columns; an in-process mutex.

**Choice:** checkout locks the cart, then the cart's products in ID order (`FOR NO KEY UPDATE`), then the coupon. It checks every line, then decrements. Everything runs at READ COMMITTED with a `lock_timeout`.

**Why:** it is deterministic and easy to explain, with no retry loop. One lock order means no deadlock. The conditional update can't report every short line at once. SERIALIZABLE retries constantly under contention. A mutex breaks with a second instance.

**Consequences:** a hot product serializes its checkouts, but only for the milliseconds of the reserve step, because no lock is held during the payment call. A lock wait past the timeout returns `503 LOCK_TIMEOUT`, and the request is safe to retry.

### Decision: An idempotency key table, and the first outcome is final

**Context:** a client that times out retries the checkout. The retry must not create a second order or charge twice, and must get a truthful answer while the first request is still running.

**Options considered:** the key as a column on the order; a key table with an `in_progress`/`completed` state column; re-executing failed requests.

**Choice:** an `idempotency_keys` table, claimed with `INSERT … ON CONFLICT DO NOTHING` as checkout's first statement. A committed key points at its order (the retry replays the order's current state: 201, 202 or 402) or at a stored error. The same key with a different body is `422 IDEMPOTENCY_KEY_REUSED`.

**Why:** claiming first makes concurrent retries of the same key queue safely, instead of hitting a constraint with a 500. A key on the order row can't record a failure that never created an order. A state column caused false "in progress" 409s while a payment was pending.

**Consequences:** keys are global and kept forever, because there is no auth to scope them by. After a business failure, a client must use a new key.

### Decision: A fake payment gateway, and checkout in three phases

**Context:** the brief allows treating checkout as paid. But a reservation that survives a failed or timed-out payment is the hard part of real checkouts, and it can't be shown without a payment step.

**Options considered:** no payment step; Stripe test mode (needs credentials, which the brief forbids); `stripe-mock` (always returns success); a transactional outbox with a worker.

**Choice:** a small in-process `FakeGateway`, shaped like Stripe and driven by Stripe's own test tokens (`pm_card_visa`, `pm_card_chargeDeclined`), plus two of our own for timeouts. Checkout stays one synchronous request in three phases:

1. **Reserve:** a transaction that creates a `pending_payment` order and holds its stock and coupon.
2. **Charge:** a call to the gateway with no transaction open.
3. **Finalize:** a transaction that marks the order paid or failed and releases what it held.

**Why:** the charge never runs inside a transaction that could roll back, and no lock is held during a network call. The pending order is the durable record of the intent to charge, so no outbox or worker is needed. An outbox solves publishing to a broker, which we don't have.

**Consequences:** the fake keeps its charges in memory, per process. A real PSP is shared, so that limit goes away with one.

### Decision: Hold unknown payment outcomes, and cancel before release

**Context:** a charge that times out may still have gone through. Releasing its stock and coupon right away could sell them twice and charge a customer for a failed order.

**Options considered:** release as soon as the call fails; hold, then release after a TTL; hold, then after a TTL ask the gateway, and cancel at the gateway before any release.

**Choice:** the last one. An unknown outcome returns 202 and holds the order. After `PAYMENT_PENDING_TTL_SECONDS`, recovery asks the gateway. An approved or declined record decides the order. If the gateway has no record, recovery cancels at the gateway first and only then releases.

Recovery runs lazily, before the checkout, PUT or DELETE that the stale order would block, and on `POST /admin/payments/reconcile`. It never runs on a GET.

**Why:** a TTL alone makes correctness depend on timing: a charge slower than the TTL lands on stock that was already released. T12 shows this when the cancel is removed. Lazy triggers avoid a background worker. Keeping GETs free of recovery is what keeps the report free of side effects.

**Consequences:** the first request after a gateway outage pays for resolving the stale orders it meets. A scheduled reconciler is deferred.

### Decision: A required price guard, with a coupon preview

**Context:** prices are live, and an admin can change one between "view cart" and "pay".

**Options considered:** charge the current price silently; lock the price when the item is added; an optional guard; a required `expectedTotalPaise`.

**Choice:** `expectedTotalPaise` is required on every checkout. Because a coupon user can't otherwise know the discounted total, `GET /carts/:id?couponCode=` previews it, using the same pricing function as checkout.

**Why:** the customer is never charged an amount they didn't see, in either direction. Locking prices at add time would need a price on every cart line, plus expiry rules.

**Consequences:** a client must read the cart (or the preview) before paying. Because both use one pricing function, the total it reads is always accepted the first time (T21).

### Decision: Coupon generation under an advisory lock

**Context:** two admins, or one retried call, can generate at the same time. Each call must reward a different milestone.

**Options considered:** `UNIQUE (milestone)` alone; locking the latest coupon row; `pg_advisory_xact_lock` plus `UNIQUE (milestone)`.

**Choice:** the advisory lock as the transaction's first statement, then count paid orders, then insert the next milestone's coupon. `UNIQUE (milestone)` stays as the guarantee.

**Why:** with the unique constraint alone, concurrent callers compute the same milestone, and every loser gets a 500. In 9 runs out of 10, the measured result was `[201, 500, 500, 500, 500]`. With the lock they queue, so five calls with two milestones waiting give two 201s and three 409s (T9). There is no latest row to lock before the first coupon exists.

**Consequences:** generation is serialized globally, which costs nothing for an admin operation.

**Smaller decisions:** Node 22 with Hono, Drizzle and Postgres 16, because Drizzle keeps the locking SQL visible. zod at every boundary. No admin authentication: every admin route is under `/admin`, so one middleware could guard them all later. Coupon codes use uppercase Crockford base32, so a typed `O` or `I` still matches. The report reads one read-only `REPEATABLE READ` snapshot, so its figures can't straddle a commit. The demo frontend is a thin Next.js client behind a proxy, and it shows every raw API response.

## Transaction, concurrency and idempotency strategy

- **Checkout** runs as reserve, then charge, then finalize (see above).
  - Reserve is one READ COMMITTED transaction. It claims the key, then locks the cart, the products in ID order, and the coupon. It checks everything, then writes.
  - A business error rolls back to a savepoint, stores the error on the key and commits, so the retry replays it. Any other error rolls back everything, key included.
- **Cart writes** lock the cart row, so concurrent PUTs on one cart queue. Five identical PUTs give one 201 and four 200s.
- **Every lock wait** is bounded by `lock_timeout` and returns `503 LOCK_TIMEOUT`.
- **Recovery** runs before any transaction opens, and resolves each order through the same `finalizeOrder` as checkout. Its conditional update makes two resolvers racing on one order safe (I13).
- **The report** is the one transaction that isn't READ COMMITTED: `READ ONLY` at `REPEATABLE READ`, so all its figures come from one snapshot.

## Money and rounding rules

- Money is integer **paise** end to end, stored as `bigint`. The API only exposes `*Paise` integers.
- `lineTotal = unitPrice × quantity`, and `subtotal = Σ lineTotal`.
- `discount = floor(subtotal × percent / 100)`, applied once to the whole order. `total = subtotal − discount`.
- Floor is deterministic and favours the store by under one paisa. With `percent ≤ 100`, the total is never negative. The seeded cable (34999 paise) catches a rounding slip: 10% off is 3499 with floor and 3500 with round.
- A price cap (₹1 crore), a quantity cap (1000) and a line cap (50) keep every intermediate value below 2^53, so JS numbers stay exact.

## Error model

- Every error is `{ error: { code, message, details? } }`. Clients branch on `code`, never on the message.
- Every code's HTTP status, and whether checkout stores it on the key, is defined once, in the `ERRORS` table in `src/errors.ts`.
- Status classes:
  - **400** malformed.
  - **402** payment declined.
  - **404** unknown resource.
  - **409** conflict with current state, such as `INSUFFICIENT_STOCK` (listing every short line), `PRICE_CHANGED` or `COUPON_RESERVED`.
  - **422** semantically invalid, such as `CART_EMPTY`, `COUPON_INVALID` or `IDEMPOTENCY_KEY_REUSED`.
  - **503** safe to retry.
- Unknown errors become `500 INTERNAL`. They are logged with their Postgres code and never leak details to the client.
- The full code table is in the README.

## Implemented versus deferred

**Implemented:** everything the brief asks for, plus a fake payment gateway with pending-payment recovery, a coupon preview, an orders list for reconciling the report, and a small demo frontend. There are 251 backend tests against a real Postgres, including concurrency tests that hold a barrier so the race really happens.

**Deferred**, and how each would be finished:

- **Deployment.** It runs locally only (Docker Compose), which is what the brief asks for. Static hosting such as GitHub Pages can't run the API or Postgres. To deploy, I'd put the API on a container host with a managed Postgres, and the frontend next to it.
- **Admin authentication.** I'd add a token or session middleware on `/admin/*`.
- **A real PSP adapter with webhooks.** I'd keep the three phases and create the PaymentIntent before confirming it, so `cancel()` always has something to cancel.
- **A scheduled reconciler.** Recovery is lazy today. I'd run the same reconcile on a timer.
- **Refunds and cancellations.** They need the discount split across lines.
- **Retention and per-client scoping of idempotency keys.** These need auth first.
- **Pagination of the admin lists,** an OpenAPI spec (`requests.http` is used instead), and changing `n` after milestones exist.
- **Frontend tests.** The README walkthrough is the check.

## Multiple instances and production scale

- **Correctness already holds with N instances.** Every invariant lives in Postgres (locks, constraints, transactions), with no in-process state. The one exception is the fake gateway's memory, and a real PSP removes it.
- **A real PSP:** its webhook becomes the main way a pending order is resolved, with `retrieve()` as the fallback and reconcile on a schedule.
- **Side effects after payment** (receipt emails, an `OrderPaid` event): this is where a transactional outbox comes in. `finalizeOrder` writes the outbox row in the same transaction.
- **Hot products:** row locks serialize one SKU's reserve step. At flash-sale scale, a stock-reservation table or partitioned counters would replace them.
- **The report** scans every order. Counters kept by `finalizeOrder`, or a read replica, would fix that.
- **Connection pool size and `lock_timeout`** are set together, because lock waits hold connections.

## How AI tools were used

I built this with Claude Code. I wrote the project rules myself, in `.claude/rules/`: zod at every boundary, no follow-up deferral, simplicity over cleverness. The work went in stages:

1. A design doc, `architecture.html`, reviewed over four rounds by separate architect, engineer and tester agents.
2. A plan split into GitHub issues.
3. One PR per issue, each reviewed by agents and fixed before merge.

I made every product and behaviour call. The technical calls followed the reviewers unless I disagreed.

**Where I overrode or redirected the AI:**

- **Payments.** The AI recommended no payment abstraction at all, treating a commit as paid. I asked for a fake gateway that models real payments as closely as possible. That became the three-phase checkout, the pending state and recovery: the core of the design.
- **Retried failures.** The AI recommended re-executing a failed checkout on retry. I chose Stripe's rule instead: the first outcome is final.
- **Price changes.** The AI recommended an optional price guard. I made it required, so a customer is never charged a total they didn't see.
- **Stuck payments.** The AI recommended leaving them until an admin reconciles. I chose lazy recovery after a TTL, so a stuck payment can't block a cart until someone notices.
- **Triggering failures by hand.** The AI recommended controlling the fake only from tests. I asked for Stripe-style test tokens in the request, so a reviewer can trigger a decline or a timeout from `requests.http` or the UI.
- **Root cause over a quick fix.** When a required total made every coupon checkout fail once, the AI offered options. I asked what the root cause was first, and that led to the coupon preview rather than accepting an extra 409.
- **No cutting for time.** The first reviews proposed cuts to fit the timebox. I rejected them and asked for the reviewers' correctness fixes instead.
- **The workflow itself.** The review commands were filing "follow-up" issues for findings. I changed the rules so every finding is fixed in the PR that found it.
- **Testing the real app.** The test suite was green, but adding to the cart in the UI returned a 500. The cause was my dev database missing migrations, which the tests apply to their own database, so the suite could never see it. A browser pass through every scenario then found four UI bugs, which were fixed before merge.

**Where the AI corrected me, after research:** I suggested a transactional outbox and asked whether Stripe offers a ready-made fake. Neither fit. Stripe test mode needs credentials the brief forbids, and `stripe-mock` always returns success. An outbox needs a broker we don't have. I also chose "resolve stuck payments on the next report call", and the AI pointed out that this breaks "reports must not mutate state", so recovery never runs on a GET.

**Bugs the review agents caught in AI-written design:**

- a reused key on another cart returned a 500;
- a slow charge could be released and then succeed;
- the planned concurrency tests stayed green on broken code, until every test asserted exact status counts and zero 500s.

## What I would examine with another two hours

1. Run the concurrency suite many more times, under CPU load, to look for barrier timing that only passes on a fast machine.
2. Replace the fake with a real Stripe adapter against test mode, to check that create-then-confirm and cancel behave as the fake assumes.
3. Put a scheduled reconciler beside the lazy triggers, and measure the first request after a simulated gateway outage.
4. Load-test one hot SKU to see where row-lock contention starts to hurt.

## Time spent

About **8 hours of focused work with AI**, over the 4–6 hour guideline. The extra time went into modelling payments for real (the gateway, recovery and cancel-before-release) and into the review rounds before each merge. I chose correctness over staying inside the timebox.
