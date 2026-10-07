import { asc, inArray } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { products } from '../../db/schema';

// Postgres takes the row locks after the sort, so every caller locks in ID order and two
// transactions sharing products can't deadlock.
export function lockProducts(tx: Tx, productIds: string[]) {
  return tx
    .select({ id: products.id, name: products.name, pricePaise: products.pricePaise, stock: products.stock })
    .from(products)
    .where(inArray(products.id, productIds))
    .orderBy(asc(products.id))
    .for('no key update');
}
