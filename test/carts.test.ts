import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cartItems, products } from '../src/db/schema';
import { MAX_CART_LINES } from '../src/domain/money';
import type { ErrorCode } from '../src/errors';
import { FakeGateway } from '../src/modules/payments/fake-gateway';
import { createTestApp, sendJson } from './helpers/app';
import { bulkId, cartRequests, cartViewSchema, fillCart } from './helpers/carts';
import { expectOrder, newKey, postCheckout, visa } from './helpers/checkout';
import { resetDb, snapshotDb } from './helpers/db';
import { expectError } from './helpers/errors';
import { type Gate, gated } from './helpers/gate';
import { priceOf } from './helpers/products';

const { app, appWith, db, pool } = createTestApp();

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

const { newCart, putItem, deleteItem, getCart, cartWith } = cartRequests(app);

async function expectView(res: Response, status: number) {
  expect(res.status).toBe(status);
  return cartViewSchema.parse(await res.json());
}

const keyboard = { productId: 'p_keyboard', name: 'Mechanical Keyboard', unitPricePaise: priceOf('p_keyboard') };

describe('cart lifecycle', () => {
  it('POST creates an empty open cart, and GET returns it', async () => {
    const res = await app.request('/carts', { method: 'POST' });
    const created = await expectView(res, 201);
    expect(created).toEqual({
      id: expect.any(String),
      status: 'open',
      orderId: null,
      lines: [],
      subtotalPaise: 0,
      coupon: null,
      discountPaise: 0,
      totalPaise: 0,
    });
    expect(await getCart(created.id)).toEqual(created);
  });

  it('PUT sets the quantity: 201 when it adds the line, 200 when it changes it, and a repeat never adds', async () => {
    const cartId = await newCart();
    const line = (quantity: number) => ({
      ...keyboard,
      quantity,
      lineTotalPaise: priceOf('p_keyboard') * quantity,
      available: true,
    });

    expect((await expectView(await putItem(cartId, 'p_keyboard', 2), 201)).lines).toEqual([line(2)]);
    expect((await expectView(await putItem(cartId, 'p_keyboard', 2), 200)).lines).toEqual([line(2)]);
    expect((await expectView(await putItem(cartId, 'p_keyboard', 1), 200)).lines).toEqual([line(1)]);

    const rows = await db.select().from(cartItems);
    expect(rows).toEqual([{ cartId, productId: 'p_keyboard', quantity: 1 }]);
  });

  it('DELETE removes the line, and deleting an absent or unknown line still returns 200 with the cart', async () => {
    const cartId = await newCart();
    await putItem(cartId, 'p_mouse', 1);
    await putItem(cartId, 'p_cable', 2);

    const afterDelete = await expectView(await deleteItem(cartId, 'p_mouse'), 200);
    expect(afterDelete.lines.map((l) => l.productId)).toEqual(['p_cable']);

    expect(await expectView(await deleteItem(cartId, 'p_mouse'), 200)).toEqual(afterDelete);
    expect(await expectView(await deleteItem(cartId, 'p_nope'), 200)).toEqual(afterDelete);
    expect(await getCart(cartId)).toEqual(afterDelete);
  });
});

describe('T24 cart view', () => {
  it('prices lines live with odd-paise totals, in product id order', async () => {
    const cartId = await newCart();
    await putItem(cartId, 'p_mouse', 1);
    await putItem(cartId, 'p_cable', 3);

    expect(await getCart(cartId)).toEqual({
      id: cartId,
      status: 'open',
      orderId: null,
      lines: [
        {
          productId: 'p_cable',
          name: 'USB-C Cable',
          unitPricePaise: priceOf('p_cable'),
          quantity: 3,
          lineTotalPaise: 3 * priceOf('p_cable'),
          available: true,
        },
        {
          productId: 'p_mouse',
          name: 'Wireless Mouse',
          unitPricePaise: priceOf('p_mouse'),
          quantity: 1,
          lineTotalPaise: priceOf('p_mouse'),
          available: true,
        },
      ],
      subtotalPaise: 3 * priceOf('p_cable') + priceOf('p_mouse'),
      coupon: null,
      discountPaise: 0,
      totalPaise: 3 * priceOf('p_cable') + priceOf('p_mouse'),
    });
  });

  it('shows available:false and the new price after an admin PATCH', async () => {
    const cartId = await newCart();
    await putItem(cartId, 'p_lamp', 2);
    await putItem(cartId, 'p_mouse', 1);

    expect((await sendJson(app, 'PATCH', '/admin/products/p_lamp', { stock: 0, pricePaise: 1 })).status).toBe(200);

    const view = await getCart(cartId);
    expect(view.lines.map((l) => [l.productId, l.available, l.lineTotalPaise])).toEqual([
      ['p_lamp', false, 2],
      ['p_mouse', true, priceOf('p_mouse')],
    ]);
    expect(view.subtotalPaise).toBe(2 + priceOf('p_mouse'));
  });
});

describe('T24 soft stock check', () => {
  it('accepts a quantity equal to the stock', async () => {
    const cartId = await newCart();
    const view = await expectView(await putItem(cartId, 'p_lamp', 3), 201);
    expect(view.lines).toEqual([expect.objectContaining({ productId: 'p_lamp', quantity: 3, available: true })]);
  });

  it('accepts the 1000 quantity cap when the stock allows it', async () => {
    await db.update(products).set({ stock: 1000 }).where(eq(products.id, 'p_cable'));
    const cartId = await newCart();
    await expectView(await putItem(cartId, 'p_cable', 1000), 201);
  });

  it('rejects a new line above the stock with 409 and adds nothing', async () => {
    const cartId = await newCart();
    const before = await snapshotDb(db);

    const error = await expectError(await putItem(cartId, 'p_lamp', 4), 409, 'INSUFFICIENT_STOCK');
    expect(error.details).toEqual([{ productId: 'p_lamp', requested: 4, available: 3 }]);
    expect(await snapshotDb(db)).toEqual(before);
  });

  it('rejects raising an existing line above the stock with 409 and keeps its quantity', async () => {
    const cartId = await newCart();
    await putItem(cartId, 'p_lamp', 2);
    const before = await snapshotDb(db);

    await expectError(await putItem(cartId, 'p_lamp', 4), 409, 'INSUFFICIENT_STOCK');
    expect(await snapshotDb(db)).toEqual(before);
  });
});

describe('T24 line cap', () => {
  async function cartWithBulkLines(lineCount: number): Promise<string> {
    const cartId = await newCart();
    await fillCart(db, cartId, lineCount);
    return cartId;
  }

  it(`allows the ${MAX_CART_LINES}th line, rejects the next new line with 422, and still allows changes`, async () => {
    const cartId = await cartWithBulkLines(MAX_CART_LINES - 1);

    const full = await expectView(await putItem(cartId, bulkId(MAX_CART_LINES), 1), 201);
    expect(full.lines).toHaveLength(MAX_CART_LINES);

    const before = await snapshotDb(db);
    const error = await expectError(await putItem(cartId, bulkId(MAX_CART_LINES + 1), 1), 422, 'CART_LINE_LIMIT');
    expect(error.details).toEqual({ maxLines: MAX_CART_LINES });
    expect(await snapshotDb(db)).toEqual(before);

    const changed = await expectView(await putItem(cartId, bulkId(1), 5), 200);
    expect(changed.lines).toHaveLength(MAX_CART_LINES);
    expect(changed.lines[0]).toMatchObject({ productId: bulkId(1), quantity: 5 });
  });

  it.each([
    ['a product above its stock', 'p_lamp', 4, 409, 'INSUFFICIENT_STOCK'],
    ['an unknown product', 'p_nope', 1, 404, 'PRODUCT_NOT_FOUND'],
  ] as const)('on a full cart, a new line with %s gets %i %s, not the line cap', async (_label, productId, quantity, status, code) => {
    const cartId = await cartWithBulkLines(MAX_CART_LINES);
    await expectError(await putItem(cartId, productId, quantity), status, code);
  });
});

const lockedWrites = [
  ['PUT changing a line', (cartId: string) => putItem(cartId, 'p_lamp', 2)],
  ['PUT adding a line', (cartId: string) => putItem(cartId, 'p_mouse', 1)],
  ['DELETE of a line', (cartId: string) => deleteItem(cartId, 'p_lamp')],
  ['DELETE of an absent line', (cartId: string) => deleteItem(cartId, 'p_mouse')],
] as const;

async function expectLockedWrite(send: () => Promise<Response>, code: ErrorCode, orderId: string) {
  const before = await snapshotDb(db);
  const error = await expectError(await send(), 409, code);
  expect(error.details).toEqual({ orderId });
  expect(await snapshotDb(db)).toEqual(before);
}

async function expectReadable(cartId: string, status: string, orderId: string) {
  const view = await getCart(cartId);
  expect(view).toMatchObject({ status, orderId });
  expect(view.lines.map((l) => [l.productId, l.quantity])).toEqual([['p_lamp', 1]]);
}

describe('T24 a checked-out cart', () => {
  let cartId: string;
  let orderId: string;

  beforeEach(async () => {
    cartId = await cartWith({ p_lamp: 1 });
    orderId = (await expectOrder(await postCheckout(app, cartId, newKey(), visa(priceOf('p_lamp'))), 201)).id;
  });

  it.each(lockedWrites)('rejects %s with 409 CART_CHECKED_OUT and changes nothing', async (_label, send) => {
    await expectLockedWrite(() => send(cartId), 'CART_CHECKED_OUT', orderId);
  });

  it('is still readable, with its status, order and lines', () => expectReadable(cartId, 'checked_out', orderId));
});

describe('T24 a cart whose payment is pending (gated)', () => {
  let gate: Gate;
  let pending: Promise<Response>;
  let cartId: string;
  let orderId: string;

  beforeEach(async () => {
    gate = gated(new FakeGateway(), { at: 'before' });
    cartId = await cartWith({ p_lamp: 1 });
    pending = postCheckout(appWith(gate.gateway), cartId, newKey(), {
      expectedTotalPaise: priceOf('p_lamp'),
      paymentToken: 'pm_card_chargeDeclined',
    });
    await gate.entered();
    orderId = z.uuid().parse((await getCart(cartId)).orderId);
  });

  afterEach(async () => {
    gate.release();
    await pending;
  });

  it.each(lockedWrites)('rejects %s with 409 CART_PAYMENT_PENDING and changes nothing', async (_label, send) => {
    await expectLockedWrite(() => send(cartId), 'CART_PAYMENT_PENDING', orderId);
  });

  it('is still readable, with its status, order and lines', () => expectReadable(cartId, 'pending_payment', orderId));

  it('accepts the PUT once a decline reopens the cart', async () => {
    gate.release();
    await expectError(await pending, 402, 'PAYMENT_FAILED');
    const view = await expectView(await putItem(cartId, 'p_lamp', 2), 200);
    expect(view).toMatchObject({ status: 'open', orderId: null });
  });
});
