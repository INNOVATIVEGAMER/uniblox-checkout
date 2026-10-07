import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FakeGateway } from '../src/modules/payments/fake-gateway';
import { createTestApp, sendJson } from './helpers/app';
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
import { resetDb } from './helpers/db';
import { expectError } from './helpers/errors';
import { gated } from './helpers/gate';

const { app, appWith, db, pool } = createTestApp();
const { cartWith, getCart } = cartRequests(app);

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

const LAMP_PAISE = 249_900;

const declined = (expectedTotalPaise: number) => ({ expectedTotalPaise, paymentToken: 'pm_card_chargeDeclined' });

describe('a paid checkout', () => {
  it('returns 201 with the order, decrements stock and checks the cart out', async () => {
    const cartId = await cartWith({ p_lamp: 2, p_cable: 1 });

    const order = await expectOrder(await postCheckout(app, cartId, newKey(), visa(2 * LAMP_PAISE + 34_999)), 201);

    expect(order).toMatchObject({
      cartId,
      status: 'paid',
      lines: [
        { productId: 'p_cable', productName: 'USB-C Cable', unitPricePaise: 34_999, quantity: 1, lineTotalPaise: 34_999 },
        { productId: 'p_lamp', productName: 'Limited Edition Desk Lamp', unitPricePaise: LAMP_PAISE, quantity: 2, lineTotalPaise: 2 * LAMP_PAISE },
      ],
      subtotalPaise: 2 * LAMP_PAISE + 34_999,
      discountPaise: 0,
      totalPaise: 2 * LAMP_PAISE + 34_999,
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
    const pending = postCheckout(gatedApp, cartId, key, declined(LAMP_PAISE));

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

    const replay = await postCheckout(app, cartId, key, declined(LAMP_PAISE));
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect((await expectError(replay, 402, 'PAYMENT_FAILED')).details).toEqual(error.details);

    await expectError(await postCheckout(app, cartId, key, visa(LAMP_PAISE)), 422, 'IDEMPOTENCY_KEY_REUSED');

    const paid = await expectOrder(await postCheckout(app, cartId, newKey(), visa(LAMP_PAISE)), 201);
    expect(paid.id).not.toBe(orderId);
    expect(await stockOf(db, 'p_lamp')).toBe(2);
    expect(await getCart(cartId)).toMatchObject({ status: 'checked_out', orderId: paid.id });
  });
});

describe('an unknown payment outcome', () => {
  it('returns 202 with Retry-After, holds the reservation, and the same key replays 202', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throwingApp = appWith(throwingGateway);
    const cartId = await cartWith({ p_lamp: 1 });
    const key = newKey();

    const order = await expectOrder(await postCheckout(throwingApp, cartId, key, visa(LAMP_PAISE)), 202);
    expect(order).toMatchObject({ status: 'pending_payment', paymentRef: null, failureReason: null, resolvedAt: null });
    expect(warn).toHaveBeenCalledOnce();
    expect(await stockOf(db, 'p_lamp')).toBe(2);
    expect(await getCart(cartId)).toMatchObject({ status: 'pending_payment', orderId: order.id });

    const replay = await expectOrder(await postCheckout(throwingApp, cartId, key, visa(LAMP_PAISE)), 202, { replayed: true });
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
    const placed = await expectOrder(await postCheckout(app, cartId, newKey(), visa(LAMP_PAISE)), 201);

    const before = await app.request(`/orders/${placed.id}`);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual(placed);

    const patch = await sendJson(app, 'PATCH', '/admin/products/p_lamp', { name: 'Renamed Lamp', pricePaise: 1 });
    expect(patch.status).toBe(200);

    const after = await app.request(`/orders/${placed.id}`);
    expect(await after.json()).toEqual(placed);
  });
});
