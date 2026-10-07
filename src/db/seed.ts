import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { products } from './schema';

export const SEED_PRODUCTS = [
  { id: 'p_keyboard', name: 'Mechanical Keyboard', pricePaise: 499_900, stock: 50 },
  { id: 'p_mouse', name: 'Wireless Mouse', pricePaise: 129_950, stock: 100 },
  { id: 'p_monitor', name: '27" Monitor', pricePaise: 1_899_900, stock: 20 },
  { id: 'p_cable', name: 'USB-C Cable', pricePaise: 34_999, stock: 500 },
  { id: 'p_lamp', name: 'Limited Edition Desk Lamp', pricePaise: 249_900, stock: 3 },
];

export async function seed(db: Db): Promise<void> {
  await db
    .insert(products)
    .values(SEED_PRODUCTS)
    .onConflictDoUpdate({
      target: products.id,
      set: {
        name: sql`excluded.name`,
        pricePaise: sql`excluded.price_paise`,
        stock: sql`excluded.stock`,
        updatedAt: sql`now()`,
      },
    });
}
