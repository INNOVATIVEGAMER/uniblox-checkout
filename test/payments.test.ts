import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FakeGateway } from '../src/modules/payments/fake-gateway';
import { createTestApp, sendJson } from './helpers/app';
import { type HeldLock, holdLock } from './helpers/barrier';
import { cartRequests } from './helpers/carts';
import {
  expectOrder,
  newKey,
  orderStatus,
  postCheckout,
  stockOf,
  throwingGateway,
  visa,
} from './helpers/checkout';
import { withCleanup } from './helpers/cleanup';
import { couponRow, insertCoupon, withTenPercent } from './helpers/coupons';
import { resetDb } from './helpers/db';
import { expectError } from './helpers/errors';
import { gated } from './helpers/gate';
import { priceOf } from './helpers/products';

const { app, appWith, db, pool } = createTestApp();
const { cartWith, getCart } = cartRequests(app);

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

const declined = (expectedTotalPaise: number) => ({ expectedTotalPaise, paymentToken: 'pm_card_chargeDeclined' });

describe('a paid checkout', () => {
  it('returns 201 with the order, decrements stock and checks the cart out', async () => {
    const cartId = await cartWith({ p_lamp: 2, p_cable: 1 });

    const order = await expectOrder(await postCheckout(app, cartId, newKey(), visa(2 * priceOf('p_lamp') + priceOf('p_cable'))), 201);

    expect(order).toMatchObject({
      cartId,
      status: 'paid',
      lines: [
        { productId: 'p_cable', productName: 'USB-C Cable', unitPricePaise: priceOf('p_cable'), quantity: 1, lineTotalPaise: priceOf('p_cable') },
        { productId: 'p_lamp', productName: 'Limited Edition Desk Lamp', unitPricePaise: priceOf('p_lamp'), quantity: 2, lineTotalPaise: 2 * priceOf('p_lamp') },
      ],
      subtotalPaise: 2 * priceOf('p_lamp') + priceOf('p_cable'),
      discountPaise: 0,
      totalPaise: 2 * priceOf('p_lamp') + priceOf('p_cable'),
      paymentRef: expect.stringMatching(/^ch_/),
      failureReason: null,
      resolvedAt: expect.any(String),
    });
    expect(await stockOf(db, 'p_lamp')).toBe(1);
    expect(await getCart(cartId)).toMatchObject({ status: 'checked_out', orderId: order.id });
  });
});

describe('T13 a declined payment', () => {
  it('gets 402, releases stock, reopens the cart, replays 402, rejects a new token on the same key, and a new key pays', async () => {
    const gate = gated(new FakeGateway(), { at: 'before' });
    const gatedApp = appWith(gate.gateway);
    const cartId = await cartWith({ p_lamp: 1 });
    const key = newKey();
    const pending = postCheckout(gatedApp, cartId, key, declined(priceOf('p_lamp')));

    const { res, orderId } = await withCleanup(
      async () => {
        await gate.entered();
        expect(await stockOf(db, 'p_lamp')).toBe(2);
        const view = await getCart(cartId);
        expect(view.status).toBe('pending_payment');
        gate.release();
        return { res: await pending, orderId: z.uuid().parse(view.orderId) };
      },
      async () => gate.release(),
      () => Promise.allSettled([pending]),
    );

    const error = await expectError(res, 402, 'PAYMENT_FAILED');
    expect(error.details).toEqual({ orderId, reason: 'card_declined' });
    expect(res.headers.get('Idempotent-Replayed')).toBeNull();
    expect(await orderStatus(db, orderId)).toBe('failed');
    expect(await stockOf(db, 'p_lamp')).toBe(3);
    expect(await getCart(cartId)).toMatchObject({ status: 'open', orderId: null });

    const replay = await postCheckout(app, cartId, key, declined(priceOf('p_lamp')));
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect((await expectError(replay, 402, 'PAYMENT_FAILED')).details).toEqual(error.details);

    await expectError(await postCheckout(app, cartId, key, visa(priceOf('p_lamp'))), 422, 'IDEMPOTENCY_KEY_REUSED');

    const paid = await expectOrder(await postCheckout(app, cartId, newKey(), visa(priceOf('p_lamp'))), 201);
    expect(paid.id).not.toBe(orderId);
    expect(await stockOf(db, 'p_lamp')).toBe(2);
    expect(await getCart(cartId)).toMatchObject({ status: 'checked_out', orderId: paid.id });
  });
});

describe('T13 a declined payment with a coupon', () => {
  it('holds the coupon while pending, releases it on the decline, and a new key redeems it', async () => {
    const coupon = await insertCoupon(db);
    const gate = gated(new FakeGateway(), { at: 'before' });
    const cartId = await cartWith({ p_lamp: 1 });
    const total = withTenPercent(priceOf('p_lamp'));
    const key = newKey();
    const pending = postCheckout(appWith(gate.gateway), cartId, key, { ...declined(total), couponCode: coupon.code });

    const res = await withCleanup(
      async () => {
        await gate.entered();
        expect(await couponRow(db, coupon.code)).toEqual({ status: 'reserved', redeemedAt: null });
        gate.release();
        return pending;
      },
      async () => gate.release(),
      () => Promise.allSettled([pending]),
    );

    await expectError(res, 402, 'PAYMENT_FAILED');
    expect(await couponRow(db, coupon.code)).toEqual({ status: 'available', redeemedAt: null });
    expect(await stockOf(db, 'p_lamp')).toBe(3);

    await expectError(await postCheckout(app, cartId, key, declined(total)), 422, 'IDEMPOTENCY_KEY_REUSED');

    const paid = await expectOrder(await postCheckout(app, cartId, newKey(), { ...visa(total), couponCode: coupon.code }), 201);
    expect(paid).toMatchObject({ discountPaise: priceOf('p_lamp') - total, totalPaise: total, coupon: { code: coupon.code, percentOff: 10 } });
    expect(await couponRow(db, coupon.code)).toEqual({ status: 'redeemed', redeemedAt: expect.any(Date) });
  });
});

describe('an unknown payment outcome', () => {
  it('returns 202 with Retry-After, holds the reservation, and the same key replays 202', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throwingApp = appWith(throwingGateway);
    const cartId = await cartWith({ p_lamp: 1 });
    const key = newKey();

    const order = await expectOrder(await postCheckout(throwingApp, cartId, key, visa(priceOf('p_lamp'))), 202);
    expect(order).toMatchObject({ status: 'pending_payment', paymentRef: null, failureReason: null, resolvedAt: null });
    expect(warn).toHaveBeenCalledOnce();
    expect(await stockOf(db, 'p_lamp')).toBe(2);
    expect(await getCart(cartId)).toMatchObject({ status: 'pending_payment', orderId: order.id });

    const replay = await expectOrder(await postCheckout(throwingApp, cartId, key, visa(priceOf('p_lamp'))), 202, { replayed: true });
    expect(replay).toEqual(order);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('a zero total', () => {
  it('is paid without calling the gateway, with no payment reference', async () => {
    expect((await sendJson(app, 'PATCH', '/admin/products/p_cable', { pricePaise: 0 })).status).toBe(200);
    const cartId = await cartWith({ p_cable: 2 });

    const order = await expectOrder(await postCheckout(appWith(throwingGateway), cartId, newKey(), visa(0)), 201);

    expect(order).toMatchObject({ status: 'paid', totalPaise: 0, paymentRef: null });
  });
});

describe('T23 order snapshots', () => {
  it('GET /orders/:id is unchanged after the product name and price are edited', async () => {
    const cartId = await cartWith({ p_lamp: 1 });
    const placed = await expectOrder(await postCheckout(app, cartId, newKey(), visa(priceOf('p_lamp'))), 201);

    const before = await app.request(`/orders/${placed.id}`);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual(placed);

    const patch = await sendJson(app, 'PATCH', '/admin/products/p_lamp', { name: 'Renamed Lamp', pricePaise: 1 });
    expect(patch.status).toBe(200);

    const after = await app.request(`/orders/${placed.id}`);
    expect(await after.json()).toEqual(placed);
  });
});

describe('T18 PATCH stock during a reservation', () => {
  it('a decline adds the reserved unit back on top of the new stock', async () => {
    const gate = gated(new FakeGateway(), { at: 'before' });
    const cartId = await cartWith({ p_lamp: 1 });
    const pending = postCheckout(appWith(gate.gateway), cartId, newKey(), declined(priceOf('p_lamp')));

    await withCleanup(
      async () => {
        await gate.entered();
        expect((await sendJson(app, 'PATCH', '/admin/products/p_lamp', { stock: 10 })).status).toBe(200);
        gate.release();
        await expectError(await pending, 402, 'PAYMENT_FAILED');
        expect(await stockOf(db, 'p_lamp')).toBe(11);
      },
      async () => gate.release(),
      () => Promise.allSettled([pending]),
    );
  });
});

describe('a charge slower than GATEWAY_TIMEOUT_MS', () => {
  it('is aborted, and the checkout returns 202 with the order pending', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fast = createTestApp({ GATEWAY_TIMEOUT_MS: '100' });
    const gate = gated(new FakeGateway(), { at: 'before' });
    const cartId = await cartWith({ p_lamp: 1 });

    await withCleanup(
      async () => {
        const order = await expectOrder(await postCheckout(fast.appWith(gate.gateway), cartId, newKey(), visa(priceOf('p_lamp'))), 202);
        expect(order.status).toBe('pending_payment');
        expect(gate.calls).toBe(1);
        expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ err: expect.objectContaining({ name: 'TimeoutError' }) }));
        expect(await stockOf(db, 'p_lamp')).toBe(2);
      },
      async () => gate.release(),
      () => fast.pool.end(),
    );
  });
});

describe('finalize failing after the charge', () => {
  it('returns 503, leaves the order pending with its reservation, and the same key replays 202', async () => {
    const short = createTestApp({ LOCK_TIMEOUT_MS: '200' });
    const gate = gated(new FakeGateway(), { at: 'after' });
    const shortApp = short.appWith(gate.gateway);
    const cartId = await cartWith({ p_lamp: 1 });
    const key = newKey();
    const pending = postCheckout(shortApp, cartId, key, visa(priceOf('p_lamp')));
    let lock: HeldLock | undefined;

    await withCleanup(
      async () => {
        await gate.entered();
        lock = await holdLock({ table: 'carts', id: cartId });
        gate.release();
        await expectError(await pending, 503, 'LOCK_TIMEOUT');
        await lock.release();

        const order = await expectOrder(await postCheckout(shortApp, cartId, key, visa(priceOf('p_lamp'))), 202, { replayed: true });
        expect(order.status).toBe('pending_payment');
        expect(await stockOf(db, 'p_lamp')).toBe(2);
        expect(gate.calls).toBe(1);
      },
      async () => gate.release(),
      async () => lock?.release(),
      () => Promise.allSettled([pending]),
    );
    await short.pool.end();
  });
});
