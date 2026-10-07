import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cartItems, orderItems, orders } from '../src/db/schema';
import { MAX_CART_LINES } from '../src/domain/money';
import { createTestApp } from './helpers/app';
import { barrier, holdLock } from './helpers/barrier';
import { bulkId, cartRequests, cartViewSchema, fillCart } from './helpers/carts';
import { newKey, postCheckout, stockOf, visa } from './helpers/checkout';
import { withCleanup } from './helpers/cleanup';
import { resetDb } from './helpers/db';
import { errorBodySchema } from './helpers/errors';

const { app, db, pool } = createTestApp();
const { newCart, putItem, cartWith } = cartRequests(app);

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

function statusCounts(responses: Response[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const { status } of responses) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

const cartLines = (cartId: string) =>
  db
    .select({ productId: cartItems.productId, quantity: cartItems.quantity })
    .from(cartItems)
    .where(eq(cartItems.cartId, cartId));

describe('T8 identical concurrent PUTs', () => {
  it('5 PUTs of one new line behind a cart barrier give {201:1, 200:4}, one row and one quantity', async () => {
    const cartId = await newCart();

    const responses = await barrier({ table: 'carts', id: cartId }, 5, () =>
      Array.from({ length: 5 }, () => putItem(cartId, 'p_keyboard', 2)),
    );

    expect(statusCounts(responses)).toEqual({ 201: 1, 200: 4 });
    const bodies = await Promise.all(responses.map(async (res) => cartViewSchema.parse(await res.json())));
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(await cartLines(cartId)).toEqual([{ productId: 'p_keyboard', quantity: 2 }]);

    const again = await putItem(cartId, 'p_keyboard', 2);
    expect(again.status).toBe(200);
    expect(await cartLines(cartId)).toEqual([{ productId: 'p_keyboard', quantity: 2 }]);
  });
});

describe('line cap under concurrency', () => {
  it(`2 new lines racing for the last slot behind a cart barrier give {201:1, 422:1} and ${MAX_CART_LINES} lines`, async () => {
    const cartId = await newCart();
    await fillCart(db, cartId, MAX_CART_LINES - 1);

    const responses = await barrier({ table: 'carts', id: cartId }, 2, () => [
      putItem(cartId, bulkId(MAX_CART_LINES), 1),
      putItem(cartId, bulkId(MAX_CART_LINES + 1), 1),
    ]);

    expect(statusCounts(responses)).toEqual({ 201: 1, 422: 1 });
    expect(await cartLines(cartId)).toHaveLength(MAX_CART_LINES);
  });
});

const LAMP_PAISE = 249_900;

const paidLampQuantity = async () => {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int` })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orders.status, 'paid'), eq(orderItems.productId, 'p_lamp')));
  return row?.n;
};

describe.each([
  { perCart: 1, paid: 3, stockLeft: 0, available: 0 },
  { perCart: 2, paid: 1, stockLeft: 1, available: 1 },
])('T1/T2 20 carts check out $perCart lamp(s) each (stock 3) behind a barrier on the lamp row', ({ perCart, paid, stockLeft, available }) => {
  it(`gives {201:${paid}, 409:${20 - paid}}, stock ${stockLeft}, and no 500s`, async () => {
    const cartIds = await Promise.all(Array.from({ length: 20 }, () => cartWith({ p_lamp: perCart })));

    const responses = await barrier({ table: 'products', id: 'p_lamp' }, 20, () =>
      cartIds.map((cartId) => postCheckout(app, cartId, newKey(), visa(LAMP_PAISE * perCart))),
    );

    expect(statusCounts(responses)).toEqual({ 201: paid, 409: 20 - paid });
    for (const res of responses.filter((r) => r.status === 409)) {
      const { error } = errorBodySchema.parse(await res.json());
      expect(error).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: [{ productId: 'p_lamp', requested: perCart, available }] });
    }
    expect(await stockOf(db, 'p_lamp')).toBe(stockLeft);
    expect(await paidLampQuantity()).toBe(paid * perCart);
  });
});

describe('holdLock', () => {
  const lockedSchema = z.tuple([z.object({ locked: z.boolean() })]);

  async function tryAdvisoryLock(key: number): Promise<boolean> {
    const result = await db.execute(sql`SELECT pg_try_advisory_xact_lock(${key}) AS locked`);
    return lockedSchema.parse(result.rows)[0].locked;
  }

  it('holds the advisory lock until release', async () => {
    const lock = await holdLock({ advisoryLock: 42 });
    await withCleanup(async () => expect(await tryAdvisoryLock(42)).toBe(false), lock.release);
    expect(await tryAdvisoryLock(42)).toBe(true);
  });
});
