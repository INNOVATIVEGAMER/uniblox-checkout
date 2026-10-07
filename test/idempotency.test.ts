import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { carts, coupons, idempotencyKeys, products } from '../src/db/schema';
import type { ErrorCode } from '../src/errors';
import { FakeGateway } from '../src/modules/payments/fake-gateway';
import { createTestApp, sendJson } from './helpers/app';
import { barrier, holdLock } from './helpers/barrier';
import { cartRequests, cartViewSchema } from './helpers/carts';
import {
  type CheckoutBody,
  expectOrder,
  keyRow,
  newKey,
  orderCount,
  postCheckout,
  stockOf,
  visa,
} from './helpers/checkout';
import { withCleanup } from './helpers/cleanup';
import { couponRow, insertCoupon, withTenPercent } from './helpers/coupons';
import { resetDb, snapshotDb } from './helpers/db';
import { errorBodySchema, expectError } from './helpers/errors';
import { gated } from './helpers/gate';
import { priceOf } from './helpers/products';

const { app, appWith, db, pool } = createTestApp();
const { cartWith, newCart, putItem, getCart } = cartRequests(app);

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

const patchProduct = (id: string, change: Record<string, unknown>) => sendJson(app, 'PATCH', `/admin/products/${id}`, change);

/** Sends the checkout, asserts a first (not replayed) error, then asserts its storage and replay. */
async function expectStoredFinal(cartId: string, key: string, body: CheckoutBody, status: number, code: ErrorCode) {
  const first = await postCheckout(app, cartId, key, body);
  expect(first.headers.get('Idempotent-Replayed')).toBeNull();
  const firstBody: unknown = await first.clone().json();
  const error = await expectError(first, status, code);

  expect(await keyRow(db, key)).toMatchObject({ orderId: null, responseStatus: status, responseBody: firstBody });

  const replay = await postCheckout(app, cartId, key, body);
  expect(replay.status).toBe(status);
  expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
  expect(await replay.json()).toEqual(firstBody);
  return error;
}

describe('T20 storage rule: final codes store the response and replay it', () => {
  it.each<[ErrorCode, number, () => Promise<{ cartId: string; body: CheckoutBody }>]>([
    ['CART_NOT_FOUND', 404, async () => ({ cartId: randomUUID(), body: visa(0) })],
    [
      'CART_CHECKED_OUT',
      409,
      async () => {
        const cartId = await cartWith({ p_mouse: 1 });
        await expectOrder(await postCheckout(app, cartId, newKey(), visa(priceOf('p_mouse'))), 201);
        return { cartId, body: visa(priceOf('p_mouse')) };
      },
    ],
    [
      'INSUFFICIENT_STOCK',
      409,
      async () => {
        const cartId = await cartWith({ p_lamp: 2 });
        await patchProduct('p_lamp', { stock: 1 });
        return { cartId, body: visa(2 * priceOf('p_lamp')) };
      },
    ],
    ['PRICE_CHANGED', 409, async () => ({ cartId: await cartWith({ p_mouse: 1 }), body: visa(priceOf('p_mouse') - 1) })],
    ['CART_EMPTY', 422, async () => ({ cartId: await newCart(), body: visa(0) })],
    ['COUPON_INVALID', 422, async () => ({ cartId: await cartWith({ p_mouse: 1 }), body: { ...visa(priceOf('p_mouse')), couponCode: 'SAVE10-NOPE' } })],
    [
      'COUPON_ALREADY_REDEEMED',
      409,
      async () => {
        const coupon = await insertCoupon(db);
        await db.update(coupons).set({ status: 'redeemed', redeemedAt: new Date() }).where(eq(coupons.id, coupon.id));
        return { cartId: await cartWith({ p_mouse: 1 }), body: { ...visa(withTenPercent(priceOf('p_mouse'))), couponCode: coupon.code } };
      },
    ],
  ])('%s (%i)', async (code, status, setup) => {
    const { cartId, body } = await setup();
    await expectStoredFinal(cartId, newKey(), body, status, code);
  });

  it('CART_EMPTY stays the answer after an item is added: the same key replays 422', async () => {
    const cartId = await newCart();
    const key = newKey();
    await expectStoredFinal(cartId, key, visa(0), 422, 'CART_EMPTY');

    await putItem(cartId, 'p_mouse', 1);
    const replay = await postCheckout(app, cartId, key, visa(0));
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    await expectError(replay, 422, 'CART_EMPTY');
  });

  it('CART_CHECKED_OUT carries the paid order id', async () => {
    const cartId = await cartWith({ p_mouse: 1 });
    const paid = await expectOrder(await postCheckout(app, cartId, newKey(), visa(priceOf('p_mouse'))), 201);
    const error = await expectStoredFinal(cartId, newKey(), visa(priceOf('p_mouse')), 409, 'CART_CHECKED_OUT');
    expect(error.details).toEqual({ orderId: paid.id });
  });
});

describe('T20 storage rule: a decline is replayed from the order', () => {
  it.each([
    ['pm_card_chargeDeclined', 'card_declined'],
    ['pm_card_chargeDeclinedInsufficientFunds', 'insufficient_funds'],
    ['tok_not_a_card', 'invalid_payment_method'],
  ])('%s gives 402 with reason %s, and the same key replays it', async (paymentToken, reason) => {
    const cartId = await cartWith({ p_mouse: 1 });
    const key = newKey();
    const body = { expectedTotalPaise: priceOf('p_mouse'), paymentToken };

    const first = await postCheckout(app, cartId, key, body);
    expect(first.headers.get('Idempotent-Replayed')).toBeNull();
    const error = await expectError(first, 402, 'PAYMENT_FAILED');
    expect(error.details).toEqual({ orderId: expect.any(String), reason });
    expect(await keyRow(db, key)).toMatchObject({ orderId: expect.any(String), responseStatus: null, responseBody: null });

    const replay = await postCheckout(app, cartId, key, body);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect((await expectError(replay, 402, 'PAYMENT_FAILED')).details).toEqual(error.details);
  });
});

describe('T20 storage rule: transient codes and 400s leave no key row', () => {
  const keyCount = () => db.$count(idempotencyKeys);

  it('CART_PAYMENT_PENDING stores nothing for the second key', async () => {
    const gate = gated(new FakeGateway(), { at: 'before' });
    const gatedApp = appWith(gate.gateway);
    const cartId = await cartWith({ p_mouse: 1 });
    const first = postCheckout(gatedApp, cartId, newKey(), visa(priceOf('p_mouse')));

    await withCleanup(
      async () => {
        await gate.entered();
        const key = newKey();
        const res = await postCheckout(gatedApp, cartId, key, visa(priceOf('p_mouse')));
        expect(res.headers.get('Idempotent-Replayed')).toBeNull();
        await expectError(res, 409, 'CART_PAYMENT_PENDING');
        expect(await keyRow(db, key)).toBeUndefined();
      },
      async () => gate.release(),
      () => Promise.allSettled([first]),
    );
  });

  it('COUPON_RESERVED stores nothing for the second cart', async () => {
    const coupon = await insertCoupon(db);
    const gate = gated(new FakeGateway(), { at: 'before' });
    const gatedApp = appWith(gate.gateway);
    const total = withTenPercent(priceOf('p_mouse'));
    const first = postCheckout(gatedApp, await cartWith({ p_mouse: 1 }), newKey(), { ...visa(total), couponCode: coupon.code });

    await withCleanup(
      async () => {
        await gate.entered();
        const key = newKey();
        const res = await postCheckout(gatedApp, await cartWith({ p_mouse: 1 }), key, { ...visa(total), couponCode: coupon.code });
        expect(res.headers.get('Idempotent-Replayed')).toBeNull();
        await expectError(res, 409, 'COUPON_RESERVED');
        expect(await keyRow(db, key)).toBeUndefined();
      },
      async () => gate.release(),
      () => Promise.allSettled([first]),
    );
  });

  it.each([
    ['VALIDATION_ERROR', { expectedTotalPaise: -1, paymentToken: 'pm_card_visa' }, newKey()],
    ['IDEMPOTENCY_KEY_INVALID', visa(priceOf('p_mouse')), ''],
  ] as const)('400 %s stores nothing', async (code, body, key) => {
    const cartId = await cartWith({ p_mouse: 1 });
    await expectError(await postCheckout(app, cartId, key, body), 400, code);
    expect(await keyCount()).toBe(0);
  });

  it('IDEMPOTENCY_KEY_REUSED leaves the existing key row unchanged and is not a replay', async () => {
    const cartId = await cartWith({ p_mouse: 1 });
    const key = newKey();
    await expectOrder(await postCheckout(app, cartId, key, visa(priceOf('p_mouse'))), 201);
    const before = await keyRow(db, key);

    const res = await postCheckout(app, cartId, key, { expectedTotalPaise: priceOf('p_mouse'), paymentToken: 'pm_card_chargeDeclined' });
    expect(res.headers.get('Idempotent-Replayed')).toBeNull();
    await expectError(res, 422, 'IDEMPOTENCY_KEY_REUSED');
    expect(await keyRow(db, key)).toEqual(before);
    expect(await keyCount()).toBe(1);
  });
});

describe('T21 price changed after add', () => {
  it('gets 409 PRICE_CHANGED with the breakdown, replays it, creates no order, and a new key with the new total pays', async () => {
    const cartId = await cartWith({ p_lamp: 1 });
    expect((await patchProduct('p_lamp', { pricePaise: 200_000 })).status).toBe(200);
    const key = newKey();

    const error = await expectStoredFinal(cartId, key, visa(priceOf('p_lamp')), 409, 'PRICE_CHANGED');
    expect(error.details).toEqual({ subtotalPaise: 200_000, discountPaise: 0, totalPaise: 200_000 });
    expect(await orderCount(db)).toBe(0);
    expect(await stockOf(db, 'p_lamp')).toBe(3);

    const paid = await expectOrder(await postCheckout(app, cartId, newKey(), visa(200_000)), 201);
    expect(paid.totalPaise).toBe(200_000);
  });

  it("accepts the coupon preview's totalPaise first time, with the discount floored once at order level", async () => {
    const coupon = await insertCoupon(db);
    const cartId = await cartWith({ p_cable: 3, p_mouse: 1 });
    const res = await app.request(`/carts/${cartId}?couponCode=${coupon.code.toLowerCase()}`);
    expect(res.status).toBe(200);
    const preview = cartViewSchema.parse(await res.json());
    expect(preview).toMatchObject({ subtotalPaise: 3 * priceOf('p_cable') + priceOf('p_mouse'), discountPaise: 23_494, totalPaise: 211_453, coupon: { code: coupon.code, percentOff: 10 } });

    const paid = await expectOrder(await postCheckout(app, cartId, newKey(), { ...visa(preview.totalPaise), couponCode: coupon.code }), 201);
    expect(paid).toMatchObject({ discountPaise: 23_494, totalPaise: 211_453 });
  });

  it("accepts the cart view's totalPaise first time", async () => {
    const cartId = await cartWith({ p_cable: 3, p_mouse: 1 });
    const { totalPaise } = await getCart(cartId);
    await expectOrder(await postCheckout(app, cartId, newKey(), visa(totalPaise)), 201);
  });
});

describe('T22 a stock failure consumes nothing', () => {
  it('reports every short line, writes nothing, replays 409, and a new key pays after a restock', async () => {
    const cartId = await cartWith({ p_lamp: 2, p_monitor: 3, p_mouse: 1 });
    await patchProduct('p_lamp', { stock: 1 });
    await patchProduct('p_monitor', { stock: 2 });
    const total = 2 * priceOf('p_lamp') + 3 * priceOf('p_monitor') + priceOf('p_mouse');
    const before = await snapshotDb(db);
    const key = newKey();

    const first = await postCheckout(app, cartId, key, visa(total));
    const error = await expectError(first, 409, 'INSUFFICIENT_STOCK');
    expect(error.details).toEqual([
      { productId: 'p_lamp', requested: 2, available: 1 },
      { productId: 'p_monitor', requested: 3, available: 2 },
    ]);
    const after = await snapshotDb(db);
    delete after.idempotency_keys;
    delete before.idempotency_keys;
    expect(after).toEqual(before);
    const [cart] = await db.select({ status: carts.status }).from(carts).where(eq(carts.id, cartId));
    expect(cart?.status).toBe('open');

    await db.update(products).set({ stock: 10 });
    const replay = await postCheckout(app, cartId, key, visa(total));
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(errorBodySchema.parse(await replay.json()).error).toEqual(error);

    await expectOrder(await postCheckout(app, cartId, newKey(), visa(total)), 201);
  });
});

describe('T22 a stock failure with a coupon', () => {
  it('leaves the coupon available, replays 409, and a new key redeems it after a restock', async () => {
    const coupon = await insertCoupon(db);
    const cartId = await cartWith({ p_lamp: 2 });
    await patchProduct('p_lamp', { stock: 1 });
    const body = { ...visa(withTenPercent(2 * priceOf('p_lamp'))), couponCode: coupon.code };
    const key = newKey();

    await expectStoredFinal(cartId, key, body, 409, 'INSUFFICIENT_STOCK');
    expect(await couponRow(db, coupon.code)).toEqual({ status: 'available', redeemedAt: null });
    expect(await orderCount(db)).toBe(0);

    await patchProduct('p_lamp', { stock: 3 });
    const paid = await expectOrder(await postCheckout(app, cartId, newKey(), body), 201);
    expect(paid.coupon).toEqual({ code: coupon.code, percentOff: 10 });
  });
});

describe('T4 one key, different requests', () => {
  it.each([
    ['another cart', async () => ({ cartId: await cartWith({ p_mouse: 1 }), body: visa(priceOf('p_mouse')) })],
    ['another total', async (cartId: string) => ({ cartId, body: visa(priceOf('p_mouse') + 1) })],
    ['another token', async (cartId: string) => ({ cartId, body: { expectedTotalPaise: priceOf('p_mouse'), paymentToken: 'pm_card_chargeDeclined' } })],
    ['a coupon', async (cartId: string) => ({ cartId, body: { ...visa(priceOf('p_mouse')), couponCode: 'SAVE10-ANY' } })],
  ])('the same key with %s gets 422 IDEMPOTENCY_KEY_REUSED and leaves the key row unchanged', async (_label, other) => {
    const cartId = await cartWith({ p_mouse: 1 });
    const key = newKey();
    await expectOrder(await postCheckout(app, cartId, key, visa(priceOf('p_mouse'))), 201);
    const before = await keyRow(db, key);

    const second = await other(cartId);
    await expectError(await postCheckout(app, second.cartId, key, second.body), 422, 'IDEMPOTENCY_KEY_REUSED');
    expect(await keyRow(db, key)).toEqual(before);
    expect(await orderCount(db)).toBe(1);
  });

  it('the same key on the uppercase form of the cart id replays instead of returning 422', async () => {
    const cartId = await cartWith({ p_mouse: 1 });
    const key = newKey();
    const paid = await expectOrder(await postCheckout(app, cartId, key, visa(priceOf('p_mouse'))), 201);

    const replay = await postCheckout(app, cartId.toUpperCase(), key, visa(priceOf('p_mouse')));
    expect(await expectOrder(replay, 201, { replayed: true })).toEqual(paid);
  });

  it('the same key with the lowercase form of the coupon code replays instead of returning 422', async () => {
    const coupon = await insertCoupon(db);
    const cartId = await cartWith({ p_mouse: 1 });
    const key = newKey();
    const body = { ...visa(withTenPercent(priceOf('p_mouse'))), couponCode: coupon.code };
    const paid = await expectOrder(await postCheckout(app, cartId, key, body), 201);

    const replay = await postCheckout(app, cartId, key, { ...body, couponCode: `  ${coupon.code.toLowerCase()} ` });
    expect(await expectOrder(replay, 201, { replayed: true })).toEqual(paid);
  });

  it('two carts racing on one key behind a barrier on their shared product give one 201 and one 422, never a 500', async () => {
    const cartIds = await Promise.all([cartWith({ p_lamp: 1 }), cartWith({ p_lamp: 1 })]);
    const key = newKey();

    const responses = await barrier({ table: 'products', id: 'p_lamp' }, 2, () =>
      cartIds.map((cartId) => postCheckout(app, cartId, key, visa(priceOf('p_lamp')))),
    );

    expect(responses.map((res) => res.status).sort()).toEqual([201, 422]);
    expect(await orderCount(db)).toBe(1);
  });
});

describe('T17 a lock timeout during reserve', () => {
  it('gets 503 LOCK_TIMEOUT, stores no key and writes nothing, and the same key then pays', async () => {
    const short = createTestApp({ LOCK_TIMEOUT_MS: '200' });
    const cartId = await cartWith({ p_lamp: 1 });
    const key = newKey();
    const lock = await holdLock({ table: 'products', id: 'p_lamp' });

    await withCleanup(
      async () => {
        await expectError(await postCheckout(short.app, cartId, key, visa(priceOf('p_lamp'))), 503, 'LOCK_TIMEOUT');
        expect(await keyRow(db, key)).toBeUndefined();
        expect(await orderCount(db)).toBe(0);
        expect(await stockOf(db, 'p_lamp')).toBe(3);
        expect((await getCart(cartId)).status).toBe('open');
        await lock.release();

        await expectOrder(await postCheckout(short.app, cartId, key, visa(priceOf('p_lamp'))), 201);
      },
      lock.release,
      () => short.pool.end(),
    );
  });
});
