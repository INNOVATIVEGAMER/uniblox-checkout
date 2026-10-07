import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { coupons } from '../src/db/schema';
import { requestHash } from '../src/modules/checkout/idempotency';
import type { CheckoutInput } from '../src/modules/checkout/input';
import { reservePhase } from '../src/modules/checkout/service';
import { FakeGateway } from '../src/modules/payments/fake-gateway';
import type { PaymentGateway } from '../src/modules/payments/gateway';
import { reconcile, resolvePendingOrder } from '../src/modules/payments/recovery';
import { createTestApp, sendJson } from './helpers/app';
import { barrier } from './helpers/barrier';
import { cartRequests } from './helpers/carts';
import { expectOrder, newKey, postCheckout, stockOf, throwingGateway, visa } from './helpers/checkout';
import { withCleanup } from './helpers/cleanup';
import { couponRow, insertCoupon, withTenPercent } from './helpers/coupons';
import { resetDb } from './helpers/db';
import { expectError } from './helpers/errors';
import { gated } from './helpers/gate';
import { priceOf } from './helpers/products';
import { backdate, postReconcile, resolutionRow } from './helpers/recovery';

const { app, appWith, db, pool, config } = createTestApp();
const { cartWith, getCart } = cartRequests(app);

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

const muteUnknownOutcomes = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

/** A lamp at 10% off, the coupon held by the order. */
async function lampWithCoupon() {
  const coupon = await insertCoupon(db);
  const cartId = await cartWith({ p_lamp: 1 });
  return { coupon, cartId, total: withTenPercent(priceOf('p_lamp')) };
}

async function pendingOrderOf(cartId: string): Promise<string> {
  return z.uuid().parse((await getCart(cartId)).orderId);
}

/** A crash after reserve: the real phase 1 with the key and hash an HTTP retry would use, and no charge. */
async function crashAfterReserve(input: CheckoutInput, key = newKey()) {
  const reserved = await reservePhase(db, input, key, requestHash(input));
  if (reserved.kind !== 'reserved') throw new Error(`reservePhase gave ${reserved.kind}`);
  return { key, order: reserved.order };
}

async function couponRedeemedAt(code: string) {
  const [row] = await db.select({ redeemedAt: sql<string | null>`${coupons.redeemedAt}::text` }).from(coupons).where(eq(coupons.code, code));
  return row?.redeemedAt;
}

async function expectReleased(cartId: string, couponCode: string) {
  expect(await stockOf(db, 'p_lamp')).toBe(3);
  expect(await couponRow(db, couponCode)).toEqual({ status: 'available', redeemedAt: null });
  expect(await getCart(cartId)).toMatchObject({ status: 'open', orderId: null });
}

describe('T10 two reconciles at once on one stale declined order', () => {
  it('resolve it once behind a cart barrier: stock back to the seed value, the coupon available, both list it failed', async () => {
    muteUnknownOutcomes();
    const fakeApp = appWith(new FakeGateway());
    const { coupon, cartId, total } = await lampWithCoupon();
    const body = { expectedTotalPaise: total, paymentToken: 'tok_timeout_declined', couponCode: coupon.code };
    const order = await expectOrder(await postCheckout(fakeApp, cartId, newKey(), body), 202);
    await backdate(db, order.id);

    const results = await barrier({ table: 'carts', id: cartId }, 2, () => [postReconcile(fakeApp), postReconcile(fakeApp)]);

    for (const result of results) expect(result).toEqual({ resolved: [{ orderId: order.id, status: 'failed' }], stillPending: 0 });
    expect(await resolutionRow(db, order.id)).toMatchObject({ status: 'failed', failureReason: 'card_declined' });
    await expectReleased(cartId, coupon.code);
  });
});

describe('T11 recovery against the original finalize', () => {
  it('reconcile pays the order while the charge is held, and the release changes no timestamp or reference', async () => {
    const gate = gated(new FakeGateway(), { at: 'after' });
    const gatedApp = appWith(gate.gateway);
    const { coupon, cartId, total } = await lampWithCoupon();
    const pending = postCheckout(gatedApp, cartId, newKey(), { ...visa(total), couponCode: coupon.code });

    await withCleanup(
      async () => {
        await gate.entered();
        const orderId = await pendingOrderOf(cartId);
        await backdate(db, orderId);

        expect(await postReconcile(gatedApp)).toEqual({ resolved: [{ orderId, status: 'paid' }], stillPending: 0 });
        const before = { order: await resolutionRow(db, orderId), redeemedAt: await couponRedeemedAt(coupon.code) };
        expect(before.order).toMatchObject({ status: 'paid', paymentRef: expect.stringMatching(/^ch_/) });

        gate.release();
        const paid = await expectOrder(await pending, 201);
        expect(paid.id).toBe(orderId);
        expect({ order: await resolutionRow(db, orderId), redeemedAt: await couponRedeemedAt(coupon.code) }).toEqual(before);
        expect(gate.calls).toBe(1);
      },
      async () => gate.release(),
      () => Promise.allSettled([pending]),
    );
  });
});

describe('T12 a slow charge overtaken by recovery', () => {
  it('reconcile cancels and releases, the late charge is declined, and the original request gets 402 abandoned', async () => {
    const fake = new FakeGateway();
    const gate = gated(fake, { at: 'before' });
    const gatedApp = appWith(gate.gateway);
    const { coupon, cartId, total } = await lampWithCoupon();
    const pending = postCheckout(gatedApp, cartId, newKey(), { ...visa(total), couponCode: coupon.code });

    await withCleanup(
      async () => {
        await gate.entered();
        const orderId = await pendingOrderOf(cartId);
        await backdate(db, orderId);

        expect(await postReconcile(gatedApp)).toEqual({ resolved: [{ orderId, status: 'failed' }], stillPending: 0 });
        expect(await resolutionRow(db, orderId)).toMatchObject({ status: 'failed', failureReason: 'abandoned' });
        await expectReleased(cartId, coupon.code);

        gate.release();
        const error = await expectError(await pending, 402, 'PAYMENT_FAILED');
        expect(error.details).toEqual({ orderId, reason: 'abandoned' });
        expect(fake.charges.get(orderId)).toEqual({ outcome: 'declined', reason: 'cancelled' });
        await expectReleased(cartId, coupon.code);
      },
      async () => gate.release(),
      () => Promise.allSettled([pending]),
    );
  });
});

describe('T14 an approved charge whose response timed out', () => {
  it('holds as 202 until the TTL, is left alone by an early reconcile, then becomes paid and replays 201', async () => {
    muteUnknownOutcomes();
    const fakeApp = appWith(new FakeGateway());
    const { coupon, cartId, total } = await lampWithCoupon();
    const key = newKey();
    const body = { expectedTotalPaise: total, paymentToken: 'tok_timeout_approved', couponCode: coupon.code };

    const order = await expectOrder(await postCheckout(fakeApp, cartId, key, body), 202);
    expect(await stockOf(db, 'p_lamp')).toBe(2);
    expect(await couponRow(db, coupon.code)).toEqual({ status: 'reserved', redeemedAt: null });
    expect(await expectOrder(await postCheckout(fakeApp, cartId, key, body), 202, { replayed: true })).toEqual(order);

    expect(await postReconcile(fakeApp)).toEqual({ resolved: [], stillPending: 1 });
    expect((await resolutionRow(db, order.id))?.status).toBe('pending_payment');

    await backdate(db, order.id);
    expect(await postReconcile(fakeApp)).toEqual({ resolved: [{ orderId: order.id, status: 'paid' }], stillPending: 0 });
    expect(await couponRow(db, coupon.code)).toEqual({ status: 'redeemed', redeemedAt: expect.any(Date) });
    expect(await getCart(cartId)).toMatchObject({ status: 'checked_out', orderId: order.id });
    expect(await stockOf(db, 'p_lamp')).toBe(2);

    const replay = await expectOrder(await postCheckout(fakeApp, cartId, key, body), 201, { replayed: true });
    expect(replay).toMatchObject({ id: order.id, status: 'paid', paymentRef: expect.stringMatching(/^ch_/) });
    expect(await postReconcile(fakeApp)).toEqual({ resolved: [], stillPending: 0 });
  });
});

describe('T16 a crash after reserve', () => {
  it('replays 202 before the TTL, then reconcile abandons it and releases everything, and the retry replays 402', async () => {
    const fakeApp = appWith(new FakeGateway());
    const { coupon, cartId, total } = await lampWithCoupon();
    const body = { ...visa(total), couponCode: coupon.code };
    const { key, order } = await crashAfterReserve({ cartId, ...body });

    expect((await expectOrder(await postCheckout(fakeApp, cartId, key, body), 202, { replayed: true })).id).toBe(order.id);

    await backdate(db, order.id);
    expect(await postReconcile(fakeApp)).toEqual({ resolved: [{ orderId: order.id, status: 'failed' }], stillPending: 0 });
    expect(await resolutionRow(db, order.id)).toMatchObject({ status: 'failed', failureReason: 'abandoned' });
    await expectReleased(cartId, coupon.code);

    const replay = await postCheckout(fakeApp, cartId, key, body);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect((await expectError(replay, 402, 'PAYMENT_FAILED')).details).toEqual({ orderId: order.id, reason: 'abandoned' });
  });
});

describe('T19 a crashed zero-total order', () => {
  it('is resolved as paid by reconcile, with no payment reference and no gateway call', async () => {
    expect((await sendJson(app, 'PATCH', '/admin/products/p_cable', { pricePaise: 0 })).status).toBe(200);
    const cartId = await cartWith({ p_cable: 2 });
    const { order } = await crashAfterReserve({ cartId, ...visa(0) });
    await backdate(db, order.id);

    expect(await postReconcile(appWith(throwingGateway))).toEqual({ resolved: [{ orderId: order.id, status: 'paid' }], stillPending: 0 });
    expect(await resolutionRow(db, order.id)).toMatchObject({ status: 'paid', paymentRef: null });
  });
});

describe('T31 recovery with stub gateways', () => {
  const fail = () => Promise.reject(new Error('connection reset'));
  const stub = (methods: Partial<PaymentGateway>): PaymentGateway => ({ charge: fail, retrieve: fail, cancel: fail, ...methods });
  const notFound: PaymentGateway['retrieve'] = () => Promise.resolve({ outcome: 'not_found' });

  async function staleLampOrder() {
    const { coupon, cartId, total } = await lampWithCoupon();
    const { order } = await crashAfterReserve({ cartId, ...visa(total), couponCode: coupon.code });
    await backdate(db, order.id);
    return { coupon, cartId, order };
  }

  it('a charge that lands between retrieve and cancel makes the order paid and redeems the coupon', async () => {
    const { coupon, cartId, order } = await staleLampOrder();
    const gateway = stub({ retrieve: notFound, cancel: () => Promise.resolve({ outcome: 'approved', paymentRef: 'ch_late' }) });

    expect(await resolvePendingOrder({ db, gateway }, order)).toBe('paid');
    expect(await resolutionRow(db, order.id)).toMatchObject({ status: 'paid', paymentRef: 'ch_late' });
    expect(await couponRow(db, coupon.code)).toEqual({ status: 'redeemed', redeemedAt: expect.any(Date) });
    expect(await getCart(cartId)).toMatchObject({ status: 'checked_out' });
  });

  it('a decline that lands between retrieve and cancel fails the order with the gateway reason', async () => {
    const { coupon, cartId, order } = await staleLampOrder();
    const gateway = stub({ retrieve: notFound, cancel: () => Promise.resolve({ outcome: 'declined', reason: 'card_declined' }) });

    expect(await resolvePendingOrder({ db, gateway }, order)).toBe('failed');
    expect(await resolutionRow(db, order.id)).toMatchObject({ status: 'failed', failureReason: 'card_declined' });
    await expectReleased(cartId, coupon.code);
  });

  it.each([
    ['retrieve() throws', stub({})],
    ['cancel() throws after not found', stub({ retrieve: notFound })],
  ])('%s: the call rejects and the order stays pending, holding its stock and coupon', async (_label, gateway) => {
    const { coupon, cartId, order } = await staleLampOrder();

    await expect(resolvePendingOrder({ db, gateway }, order)).rejects.toThrow('connection reset');
    expect(await resolutionRow(db, order.id)).toMatchObject({ status: 'pending_payment', resolvedAt: null });
    expect(await stockOf(db, 'p_lamp')).toBe(2);
    expect(await couponRow(db, coupon.code)).toEqual({ status: 'reserved', redeemedAt: null });
    expect(await getCart(cartId)).toMatchObject({ status: 'pending_payment', orderId: order.id });
  });

  it('one failing order does not abort reconcile: the next one resolves, and stillPending counts the failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = await staleLampOrder();
    const second = await staleLampOrder();
    const gateway = stub({
      retrieve: (orderId) => (orderId === first.order.id ? fail() : Promise.resolve({ outcome: 'approved', paymentRef: 'ch_ok' })),
    });

    expect(await reconcile({ db, gateway, config })).toEqual({ resolved: [{ orderId: second.order.id, status: 'paid' }], stillPending: 1 });
    expect(await resolutionRow(db, first.order.id)).toMatchObject({ status: 'pending_payment' });
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ orderId: first.order.id }));
  });
});
