import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { coupons } from '../src/db/schema';
import { SEED_PRODUCTS } from '../src/db/seed';
import { COUPON_GENERATION_LOCK, generateCoupon as generateCouponDirect } from '../src/modules/coupons/service';
import { FakeGateway } from '../src/modules/payments/fake-gateway';
import { createTestApp } from './helpers/app';
import { barrier, lineUp } from './helpers/barrier';
import { cartRequests, cartViewSchema } from './helpers/carts';
import { expectOrder, idleInTransaction, newKey, orderCount, postCheckout, throwingGateway, visa } from './helpers/checkout';
import { withCleanup } from './helpers/cleanup';
import {
  couponRow,
  couponSchema,
  generateCoupon,
  generatedSchema,
  insertCoupon,
  payOrders,
  withTenPercent,
} from './helpers/coupons';
import { resetDb, snapshotDb } from './helpers/db';
import { expectError } from './helpers/errors';
import { gated } from './helpers/gate';
import { priceOf } from './helpers/products';
import { firstFulfilled, within } from './helpers/within';

const N = 2;
const { app, appWith, db, pool, config } = createTestApp({ COUPON_EVERY_N_ORDERS: String(N) });
const { cartWith } = cartRequests(app);

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

async function expectGenerated(res: Response) {
  expect(res.status).toBe(201);
  return generatedSchema.parse(await res.json());
}

describe('T28 milestones over HTTP', () => {
  it('with n − 1 paid orders, plus a pending and a failed one, gets 409 NO_ELIGIBLE_MILESTONE', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await payOrders(app, N - 1);
    const pending = await postCheckout(appWith(throwingGateway), await cartWith({ p_mouse: 1 }), newKey(), visa(priceOf('p_mouse')));
    expect(pending.status).toBe(202);
    const failed = await postCheckout(app, await cartWith({ p_mouse: 1 }), newKey(), {
      expectedTotalPaise: priceOf('p_mouse'),
      paymentToken: 'pm_card_chargeDeclined',
    });
    expect(failed.status).toBe(402);

    const error = await expectError(await generateCoupon(app), 409, 'NO_ELIGIBLE_MILESTONE');
    expect(error.details).toEqual({ paidOrders: N - 1, nextMilestoneAt: N });
  });

  it('with n paid orders, generates milestone 1 with remainingEligible 0, then 409', async () => {
    await payOrders(app, N);

    const { coupon, remainingEligible } = await expectGenerated(await generateCoupon(app));
    expect(coupon).toMatchObject({ milestone: 1, percentOff: 10, status: 'available', redeemedAt: null });
    expect(coupon.code).toMatch(/^SAVE10-M1-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(remainingEligible).toBe(0);

    const error = await expectError(await generateCoupon(app), 409, 'NO_ELIGIBLE_MILESTONE');
    expect(error.details).toEqual({ paidOrders: N, nextMilestoneAt: 2 * N });
  });

  it('with 2n paid orders, generates the oldest milestone first, one per call', async () => {
    await payOrders(app, 2 * N);

    expect(await expectGenerated(await generateCoupon(app))).toMatchObject({ coupon: { milestone: 1 }, remainingEligible: 1 });
    expect(await expectGenerated(await generateCoupon(app))).toMatchObject({ coupon: { milestone: 2 }, remainingEligible: 0 });
    await expectError(await generateCoupon(app), 409, 'NO_ELIGIBLE_MILESTONE');
  });
});

describe('T9 parallel generations behind the advisory-lock barrier', () => {
  it('2n paid orders and 5 parallel calls give exactly 2 coupons and 3 × 409, with no 500s', async () => {
    await payOrders(app, 2 * N);

    const responses = await barrier({ advisoryLock: COUPON_GENERATION_LOCK }, 5, () =>
      Array.from({ length: 5 }, () => generateCoupon(app)),
    );

    expect(responses.map((res) => res.status).sort()).toEqual([201, 201, 409, 409, 409]);
    const created = await Promise.all(responses.filter((res) => res.status === 201).map(expectGenerated));
    expect(created.map(({ coupon }) => coupon.milestone).sort()).toEqual([1, 2]);
    for (const res of responses.filter((r) => r.status === 409)) await expectError(res, 409, 'NO_ELIGIBLE_MILESTONE');
  });
});

describe('code collisions', () => {
  it('retries a colliding code with a fresh one', async () => {
    await payOrders(app, 2 * N);
    const taken = (await generateCouponDirect(db, config, () => 'SAVE10-TAKEN')).coupon.code;
    const codes = ['SAVE10-TAKEN', 'SAVE10-FRESH'];

    const { coupon } = await generateCouponDirect(db, config, () => codes.shift() ?? 'unexpected');

    expect(taken).toBe('SAVE10-TAKEN');
    expect(coupon).toMatchObject({ code: 'SAVE10-FRESH', milestone: 2 });
  });

  it('gives up after 3 collisions and creates nothing', async () => {
    await payOrders(app, 2 * N);
    await generateCouponDirect(db, config, () => 'SAVE10-TAKEN');
    const newCode = vi.fn(() => 'SAVE10-TAKEN');

    await expect(generateCouponDirect(db, config, newCode)).rejects.toThrow(/collided 3 times/);
    expect(newCode).toHaveBeenCalledTimes(3);
    expect(await listCoupons()).toHaveLength(1);
  });
});

async function listCoupons() {
  const res = await app.request('/admin/coupons');
  expect(res.status).toBe(200);
  return z.array(couponSchema).parse(await res.json());
}

describe('GET /admin/coupons', () => {
  it('is empty before any generation', async () => {
    expect(await listCoupons()).toEqual([]);
  });

  it('lists coupons in milestone order', async () => {
    await payOrders(app, 2 * N);
    const first = await expectGenerated(await generateCoupon(app));
    const second = await expectGenerated(await generateCoupon(app));

    expect(await listCoupons()).toEqual([first.coupon, second.coupon]);
  });
});

describe('T6 five carts with no product in common race for one coupon, behind a coupon barrier, gated', () => {
  it('gives 4 × 409 COUPON_RESERVED while the coupon is reserved, then one 201, and the coupon is redeemed for good', async () => {
    const coupon = await insertCoupon(db);
    const gate = gated(new FakeGateway(), { at: 'before' });
    const gatedApp = appWith(gate.gateway);
    const carts = await Promise.all(
      SEED_PRODUCTS.map(async ({ id, pricePaise }) => ({ cartId: await cartWith({ [id]: 1 }), total: withTenPercent(pricePaise) })),
    );
    const send = (cart: (typeof carts)[number], key: string) =>
      postCheckout(gatedApp, cart.cartId, key, { ...visa(cart.total), couponCode: coupon.code });
    let requests: Promise<{ cart: (typeof carts)[number]; key: string; res: Response }>[] = [];

    await withCleanup(
      async () => {
        requests = await lineUp(
          { table: 'coupons', id: coupon.id },
          5,
          () =>
            carts.map(async (cart) => {
              const key = newKey();
              return { cart, key, res: await send(cart, key) };
            }),
          async () => gate.release(),
        );
        await gate.entered();
        const losers = await within(firstFulfilled(requests, 4), 'the 4 losers did not settle');
        for (const { res } of losers) {
          expect(res.headers.get('Idempotent-Replayed')).toBeNull();
          await expectError(res, 409, 'COUPON_RESERVED');
        }
        expect(await couponRow(db, coupon.code)).toEqual({ status: 'reserved', redeemedAt: null });
        expect(await idleInTransaction(db)).toBe(0);

        gate.release();
        const winner = (await Promise.all(requests)).find((request) => !losers.includes(request));
        if (!winner) throw new Error('no winner');
        const paid = await expectOrder(winner.res, 201);
        expect(paid).toMatchObject({ coupon: { code: coupon.code, percentOff: 10 }, totalPaise: winner.cart.total });
        expect(await couponRow(db, coupon.code)).toEqual({ status: 'redeemed', redeemedAt: expect.any(Date) });

        const [loser] = losers;
        if (!loser) throw new Error('no loser');
        const retried = await send(loser.cart, loser.key);
        expect(retried.headers.get('Idempotent-Replayed')).toBeNull();
        await expectError(retried, 409, 'COUPON_ALREADY_REDEEMED');
        const replayed = await send(loser.cart, loser.key);
        expect(replayed.headers.get('Idempotent-Replayed')).toBe('true');
        await expectError(replayed, 409, 'COUPON_ALREADY_REDEEMED');

        const freshCart = await cartWith({ p_keyboard: 1 });
        const fresh = await postCheckout(app, freshCart, newKey(), { ...visa(withTenPercent(priceOf('p_keyboard'))), couponCode: coupon.code });
        await expectError(fresh, 409, 'COUPON_ALREADY_REDEEMED');

        expect(await orderCount(db)).toBe(1);
        expect(gate.calls).toBe(1);
      },
      async () => gate.release(),
      () => Promise.allSettled(requests),
    );
  });
});

describe('T19 a 100% coupon', () => {
  it('pays a zero total without calling the gateway, with no payment reference, and redeems the coupon', async () => {
    const full = createTestApp({ COUPON_EVERY_N_ORDERS: String(N), COUPON_PERCENT_OFF: '100' });
    const gate = gated(new FakeGateway(), { at: 'before' });

    await withCleanup(
      async () => {
        await payOrders(full.app, N);
        const { coupon } = await expectGenerated(await generateCoupon(full.app));
        expect(coupon.percentOff).toBe(100);
        const cartId = await cartWith({ p_cable: 3 });

        const res = await postCheckout(full.appWith(gate.gateway), cartId, newKey(), { ...visa(0), couponCode: coupon.code });

        const order = await expectOrder(res, 201);
        expect(order).toMatchObject({
          status: 'paid',
          subtotalPaise: 3 * priceOf('p_cable'),
          discountPaise: 3 * priceOf('p_cable'),
          totalPaise: 0,
          paymentRef: null,
          coupon: { code: coupon.code, percentOff: 100 },
        });
        expect(gate.calls).toBe(0);
        expect(await couponRow(db, coupon.code)).toEqual({ status: 'redeemed', redeemedAt: expect.any(Date) });
      },
      async () => gate.release(),
      () => full.pool.end(),
    );
  });
});

const preview = async (cartId: string, query: string) => app.request(`/carts/${cartId}?${query}`);

describe('T24 the coupon preview', () => {
  it('shows the discount and total for an available coupon, normalises the code, and writes nothing', async () => {
    const coupon = await insertCoupon(db);
    const cartId = await cartWith({ p_cable: 1 });
    const before = await snapshotDb(db);

    const res = await preview(cartId, `couponCode=${encodeURIComponent(` ${coupon.code.toLowerCase()} `)}`);

    expect(res.status).toBe(200);
    expect(cartViewSchema.parse(await res.json())).toMatchObject({
      status: 'open',
      subtotalPaise: priceOf('p_cable'),
      coupon: { code: coupon.code, percentOff: 10 },
      discountPaise: 3_499,
      totalPaise: 31_500,
    });
    expect(await snapshotDb(db)).toEqual(before);
  });

  it('shows coupon: null and no discount without a code', async () => {
    const cartId = await cartWith({ p_cable: 1 });
    expect(await getCartView(cartId)).toMatchObject({ coupon: null, discountPaise: 0, totalPaise: priceOf('p_cable') });
  });

  it('gets 409 COUPON_RESERVED for a coupon held by a pending payment, on another cart and on the holding cart', async () => {
    const coupon = await insertCoupon(db);
    const gate = gated(new FakeGateway(), { at: 'before' });
    const holder = await cartWith({ p_mouse: 1 });
    const pending = postCheckout(appWith(gate.gateway), holder, newKey(), { ...visa(withTenPercent(priceOf('p_mouse'))), couponCode: coupon.code });

    await withCleanup(
      async () => {
        await gate.entered();
        await expectError(await preview(await cartWith({ p_cable: 1 }), `couponCode=${coupon.code}`), 409, 'COUPON_RESERVED');
        await expectError(await preview(holder, `couponCode=${coupon.code}`), 409, 'COUPON_RESERVED');
      },
      async () => gate.release(),
      () => Promise.allSettled([pending]),
    );
  });

  it('gets 409 COUPON_ALREADY_REDEEMED for a redeemed coupon', async () => {
    const coupon = await insertCoupon(db);
    await db.update(coupons).set({ status: 'redeemed', redeemedAt: new Date() }).where(eq(coupons.id, coupon.id));
    await expectError(await preview(await cartWith({ p_cable: 1 }), `couponCode=${coupon.code}`), 409, 'COUPON_ALREADY_REDEEMED');
  });

  it('gets 422 COUPON_INVALID for an unknown code', async () => {
    await expectError(await preview(await cartWith({ p_cable: 1 }), 'couponCode=SAVE10-M9-NOPE'), 422, 'COUPON_INVALID');
  });

  it('checks the cart before the coupon: an unknown cart gets 404', async () => {
    await expectError(await preview('0b8f2d4e-6a1c-4e3b-8d5f-7a9c1e3b5d7f', 'couponCode=SAVE10-M9-NOPE'), 404, 'CART_NOT_FOUND');
  });

  it.each([
    ['an empty code', 'couponCode='],
    ['a whitespace-only code', 'couponCode=%20%20'],
    ['a code over 64 characters', `couponCode=${'A'.repeat(65)}`],
    ['a repeated parameter', 'couponCode=A&couponCode=B'],
  ])('gets 400 VALIDATION_ERROR for %s', async (_label, query) => {
    const error = await expectError(await preview(await cartWith({ p_cable: 1 }), query), 400, 'VALIDATION_ERROR');
    expect(error.details).toContainEqual(expect.objectContaining({ path: 'query.couponCode' }));
  });
});

async function getCartView(cartId: string) {
  const res = await app.request(`/carts/${cartId}`);
  expect(res.status).toBe(200);
  return cartViewSchema.parse(await res.json());
}
