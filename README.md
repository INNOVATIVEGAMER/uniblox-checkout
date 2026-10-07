# Uniblox Checkout

The backend for a checkout and rewards service: carts, idempotent checkout, milestone coupons and admin reporting. It is built with Node 22, TypeScript, Hono, Drizzle and PostgreSQL 16.

The design lives in [`architecture.html`](architecture.html), and the reasoning behind each choice is in [`DECISIONS.md`](DECISIONS.md).

## Submission notes

- **Time spent:** about 8 hours of focused work with AI (Claude Code), over the 4–6 hour guideline. The extra time went into modelling payments (a fake gateway with pending-payment recovery) and into review rounds before each merge. How AI was used is in [`DECISIONS.md`](DECISIONS.md#how-ai-tools-were-used).
- **Incomplete:** nothing the brief requires. The deferred items, and how each would be finished, are in [`DECISIONS.md`](DECISIONS.md#implemented-versus-deferred). Nothing is deployed: it runs locally with Docker, as the brief asks.
- **History:** each issue was built in its own PR and squash-merged, so `main` has one commit per step. The [merged PRs](../../pulls?q=is%3Apr+is%3Amerged) (#8–#17) show the commits and the review rounds inside each step.
- **Admin routes:** everything under `/admin` is administrative and unauthenticated, as the brief allows.

## Setup

You need Node 22 or later, pnpm 10, and Docker.

```sh
docker compose up -d --wait   # Postgres 16 on localhost:5432, with databases checkout and checkout_test
pnpm install
pnpm db:migrate               # apply the migrations in drizzle/
pnpm db:seed                  # load the 5 seed products (safe to re-run; resets them to seed values)
pnpm dev                      # http://localhost:3000, restarts on change
```

- `pnpm test` runs the whole suite against `checkout_test`. It applies the migrations itself, and it truncates and reseeds before every test.
  - The suite refuses to run against any database whose name doesn't end in `_test`.
  - Point it elsewhere with `TEST_DATABASE_URL`.
- `pnpm typecheck` and `pnpm lint` run the static checks.
- **If `checkout_test` is missing:** Postgres runs `docker/initdb/` only when its data volume is empty. If the volume already existed, recreate it with `docker compose down -v && docker compose up -d --wait`.

### Configuration

Every variable is optional. The defaults match `docker-compose.yml`.

| Variable                      | Default                                               | Rule                                  |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------- |
| `DATABASE_URL`                | `postgres://checkout:checkout@localhost:5432/checkout` | URL                                   |
| `PORT`                        | `3000`                                                |                                       |
| `COUPON_EVERY_N_ORDERS` (n)   | `5`                                                   | integer ≥ 1                           |
| `COUPON_PERCENT_OFF` (x)      | `10`                                                  | integer 1–100                         |
| `PAYMENT_PENDING_TTL_SECONDS` | `300`                                                 | at least 10 × `GATEWAY_TIMEOUT_MS`    |
| `GATEWAY_TIMEOUT_MS`          | `10000`                                               |                                       |
| `LOCK_TIMEOUT_MS`             | `5000`                                                | a longer lock wait returns 503        |

The service refuses to start if any value breaks its rule.

## Demo UI

`web/` is a small Next.js app that drives the API from a browser. It is a thin client: a panel on every page shows the latest call's method, path, status, `Idempotency-Key`, `Idempotent-Replayed`, `Retry-After` and raw JSON body, and every error is shown as the API's `code`, `message` and `details`. It has no tests of its own; the walkthrough below is the check.

Start the API with settings that make the demo fit in two minutes. Leave it running for the whole walkthrough: the fake gateway keeps its charges in memory, so a restart turns a timed-out approved payment into an abandoned one.

```sh
COUPON_EVERY_N_ORDERS=1 GATEWAY_TIMEOUT_MS=1000 PAYMENT_PENDING_TTL_SECONDS=10 pnpm dev
```

- `COUPON_EVERY_N_ORDERS=1` makes every paid order a coupon milestone.
- `PAYMENT_PENDING_TTL_SECONDS=10` lets reconcile resolve a pending payment after 10 seconds. `GATEWAY_TIMEOUT_MS=1000` is there only because the TTL must be at least 10 × the gateway timeout. The fake gateway never actually waits.

Then, in another terminal:

```sh
cd web
pnpm install
pnpm dev        # http://localhost:3001
```

The app proxies `/api/*` to `API_URL` (default `http://localhost:3000`), read when `pnpm dev` starts. A 500 with no error envelope means the API isn't running. In `web/`, `pnpm typecheck`, `pnpm lint` and `pnpm build` run the static checks.

### Walkthrough

Start from a clean database (`pnpm db:seed` resets the products).

1. **No milestone yet.** Admin → Coupons → Generate: `409 NO_ELIGIBLE_MILESTONE` with `details.paidOrders` and `nextMilestoneAt`.
2. **Happy path.** Shop: add a mouse, pay with `pm_card_visa`: `201`, the order is paid. Generate a coupon: `201` with `remainingEligible: 0`.
3. **Retry and double submit.** Press **Retry same key**: the same order, `Idempotent-Replayed: true`. Press **Change body, same key**: `422 IDEMPOTENCY_KEY_REUSED`. New cart, add a cable, **Double submit**: two results with the same order ID, one of them replayed.
4. **Coupon.** New cart, add a keyboard, apply the coupon: the preview shows the discount. Pay: `201`. The order page shows the frozen unit prices, the coupon, the discount and the total. Apply the same code on a new cart: `409 COUPON_ALREADY_REDEEMED`. A made-up code gives `422 COUPON_INVALID`.
5. **Decline.** Admin → Coupons → Generate another coupon. New cart, add a lamp, apply that coupon, pay with `pm_card_chargeDeclined`: `402 PAYMENT_FAILED`, and the lamp's stock and the coupon are released (Products and Coupons show it). The cart is open again, so you can pay with a new attempt.
6. **Unknown outcome.** On that cart, with the coupon, pay with `tok_timeout_approved`: `202` with `Retry-After: 5`, and the cart is `pending_payment`. **Pay (new attempt)** on it again sends a new key: `409 CART_PAYMENT_PENDING` with the order's id. On a new cart with a cable, the same coupon previews `409 COUPON_RESERVED`. Wait 10 seconds without touching the shop (any cart change on that product or coupon would resolve it first), then Admin → Reconcile: the order is resolved as `paid`, and the coupon is `redeemed`.
7. **Price change.** New cart, add a cable. Open Admin in a **second tab** and change the cable's price. Back in the first tab, which still shows the old total, pay: `409 PRICE_CHANGED` with the current breakdown in `details`. The cart refreshes, and a new attempt succeeds. Dropping the stock below the cart's quantity instead gives `409 INSUFFICIENT_STOCK`.
8. **Report.** Admin → Report: net revenue equals the sum of the totals in Orders filtered by `paid`, and redeemed coupons equal paid orders with a coupon.

## API

JSON over HTTP. Money is always an integer number of paise (INR), in fields named `*Paise`. A request with a body must send `Content-Type: application/json`. Runnable examples of every endpoint, success and error, are in [`requests.http`](requests.http).

### Endpoints

Admin routes are under `/admin` and unauthenticated, as the brief allows. Any route that waits on a lock can also return `503 LOCK_TIMEOUT`.

| Method and path | Request | Success | Main errors |
| --- | --- | --- | --- |
| `GET /products` | | 200: every product | |
| `PATCH /admin/products/:id` (admin) | any of `{ name, pricePaise, stock }` | 200: the product | 400, 404 `PRODUCT_NOT_FOUND` |
| `POST /carts` | | 201: an empty cart | |
| `GET /carts/:id?couponCode=` | optional `couponCode` previews the discount, reserving nothing | 200: the cart | 404 `CART_NOT_FOUND`, plus the coupon errors checkout would give |
| `PUT /carts/:id/items/:productId` | `{ quantity }`, 1–1000. Sets the quantity, so a retry is harmless | 201 added, 200 changed: the cart | 404, 409 `INSUFFICIENT_STOCK`, 409 `CART_PAYMENT_PENDING` / `CART_CHECKED_OUT`, 422 `CART_LINE_LIMIT` |
| `DELETE /carts/:id/items/:productId` | | 200: the cart, even if the line wasn't there | 404, 409 cart not open |
| `POST /carts/:id/checkout` | header `Idempotency-Key`; `{ expectedTotalPaise, paymentToken, couponCode? }` | 201 paid, or 202 + `Retry-After` when the payment outcome is unknown: the order | 402 `PAYMENT_FAILED`, 409 `PRICE_CHANGED` / `INSUFFICIENT_STOCK` / coupon errors, 422 `CART_EMPTY` / `IDEMPOTENCY_KEY_REUSED` |
| `GET /orders/:id` | | 200: the order | 404 `ORDER_NOT_FOUND` |
| `POST /admin/coupons` (admin) | | 201: `{ coupon, remainingEligible }` | 409 `NO_ELIGIBLE_MILESTONE` |
| `GET /admin/coupons` (admin) | | 200: every coupon | |
| `GET /admin/orders?status=` (admin) | optional `pending_payment`, `paid` or `failed` | 200: orders, oldest first | 400 |
| `GET /admin/report` (admin) | | 200: the report | |
| `POST /admin/payments/reconcile` (admin) | | 200: `{ resolved, stillPending }` | |

**Checkout retries.** A retry with the same `Idempotency-Key` never charges again: it replays the first outcome with `Idempotent-Replayed: true`. To poll a 202, re-send the same request. To try again after a failure, use a new key.

**Payment tokens.** The fake gateway understands Stripe's test tokens, plus two of its own:

| `paymentToken` | Outcome |
| --- | --- |
| `pm_card_visa` | Approved: 201 |
| `pm_card_chargeDeclined` | Declined: 402, reason `card_declined` |
| `pm_card_chargeDeclinedInsufficientFunds` | Declined: 402, reason `insufficient_funds` |
| `tok_timeout_approved` | Approved, but the response times out: 202 |
| `tok_timeout_declined` | Declined, but the response times out: 202 |
| anything else | Declined: 402, reason `invalid_payment_method` |

A 202 order holds its stock and coupon. It is resolved once it is older than `PAYMENT_PENDING_TTL_SECONDS`, by the next request it would block or by `POST /admin/payments/reconcile`.

### Errors

Every error is `{ "error": { "code", "message", "details"? } }`. Clients branch on `code`; `details` carries what the client needs to act. The **Retry same key** column says whether checkout stores the error as the key's final answer.

| Status | Code | When | Retry same key |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | A malformed parameter or body, or a non-JSON Content-Type. `details` lists each field | yes |
| 400 | `IDEMPOTENCY_KEY_INVALID` | The checkout key is missing, empty or over 255 characters | yes |
| 402 | `PAYMENT_FAILED` | The payment was declined. The stock and coupon are released, and the cart reopens. `details`: `{ orderId, reason }` | replays the 402 |
| 404 | `PRODUCT_NOT_FOUND` / `CART_NOT_FOUND` / `ORDER_NOT_FOUND` / `NOT_FOUND` | Unknown product, cart, order or route | no |
| 409 | `CART_CHECKED_OUT` | The cart already has a paid order. `details`: `{ orderId }` | no |
| 409 | `CART_PAYMENT_PENDING` | A payment for this cart is in progress. `details`: `{ orderId }` | yes |
| 409 | `INSUFFICIENT_STOCK` | `details` lists every short line as `{ productId, requested, available }` | no |
| 409 | `PRICE_CHANGED` | `expectedTotalPaise` is stale. `details`: the current `{ subtotalPaise, discountPaise, totalPaise }` | no |
| 409 | `COUPON_RESERVED` | Another payment in progress holds the coupon | yes |
| 409 | `COUPON_ALREADY_REDEEMED` | The coupon was used | no |
| 409 | `NO_ELIGIBLE_MILESTONE` | No milestone is waiting for a coupon. `details`: `{ paidOrders, nextMilestoneAt }` | |
| 422 | `CART_EMPTY` | Checking out a cart with no lines | no |
| 422 | `CART_LINE_LIMIT` | A new line on a cart that already has 50 | |
| 422 | `COUPON_INVALID` | No coupon has this code | no |
| 422 | `IDEMPOTENCY_KEY_REUSED` | The key was used with a different cart, coupon, total or token | no |
| 500 | `INTERNAL` | Unexpected. Logged, and no internals are returned | yes |
| 503 | `LOCK_TIMEOUT` | A lock wait passed `LOCK_TIMEOUT_MS` | yes |

### Response shapes

**Cart** (every cart route). `totalPaise` is exactly what checkout accepts as `expectedTotalPaise`. `coupon` is set only when previewing with `?couponCode=`.

```json
{
  "id": "5f0c6a0e-…", "status": "open", "orderId": null,
  "lines": [{ "productId": "p_cable", "name": "USB-C Cable", "unitPricePaise": 34999, "quantity": 3, "lineTotalPaise": 104997, "available": true }],
  "subtotalPaise": 104997, "coupon": null, "discountPaise": 0, "totalPaise": 104997
}
```

**Order** (checkout, `GET /orders/:id`, the admin list). The lines are a snapshot taken at checkout, so later product edits never change an order.

```json
{
  "id": "0b8f2d4e-…", "cartId": "5f0c6a0e-…", "status": "paid",
  "subtotalPaise": 104997, "discountPaise": 10499, "totalPaise": 94498,
  "coupon": { "code": "SAVE10-M1-7K3QZ9XA", "percentOff": 10 },
  "paymentRef": "ch_…", "failureReason": null,
  "createdAt": "2026-10-07T10:00:00.000Z", "resolvedAt": "2026-10-07T10:00:00.120Z",
  "lines": [{ "productId": "p_cable", "productName": "USB-C Cable", "unitPricePaise": 34999, "quantity": 3, "lineTotalPaise": 104997 }]
}
```

**Report.** Sales count paid orders only, and net is gross less discounts. Summing `GET /admin/orders?status=paid` gives the same sales figures.

```json
{
  "paidOrders": 4,
  "ordersByStatus": { "paid": 4, "pending_payment": 1, "failed": 1 },
  "quantityByProduct": [{ "productId": "p_cable", "name": "USB-C Cable", "quantity": 3 }],
  "grossRevenuePaise": 354897, "discountsPaise": 24990, "netRevenuePaise": 329907,
  "coupons": { "generated": 2, "available": 0, "reserved": 1, "redeemed": 1 },
  "milestones": { "n": 2, "reached": 2, "rewarded": 2, "unrewarded": 0 }
}
```
