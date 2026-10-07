# Uniblox Checkout

The backend for a checkout and rewards service: carts, idempotent checkout, milestone coupons and admin reporting. It is built with Node 22, TypeScript, Hono, Drizzle and PostgreSQL 16.

The design lives in [`architecture.html`](architecture.html), and the reasoning behind each choice is in [`DECISIONS.md`](DECISIONS.md).

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

## API

JSON over HTTP. Money is always an integer number of paise (INR), in fields named `*Paise`. A request with a body must send `Content-Type: application/json`. Routes under `/admin` are administrative. They are unauthenticated by design, because the brief allows it.

Runnable examples are in [`requests.http`](requests.http).

### Errors

Every error uses one envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request is invalid",
    "details": [{ "path": "json.stock", "message": "Too small: expected number to be >=0" }]
  }
}
```

`code` is the stable contract to branch on, and `message` is for humans. `details` is present when there is something to act on: for a validation error, it lists each failing field.

| Status | Code               | When                                                                                                |
| ------ | ------------------ | --------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR` | A malformed path parameter or body field, malformed JSON, a non-JSON Content-Type, or an empty PATCH |
| 404    | `PRODUCT_NOT_FOUND` | The product ID in the path does not exist                                                           |
| 404    | `CART_NOT_FOUND`   | The cart ID in the path does not exist                                                              |
| 404    | `NOT_FOUND`        | No route matches the method and path                                                                |
| 409    | `CART_CHECKED_OUT` | The cart is checked out, so it can no longer change                                                 |
| 409    | `CART_PAYMENT_PENDING` | A payment for the cart is in progress. Retry once it resolves                                   |
| 409    | `INSUFFICIENT_STOCK` | The requested quantity is above the stock available. `details` lists `{ productId, requested, available }` |
| 422    | `CART_LINE_LIMIT`  | Adding a new line to a cart that already has 50 lines. `details` is `{ maxLines }`                  |
| 500    | `INTERNAL`         | An unexpected failure. It is logged, and no internals are returned                                  |
| 503    | `LOCK_TIMEOUT`     | A row lock was not granted within `LOCK_TIMEOUT_MS`. Safe to retry                                  |

### `GET /products`

Lists every product, ordered by ID. `stock` is the stock available to sell.

**200**

```json
[
  { "id": "p_cable", "name": "USB-C Cable", "pricePaise": 34999, "stock": 500 },
  { "id": "p_keyboard", "name": "Mechanical Keyboard", "pricePaise": 499900, "stock": 50 }
]
```

### `PATCH /admin/products/:id` (admin)

Changes a product's name, price, or the stock available to sell. Send at least one field. Fields that are left out stay unchanged.

- **`:id`:** matches `^p_[a-z0-9_]{1,60}$`.
- **`name`:** a string, trimmed, 1–200 characters.
- **`pricePaise`:** an integer from 0 to 1,000,000,000.
- **`stock`:** an integer from 0 to 2,147,483,647. This is the stock available to sell, so units held by a pending payment are not included.

Unknown fields are rejected.

```http
PATCH /admin/products/p_lamp
Content-Type: application/json

{ "pricePaise": 199999, "stock": 10 }
```

**200**: the updated product.

```json
{ "id": "p_lamp", "name": "Limited Edition Desk Lamp", "pricePaise": 199999, "stock": 10 }
```

| Status | Code                | When                                                                                |
| ------ | ------------------- | ----------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`  | A malformed `:id`, an empty or invalid body, an unknown field, or a non-JSON Content-Type |
| 404    | `PRODUCT_NOT_FOUND` | No product has this ID                                                              |
| 503    | `LOCK_TIMEOUT`      | The product row is locked by another transaction for longer than `LOCK_TIMEOUT_MS`  |

### Carts

A cart's ID is a UUID. Its lines are priced live: each view reads the current product prices and stock. Cart mutations are safe to retry, so none of them needs an idempotency key.

The cart view, returned by every cart route:

```json
{
  "id": "5f0c6a0e-3b1d-4c2a-9e7f-1a2b3c4d5e6f",
  "status": "open",
  "lines": [
    {
      "productId": "p_cable",
      "name": "USB-C Cable",
      "unitPricePaise": 34999,
      "quantity": 3,
      "lineTotalPaise": 104997,
      "available": true
    }
  ],
  "subtotalPaise": 104997,
  "discountPaise": 0,
  "totalPaise": 104997
}
```

- **`status`:** `open`, `pending_payment` or `checked_out`. Only an `open` cart can change.
- **`lines`:** ordered by product ID. `available` is `stock >= quantity` right now, so it can turn false after an admin lowers the stock.
- **`totalPaise`:** `subtotalPaise − discountPaise`. The discount stays 0 until coupons arrive.

### `POST /carts`

Creates an empty cart. No body.

**201**: the cart view, with no lines.

### `GET /carts/:id`

**200**: the cart view, in any status.

| Status | Code               | When                        |
| ------ | ------------------ | --------------------------- |
| 400    | `VALIDATION_ERROR` | `:id` is not a UUID         |
| 404    | `CART_NOT_FOUND`   | No cart has this ID         |

### `PUT /carts/:id/items/:productId`

Sets the line's quantity. This covers both "add to cart" and "change the quantity": sending the same request twice leaves the same cart.

- **`:productId`:** matches `^p_[a-z0-9_]{1,60}$`.
- **`quantity`:** an integer from 1 to 1000. To remove a line, use `DELETE`.

```http
PUT /carts/5f0c6a0e-3b1d-4c2a-9e7f-1a2b3c4d5e6f/items/p_cable
Content-Type: application/json

{ "quantity": 3 }
```

**201** when the line was added, **200** when an existing line was changed. Both return the cart view.

The stock check here is soft: it compares against the stock at this moment and reserves nothing. Checkout makes the authoritative check.

When a request breaks more than one rule, the first failing check in this order decides the error: the request shape (400), the cart (404, then 409 for a locked status), the product (404), the stock (409), then the line cap (422).

| Status | Code                   | When                                                                         |
| ------ | ---------------------- | ---------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`     | A malformed `:id` or `:productId`, a quantity outside 1–1000 or not an integer, an unknown field, or a non-JSON Content-Type |
| 404    | `CART_NOT_FOUND`       | No cart has this ID                                                          |
| 404    | `PRODUCT_NOT_FOUND`    | No product has this ID                                                       |
| 409    | `CART_PAYMENT_PENDING` | The cart's payment is in progress                                            |
| 409    | `CART_CHECKED_OUT`     | The cart is checked out                                                      |
| 409    | `INSUFFICIENT_STOCK`   | `quantity` is above the product's stock                                      |
| 422    | `CART_LINE_LIMIT`      | The line is new and the cart already has 50 lines. Changing an existing line is always allowed |
| 503    | `LOCK_TIMEOUT`         | The cart is locked by another request for longer than `LOCK_TIMEOUT_MS`     |

### `DELETE /carts/:id/items/:productId`

Removes the line. Removing a line that isn't in the cart also succeeds, so a retried DELETE gets the same answer.

**200**: the cart view.

| Status | Code                   | When                                                                     |
| ------ | ---------------------- | ------------------------------------------------------------------------ |
| 400    | `VALIDATION_ERROR`     | A malformed `:id` or `:productId`                                        |
| 404    | `CART_NOT_FOUND`       | No cart has this ID                                                      |
| 409    | `CART_PAYMENT_PENDING` | The cart's payment is in progress                                        |
| 409    | `CART_CHECKED_OUT`     | The cart is checked out                                                  |
| 503    | `LOCK_TIMEOUT`         | The cart is locked by another request for longer than `LOCK_TIMEOUT_MS`  |
