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
import { expectOrder, newKey, orderStatus, postCheckout, stockOf, throwingGateway, visa } from './helpers/checkout';
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
  it('resolve it once behind a cart barrier: stock back to the seed value, the coupon available, one lists it failed', async () => {
    muteUnknownOutcomes();
    const fakeApp = appWith(new FakeGateway());
    const { coupon, cartId, total } = await lampWithCoupon();
    const body = { expectedTotalPaise: total, paymentToken: 'tok_timeout_declined', couponCode: coupon.code };
    const order = await expectOrder(await postCheckout(fakeApp, cartId, newKey(), body), 202);
    await backdate(db, order.id);

    const results = await barrier({ table: 'carts', id: cartId }, 2, () => [postReconcile(fakeApp), postReconcile(fakeApp)]);

    expect(results.flatMap((result) => result.resolved)).toEqual([{ orderId: order.id, status: 'failed' }]);
    for (const result of results) expect(result.stillPending).toBe(0);
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
    expect(await orderStatus(db, order.id)).toBe('pending_payment');

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

  async function crashedLampOrder() {
    const { coupon, cartId, total } = await lampWithCoupon();
    const { order } = await crashAfterReserve({ cartId, ...visa(total), couponCode: coupon.code });
    return { coupon, cartId, order };
  }

  async function staleLampOrder() {
    const crashed = await crashedLampOrder();
    await backdate(db, crashed.order.id);
    return crashed;
  }

  it('a charge that lands between retrieve and cancel makes the order paid and redeems the coupon', async () => {
    const { coupon, cartId, order } = await staleLampOrder();
    const gateway = stub({ retrieve: notFound, cancel: () => Promise.resolve({ outcome: 'approved', paymentRef: 'ch_late' }) });

    expect(await resolvePendingOrder({ db, gateway, config }, order)).toBe('paid');
    expect(await resolutionRow(db, order.id)).toMatchObject({ status: 'paid', paymentRef: 'ch_late' });
    expect(await couponRow(db, coupon.code)).toEqual({ status: 'redeemed', redeemedAt: expect.any(Date) });
    expect(await getCart(cartId)).toMatchObject({ status: 'checked_out' });
  });

  it('a decline that lands between retrieve and cancel fails the order with the gateway reason', async () => {
    const { coupon, cartId, order } = await staleLampOrder();
    const gateway = stub({ retrieve: notFound, cancel: () => Promise.resolve({ outcome: 'declined', reason: 'card_declined' }) });

    expect(await resolvePendingOrder({ db, gateway, config }, order)).toBe('failed');
    expect(await resolutionRow(db, order.id)).toMatchObject({ status: 'failed', failureReason: 'card_declined' });
    await expectReleased(cartId, coupon.code);
  });

  it.each([
    ['retrieve() throws', stub({})],
    ['cancel() throws after not found', stub({ retrieve: notFound })],
  ])('%s: the call rejects and the order stays pending, holding its stock and coupon', async (_label, gateway) => {
    const { coupon, cartId, order } = await staleLampOrder();

    await expect(resolvePendingOrder({ db, gateway, config }, order)).rejects.toThrow('connection reset');
    expect(await resolutionRow(db, order.id)).toMatchObject({ status: 'pending_payment', resolvedAt: null });
    expect(await stockOf(db, 'p_lamp')).toBe(2);
    expect(await couponRow(db, coupon.code)).toEqual({ status: 'reserved', redeemedAt: null });
    expect(await getCart(cartId)).toMatchObject({ status: 'pending_payment', orderId: order.id });
  });

  const hung = (_orderId: string, signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));

  it.each([
    ['retrieve() hangs', stub({ retrieve: hung })],
    ['cancel() hangs after not found', stub({ retrieve: notFound, cancel: hung })],
  ])('%s: the call times out after GATEWAY_TIMEOUT_MS and the order stays pending', async (_label, gateway) => {
    const { order } = await staleLampOrder();

    const fast = { ...config, GATEWAY_TIMEOUT_MS: 50 };
    await expect(resolvePendingOrder({ db, gateway, config: fast }, order)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(await resolutionRow(db, order.id)).toMatchObject({ status: 'pending_payment', resolvedAt: null });
  });

  it('one failing order does not abort reconcile: the next one resolves, and stillPending counts the failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Both carts are built before either order goes stale, or the second cart's PUT would recover the first.
    const first = await crashedLampOrder();
    const second = await crashedLampOrder();
    await backdate(db, first.order.id);
    await backdate(db, second.order.id);
    const gateway = stub({
      retrieve: (orderId) => (orderId === first.order.id ? fail() : Promise.resolve({ outcome: 'approved', paymentRef: 'ch_ok' })),
    });

    expect(await reconcile({ db, gateway, config })).toEqual({ resolved: [{ orderId: second.order.id, status: 'paid' }], stillPending: 1 });
    expect(await resolutionRow(db, first.order.id)).toMatchObject({ status: 'pending_payment' });
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ orderId: first.order.id }));
  });
});

describe('T15 recovery triggers, on the 200 ms app', () => {
  const short = createTestApp({ LOCK_TIMEOUT_MS: '200' });
  const shortApp = short.appWith(new FakeGateway());
  const requests = cartRequests(shortApp);
  afterAll(() => short.pool.end());

  type Fixture = { cartA: string; cartB: string; couponCode: string };
  type Trigger = {
    label: string;
    cartB: Record<string, number>;
    send: (f: Fixture) => Promise<Response>;
    resolvedStatus: number;
    blocked: [number, 'CART_PAYMENT_PENDING' | 'COUPON_RESERVED' | 'INSUFFICIENT_STOCK'];
  };

  // Each row matches order A through one clause only, except checkout on cart A, whose lines are the order's lines.
  const triggers: Trigger[] = [
    {
      label: 'checkout on the cart',
      cartB: {},
      send: ({ cartA }) => postCheckout(shortApp, cartA, newKey(), visa(3 * priceOf('p_lamp'))),
      resolvedStatus: 201,
      blocked: [409, 'CART_PAYMENT_PENDING'],
    },
    {
      label: 'checkout by another cart using the held coupon',
      cartB: { p_mouse: 1 },
      send: ({ cartB, couponCode }) => postCheckout(shortApp, cartB, newKey(), { ...visa(withTenPercent(priceOf('p_mouse'))), couponCode }),
      resolvedStatus: 201,
      blocked: [409, 'COUPON_RESERVED'],
    },
    {
      label: 'checkout by another cart wanting the held lamps',
      cartB: { p_lamp: 1 },
      send: ({ cartB }) => postCheckout(shortApp, cartB, newKey(), visa(priceOf('p_lamp'))),
      resolvedStatus: 201,
      blocked: [409, 'INSUFFICIENT_STOCK'],
    },
    {
      label: 'a PUT of the held product on another cart',
      cartB: {},
      send: ({ cartB }) => requests.putItem(cartB, 'p_lamp', 1),
      resolvedStatus: 201,
      blocked: [409, 'INSUFFICIENT_STOCK'],
    },
    {
      label: 'a PUT of another product on the cart',
      cartB: {},
      send: ({ cartA }) => requests.putItem(cartA, 'p_mouse', 1),
      resolvedStatus: 201,
      blocked: [409, 'CART_PAYMENT_PENDING'],
    },
    {
      label: 'a DELETE on the cart',
      cartB: {},
      send: ({ cartA }) => requests.deleteItem(cartA, 'p_lamp'),
      resolvedStatus: 200,
      blocked: [409, 'CART_PAYMENT_PENDING'],
    },
  ];

  /** Cart A holds every lamp and the coupon in a tok_timeout_declined order. Cart B is built first, while lamps are in stock. */
  async function holdEverything(trigger: Trigger) {
    muteUnknownOutcomes();
    const coupon = await insertCoupon(db);
    const cartB = await requests.cartWith(trigger.cartB);
    const cartA = await requests.cartWith({ p_lamp: 3 });
    const body = { expectedTotalPaise: withTenPercent(3 * priceOf('p_lamp')), paymentToken: 'tok_timeout_declined', couponCode: coupon.code };
    const order = await expectOrder(await postCheckout(shortApp, cartA, newKey(), body), 202);
    return { fixture: { cartA, cartB, couponCode: coupon.code }, orderId: order.id };
  }

  it.each(triggers)('$label resolves a stale order first, then proceeds', async (trigger) => {
    const { fixture, orderId } = await holdEverything(trigger);
    await backdate(db, orderId);
    const error = vi.spyOn(console, 'error');

    expect((await shortApp.request(`/carts/${fixture.cartA}`)).status).toBe(200);
    expect((await shortApp.request(`/orders/${orderId}`)).status).toBe(200);
    expect(await orderStatus(db, orderId)).toBe('pending_payment');

    const res = await trigger.send(fixture);
    expect(res.status).toBe(trigger.resolvedStatus);
    expect(await resolutionRow(db, orderId)).toMatchObject({ status: 'failed', failureReason: 'card_declined' });
    expect(error).not.toHaveBeenCalled();
  });

  it.each(triggers)('$label is blocked by a fresh pending order', async (trigger) => {
    const { fixture, orderId } = await holdEverything(trigger);
    const [status, code] = trigger.blocked;

    await expectError(await trigger.send(fixture), status, code);
    expect(await orderStatus(db, orderId)).toBe('pending_payment');
  });

  it('a gateway failure during recovery is logged, and the request carries on to its own answer', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cartB = await requests.newCart();
    const { order } = await crashAfterReserve({ cartId: await requests.cartWith({ p_lamp: 3 }), ...visa(3 * priceOf('p_lamp')) });
    await backdate(db, order.id);

    const res = await cartRequests(short.appWith(throwingGateway)).putItem(cartB, 'p_lamp', 1);

    await expectError(res, 409, 'INSUFFICIENT_STOCK');
    expect(await orderStatus(db, order.id)).toBe('pending_payment');
    expect(error).toHaveBeenCalledOnce();
  });
});
