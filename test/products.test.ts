import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { products } from '../src/db/schema';
import { SEED_PRODUCTS, seed } from '../src/db/seed';
import { MAX_UNIT_PRICE_PAISE } from '../src/domain/money';
import { createTestApp, sendJson } from './helpers/app';
import { holdLock } from './helpers/barrier';
import { withCleanup } from './helpers/cleanup';
import { resetDb } from './helpers/db';

const { app, db, pool } = createTestApp();

const SEED_BY_ID = [...SEED_PRODUCTS].sort((a, b) => a.id.localeCompare(b.id));

const productListSchema = z.array(
  z.strictObject({ id: z.string(), name: z.string(), pricePaise: z.int(), stock: z.int() }),
);

async function listProducts() {
  const res = await app.request('/products');
  expect(res.status).toBe(200);
  return productListSchema.parse(await res.json());
}

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

describe('GET /products', () => {
  it('lists the seed products in id order with integer paise', async () => {
    const body = await listProducts();
    expect(body).toEqual(SEED_BY_ID);
    expect(body[0]).toEqual({ id: 'p_cable', name: 'USB-C Cable', pricePaise: 34_999, stock: 500 });
  });

  it('returns an empty list when there are no products', async () => {
    await db.execute(sql`TRUNCATE products CASCADE`);
    expect(await listProducts()).toEqual([]);
  });
});

describe('PATCH /admin/products/:id', () => {
  it.each([
    ['name', { name: 'Desk Lamp II' }],
    ['pricePaise', { pricePaise: 199_999 }],
    ['stock', { stock: 7 }],
  ])('changes only %s, and GET /products reflects it', async (_field, change) => {
    const lamp = SEED_PRODUCTS.find((p) => p.id === 'p_lamp');
    const expected = { ...lamp, ...change };

    const res = await sendJson(app, 'PATCH', '/admin/products/p_lamp', change);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expected);

    expect(await listProducts()).toEqual(SEED_BY_ID.map((p) => (p.id === 'p_lamp' ? expected : p)));
  });

  it('changes several fields at once and trims the name', async () => {
    const res = await sendJson(app, 'PATCH', '/admin/products/p_cable', { name: '  Braided Cable ', pricePaise: 0, stock: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'p_cable', name: 'Braided Cable', pricePaise: 0, stock: 0 });
  });

  it('accepts a JSON Content-Type with parameters', async () => {
    const res = await app.request('/admin/products/p_mouse', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ stock: 1 }),
    });
    expect(res.status).toBe(200);
  });

  it('returns 503 LOCK_TIMEOUT when the row stays locked past LOCK_TIMEOUT_MS', async () => {
    const short = createTestApp({ LOCK_TIMEOUT_MS: '200' });
    const lock = await holdLock({ table: 'products', id: 'p_lamp' });
    await withCleanup(
      async () => {
        const res = await sendJson(short.app, 'PATCH', '/admin/products/p_lamp', { stock: 99 });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({
          error: { code: 'LOCK_TIMEOUT', message: expect.any(String) },
        });
      },
      lock.release,
      () => short.pool.end(),
    );
    expect(await listProducts()).toEqual(SEED_BY_ID);
  });
});

describe('products table', () => {
  const setLampPrice = (pricePaise: number) =>
    db.update(products).set({ pricePaise }).where(eq(products.id, 'p_lamp'));

  it('accepts a price at MAX_UNIT_PRICE_PAISE', async () => {
    await setLampPrice(MAX_UNIT_PRICE_PAISE);
    expect((await listProducts()).find((p) => p.id === 'p_lamp')?.pricePaise).toBe(MAX_UNIT_PRICE_PAISE);
  });

  it.each([
    ['above MAX_UNIT_PRICE_PAISE', MAX_UNIT_PRICE_PAISE + 1],
    ['below zero', -1],
  ])('rejects a price %s with the range CHECK, even when the write bypasses the API', async (_label, pricePaise) => {
    await expect(setLampPrice(pricePaise)).rejects.toMatchObject({
      cause: { code: '23514', constraint: 'products_price_paise_range' },
    });
  });
});

describe('seed', () => {
  it('is safe to re-run and restores edited rows', async () => {
    await db.update(products).set({ name: 'Edited', pricePaise: 1, stock: 0 });
    await seed(db);
    await seed(db);

    const rows = await db
      .select({ id: products.id, name: products.name, pricePaise: products.pricePaise, stock: products.stock })
      .from(products)
      .orderBy(asc(products.id));
    expect(rows).toEqual(SEED_BY_ID);
  });
});
