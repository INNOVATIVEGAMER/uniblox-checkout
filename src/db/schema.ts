import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const products = pgTable(
  'products',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
    stock: integer('stock').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('products_price_paise_nonneg', sql`${t.pricePaise} >= 0`),
    check('products_stock_nonneg', sql`${t.stock} >= 0`),
  ],
);
