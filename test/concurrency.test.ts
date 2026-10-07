import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cartItems, orderItems, orders } from '../src/db/schema';
import { MAX_CART_LINES } from '../src/domain/money';
import { createTestApp } from './helpers/app';
import { barrier, holdLock, lineUp } from './helpers/barrier';
import { bulkId, cartRequests, cartViewSchema, fillCart } from './helpers/carts';
import { FakeGateway } from '../src/modules/payments/fake-gateway';
import { expectOrder, idleInTransaction, newKey, orderCount, postCheckout, stockOf, visa } from './helpers/checkout';
import { withCleanup } from './helpers/cleanup';
import { resetDb } from './helpers/db';
import { errorBodySchema, expectError } from './helpers/errors';
import { gated } from './helpers/gate';
import { firstSettled, within } from './helpers/within';

const { app, appWith, db, pool } = createTestApp();
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

async function liveOrderOf(cartId: string): Promise<string | undefined> {
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.cartId, cartId));
  return order?.id;
}

describe('T3 one key sent 10 times behind a cart barrier, gated before the charge', () => {
  it('the 9 losers replay 202, the first returns 201 after release, and there is 1 order and 1 charge', async () => {
    const gate = gated(new FakeGateway(), { at: 'before' });
    const gatedApp = appWith(gate.gateway);
    const cartId = await cartWith({ p_lamp: 1 });
    const key = newKey();
    const send = () => postCheckout(gatedApp, cartId, key, visa(LAMP_PAISE));
    let requests: Promise<Response>[] = [];

    await withCleanup(
      async () => {
        requests = await lineUp({ table: 'carts', id: cartId }, 10, () => Array.from({ length: 10 }, send), async () =>
          gate.release(),
        );
        await gate.entered();
        const losers = await within(firstSettled(requests, 9), 'the 9 losers did not settle');
        const orderId = await liveOrderOf(cartId);
        for (const loser of losers) {
          expect((await expectOrder(loser, 202, { replayed: true })).id).toBe(orderId);
        }
        expect(await idleInTransaction(db)).toBe(0);

        gate.release();
        const winner = (await Promise.all(requests)).find((res) => !losers.includes(res));
        if (!winner) throw new Error('no winner');
        const paid = await expectOrder(winner, 201);
        expect(paid).toMatchObject({ id: orderId, status: 'paid' });

        expect(await expectOrder(await send(), 201, { replayed: true })).toEqual(paid);
        expect(await orderCount(db)).toBe(1);
        expect(gate.calls).toBe(1);
        expect(await stockOf(db, 'p_lamp')).toBe(2);
      },
      async () => gate.release(),
      () => Promise.allSettled(requests),
    );
  });
});

describe('T5 five keys on one cart behind a cart barrier, gated', () => {
  it('gives 4 × 409 CART_PAYMENT_PENDING with the order id, then one 201, and a losing key retried gets CART_CHECKED_OUT', async () => {
    const gate = gated(new FakeGateway(), { at: 'before' });
    const gatedApp = appWith(gate.gateway);
    const cartId = await cartWith({ p_lamp: 1 });
    const send = (key: string) => postCheckout(gatedApp, cartId, key, visa(LAMP_PAISE));
    let requests: Promise<{ key: string; res: Response }>[] = [];

    await withCleanup(
      async () => {
        requests = await lineUp(
          { table: 'carts', id: cartId },
          5,
          () => Array.from({ length: 5 }, async () => {
            const key = newKey();
            return { key, res: await send(key) };
          }),
          async () => gate.release(),
        );
        await gate.entered();
        const losers = await within(firstSettled(requests, 4), 'the 4 losers did not settle');
        const orderId = await liveOrderOf(cartId);
        for (const { res } of losers) {
          expect((await expectError(res, 409, 'CART_PAYMENT_PENDING')).details).toEqual({ orderId });
        }

        gate.release();
        const winner = (await Promise.all(requests)).find((request) => !losers.includes(request));
        if (!winner) throw new Error('no winner');
        expect((await expectOrder(winner.res, 201)).id).toBe(orderId);

        const [loser] = losers;
        if (!loser) throw new Error('no loser');
        const retried = await send(loser.key);
        expect((await expectError(retried, 409, 'CART_CHECKED_OUT')).details).toEqual({ orderId });
        expect(await orderCount(db)).toBe(1);
        expect(await stockOf(db, 'p_lamp')).toBe(2);
      },
      async () => gate.release(),
      () => Promise.allSettled(requests),
    );
  });
});

describe('T7 opposite-order carts', () => {
  it('10 pairs of [keyboard, mouse] and [mouse, keyboard] all pay, with no 500s and no deadlock', async () => {
    const carts = await Promise.all(
      Array.from({ length: 10 }, () => [cartWith({ p_keyboard: 1, p_mouse: 1 }), cartWith({ p_mouse: 1, p_keyboard: 1 })]).flat(),
    );

    const responses = await Promise.all(carts.map((cartId) => postCheckout(app, cartId, newKey(), visa(499_900 + 129_950))));

    expect(statusCounts(responses)).toEqual({ 201: 20 });
    expect(await stockOf(db, 'p_keyboard')).toBe(30);
    expect(await stockOf(db, 'p_mouse')).toBe(80);
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
