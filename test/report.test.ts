import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp } from './helpers/app';
import { cartRequests } from './helpers/carts';
import { expectOrder, newKey, orderViewSchema, postCheckout, visa } from './helpers/checkout';
import { resetDb } from './helpers/db';
import { expectError } from './helpers/errors';
import { priceOf } from './helpers/products';

const { app, db, pool } = createTestApp();
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
