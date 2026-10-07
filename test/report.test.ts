import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SEED_PRODUCTS } from '../src/db/seed';
import { discount } from '../src/domain/money';
import { createTestApp, sendJson } from './helpers/app';
import { cartRequests } from './helpers/carts';
import { type OrderView, expectOrder, newKey, orderStatus, orderViewSchema, postCheckout, throwingGateway, visa } from './helpers/checkout';
import { generateCoupon, generatedSchema, payOrders, withTenPercent } from './helpers/coupons';
import { resetDb, snapshotDb } from './helpers/db';
import { expectError } from './helpers/errors';
import { priceOf } from './helpers/products';
import { backdate } from './helpers/recovery';

const N = 2;
const { app, appWith, db, pool } = createTestApp({ COUPON_EVERY_N_ORDERS: String(N) });
const { cartWith } = cartRequests(app);

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

async function listOrders(query = '') {
  const res = await app.request(`/admin/orders${query}`);
  expect(res.status).toBe(200);
  return z.array(orderViewSchema).parse(await res.json());
}

async function getOrder(orderId: string) {
  const res = await app.request(`/orders/${orderId}`);
  expect(res.status).toBe(200);
  return orderViewSchema.parse(await res.json());
}

describe('GET /admin/orders', () => {
  it('is empty before any checkout', async () => {
    expect(await listOrders()).toEqual([]);
  });

  it('lists every order oldest first, each equal to GET /orders/:id, and filters by status', async () => {
    const paid = await expectOrder(
      await postCheckout(app, await cartWith({ p_lamp: 1, p_mouse: 2 }), newKey(), visa(priceOf('p_lamp') + 2 * priceOf('p_mouse'))),
      201,
    );
    const declined = await postCheckout(app, await cartWith({ p_cable: 1 }), newKey(), {
      expectedTotalPaise: priceOf('p_cable'),
      paymentToken: 'pm_card_chargeDeclined',
    });
    await expectError(declined, 402, 'PAYMENT_FAILED');
    const second = await expectOrder(await postCheckout(app, await cartWith({ p_mouse: 1 }), newKey(), visa(priceOf('p_mouse'))), 201);

    const all = await listOrders();
    expect(all.map((order) => order.status)).toEqual(['paid', 'failed', 'paid']);
    expect([all[0]?.id, all[2]?.id]).toEqual([paid.id, second.id]);
    for (const order of all) expect(order).toEqual(await getOrder(order.id));

    expect(await listOrders('?status=paid')).toEqual([all[0], all[2]]);
    expect(await listOrders('?status=failed')).toEqual([all[1]]);
    expect(await listOrders('?status=pending_payment')).toEqual([]);
  });

  it.each(['?status=bogus', '?status=', '?status=PAID', '?status=paid&status=failed'])('rejects %s with 400 VALIDATION_ERROR', async (query) => {
    const error = await expectError(await app.request(`/admin/orders${query}`), 400, 'VALIDATION_ERROR');
    expect(error.details).toEqual([expect.objectContaining({ path: 'query.status' })]);
  });
});

const reportSchema = z.strictObject({
  paidOrders: z.int(),
  ordersByStatus: z.strictObject({ paid: z.int(), pending_payment: z.int(), failed: z.int() }),
  quantityByProduct: z.array(z.strictObject({ productId: z.string(), name: z.string(), quantity: z.int() })),
  grossRevenuePaise: z.int(),
  discountsPaise: z.int(),
  netRevenuePaise: z.int(),
  coupons: z.strictObject({ generated: z.int(), available: z.int(), reserved: z.int(), redeemed: z.int() }),
  milestones: z.strictObject({ n: z.int(), reached: z.int(), rewarded: z.int(), unrewarded: z.int() }),
});

async function getReport() {
  const res = await app.request('/admin/report');
  expect(res.status).toBe(200);
  return reportSchema.parse(await res.json());
}

const nameOf = (productId: string) => SEED_PRODUCTS.find((p) => p.id === productId)?.name;

async function newCoupon() {
  const res = await generateCoupon(app);
  expect(res.status).toBe(201);
  return generatedSchema.parse(await res.json()).coupon.code;
}

/** The report's sales figures, recomputed from a list of paid order views. */
function salesOf(paid: OrderView[]) {
  const quantities = new Map<string, number>();
  for (const line of paid.flatMap((order) => order.lines)) {
    quantities.set(line.productId, (quantities.get(line.productId) ?? 0) + line.quantity);
  }
  const sum = (field: 'subtotalPaise' | 'discountPaise' | 'totalPaise') => paid.reduce((acc, order) => acc + order[field], 0);
  return {
    paidOrders: paid.length,
    grossRevenuePaise: sum('subtotalPaise'),
    discountsPaise: sum('discountPaise'),
    netRevenuePaise: sum('totalPaise'),
    quantities: Object.fromEntries(quantities),
  };
}

describe('GET /admin/report', () => {
  it('reports zeros before any order', async () => {
    expect(await getReport()).toEqual({
      paidOrders: 0,
      ordersByStatus: { paid: 0, pending_payment: 0, failed: 0 },
      quantityByProduct: [],
      grossRevenuePaise: 0,
      discountsPaise: 0,
      netRevenuePaise: 0,
      coupons: { generated: 0, available: 0, reserved: 0, redeemed: 0 },
      milestones: { n: N, reached: 0, rewarded: 0, unrewarded: 0 },
    });
  });

  it('reaches no milestone at n − 1 paid orders', async () => {
    await payOrders(app, N - 1);

    const report = await getReport();
    expect(report.ordersByStatus.paid).toBe(N - 1);
    expect(report.milestones).toEqual({ n: N, reached: 0, rewarded: 0, unrewarded: 0 });
  });

  it('names products as they are now, while the order keeps the name it was sold under', async () => {
    const order = await expectOrder(await postCheckout(app, await cartWith({ p_lamp: 2 }), newKey(), visa(2 * priceOf('p_lamp'))), 201);
    expect((await sendJson(app, 'PATCH', '/admin/products/p_lamp', { name: 'Desk Lamp II' })).status).toBe(200);

    expect((await getReport()).quantityByProduct).toEqual([{ productId: 'p_lamp', name: 'Desk Lamp II', quantity: 2 }]);
    expect((await getOrder(order.id)).lines).toEqual([expect.objectContaining({ productName: nameOf('p_lamp'), quantity: 2 })]);
  });
});

describe('T26 the report after a mixed run of paid, failed and pending orders, with coupons', () => {
  it('reconciles with the orders list and the coupons, is repeatable, and no GET mutates anything', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await payOrders(app, 2 * N);
    const [redeemedCode, staleCode] = [await newCoupon(), await newCoupon()];
    const withCoupon = priceOf('p_lamp') + priceOf('p_mouse');
    await expectOrder(
      await postCheckout(app, await cartWith({ p_lamp: 1, p_mouse: 1 }), newKey(), { ...visa(withTenPercent(withCoupon)), couponCode: redeemedCode }),
      201,
    );
    await payOrders(app, 1);
    const releasedCode = await newCoupon();
    const declined = await postCheckout(app, await cartWith({ p_keyboard: 1 }), newKey(), {
      expectedTotalPaise: withTenPercent(priceOf('p_keyboard')),
      paymentToken: 'pm_card_chargeDeclined',
      couponCode: releasedCode,
    });
    await expectError(declined, 402, 'PAYMENT_FAILED');
    await payOrders(app, 2);
    const unknownOutcome = appWith(throwingGateway);
    await expectOrder(await postCheckout(unknownOutcome, await cartWith({ p_monitor: 1 }), newKey(), visa(priceOf('p_monitor'))), 202);
    // Every PUT and checkout recovers stale orders sharing its product or coupon, so the stale order is made last.
    const stale = await expectOrder(
      await postCheckout(unknownOutcome, await cartWith({ p_cable: 1 }), newKey(), {
        ...visa(withTenPercent(priceOf('p_cable'))),
        couponCode: staleCode,
      }),
      202,
    );
    await backdate(db, stale.id);

    const report = await getReport();
    const paidMouseOrders = 2 * N + 1 + 2;
    expect(report).toEqual({
      paidOrders: paidMouseOrders + 1,
      ordersByStatus: { paid: paidMouseOrders + 1, pending_payment: 2, failed: 1 },
      quantityByProduct: [
        { productId: 'p_lamp', name: nameOf('p_lamp'), quantity: 1 },
        { productId: 'p_mouse', name: nameOf('p_mouse'), quantity: paidMouseOrders + 1 },
      ],
      grossRevenuePaise: paidMouseOrders * priceOf('p_mouse') + withCoupon,
      discountsPaise: discount(withCoupon, 10),
      netRevenuePaise: paidMouseOrders * priceOf('p_mouse') + withTenPercent(withCoupon),
      coupons: { generated: 3, available: 1, reserved: 1, redeemed: 1 },
      milestones: { n: N, reached: 4, rewarded: 3, unrewarded: 1 },
    });

    const paid = await listOrders('?status=paid');
    const pending = await listOrders('?status=pending_payment');
    const failed = await listOrders('?status=failed');
    expect(salesOf(paid)).toEqual({
      paidOrders: report.paidOrders,
      grossRevenuePaise: report.grossRevenuePaise,
      discountsPaise: report.discountsPaise,
      netRevenuePaise: report.netRevenuePaise,
      quantities: Object.fromEntries(report.quantityByProduct.map((p) => [p.productId, p.quantity])),
    });
    expect({ paid: paid.length, pending_payment: pending.length, failed: failed.length }).toEqual(report.ordersByStatus);
    expect(paid.filter((order) => order.coupon !== null)).toHaveLength(report.coupons.redeemed);
    expect(pending.filter((order) => order.coupon !== null)).toHaveLength(report.coupons.reserved);

    expect(await getReport()).toEqual(report);

    // Through the FakeGateway app, any recovery a GET ran would fail the stale order.
    const before = await snapshotDb(db);
    await getReport();
    await expectError(await app.request(`/carts/${stale.cartId}?couponCode=${staleCode}`), 409, 'COUPON_RESERVED');
    expect((await getOrder(stale.id)).status).toBe('pending_payment');
    await listOrders();
    await listOrders('?status=pending_payment');
    expect(await snapshotDb(db)).toEqual(before);
    expect(await orderStatus(db, stale.id)).toBe('pending_payment');
  });
});
