import { asc } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { products } from '../src/db/schema';
import { SEED_PRODUCTS, seed } from '../src/db/seed';
import { resetDb, testConfig } from './helpers/db';

const { db, pool } = createDb(testConfig());

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

describe('seed', () => {
  it('is safe to re-run and restores edited rows', async () => {
    await db.update(products).set({ name: 'Edited', pricePaise: 1, stock: 0 });
    await seed(db);
    await seed(db);

    const rows = await db
      .select({ id: products.id, name: products.name, pricePaise: products.pricePaise, stock: products.stock })
      .from(products)
      .orderBy(asc(products.id));
    expect(rows).toEqual([...SEED_PRODUCTS].sort((a, b) => a.id.localeCompare(b.id)));
  });
});
