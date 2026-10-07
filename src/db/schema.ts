import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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

export const carts = pgTable(
  'carts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: text('status', { enum: ['open', 'pending_payment', 'checked_out'] })
      .notNull()
      .default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('carts_status_valid', sql`${t.status} IN ('open', 'pending_payment', 'checked_out')`)],
);

export const cartItems = pgTable(
  'cart_items',
  {
    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id),
    productId: text('product_id')
      .notNull()
      .references(() => products.id),
    quantity: integer('quantity').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cartId, t.productId] }),
    check('cart_items_quantity_range', sql`${t.quantity} BETWEEN 1 AND 1000`),
  ],
);
