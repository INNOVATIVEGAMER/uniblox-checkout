import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { MAX_LINE_QUANTITY, MAX_UNIT_PRICE_PAISE } from '../domain/money';

export const CART_STATUSES = ['open', 'pending_payment', 'checked_out'] as const;
export const ORDER_STATUSES = ['pending_payment', 'paid', 'failed'] as const;
export const COUPON_STATUSES = ['available', 'reserved', 'redeemed'] as const;

// drizzle-kit writes an interpolated value into a CHECK as a `$1` placeholder, so constants go in through sql.raw.
const sqlList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

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
    check('products_price_paise_range', sql`${t.pricePaise} BETWEEN 0 AND ${sql.raw(String(MAX_UNIT_PRICE_PAISE))}`),
    check('products_stock_nonneg', sql`${t.stock} >= 0`),
  ],
);

export const carts = pgTable(
  'carts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: text('status', { enum: CART_STATUSES })
      .notNull()
      .default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('carts_status_valid', sql`${t.status} IN (${sqlList(CART_STATUSES)})`)],
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
    check('cart_items_quantity_range', sql`${t.quantity} BETWEEN 1 AND ${sql.raw(String(MAX_LINE_QUANTITY))}`),
  ],
);

export const coupons = pgTable(
  'coupons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    milestone: integer('milestone').notNull().unique(),
    percentOff: integer('percent_off').notNull(),
    status: text('status', { enum: COUPON_STATUSES })
      .notNull()
      .default('available'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  },
  (t) => [
    check('coupons_status_valid', sql`${t.status} IN (${sqlList(COUPON_STATUSES)})`),
    check('coupons_percent_off_range', sql`${t.percentOff} BETWEEN 1 AND 100`),
    check('coupons_redeemed_at_iff_redeemed', sql`(${t.status} = 'redeemed') = (${t.redeemedAt} IS NOT NULL)`),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id),
    status: text('status', { enum: ORDER_STATUSES })
      .notNull()
      .default('pending_payment'),
    subtotalPaise: bigint('subtotal_paise', { mode: 'number' }).notNull(),
    discountPaise: bigint('discount_paise', { mode: 'number' }).notNull(),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull(),
    couponId: uuid('coupon_id').references(() => coupons.id),
    percentOff: integer('percent_off'),
    paymentRef: text('payment_ref'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    check('orders_status_valid', sql`${t.status} IN (${sqlList(ORDER_STATUSES)})`),
    check('orders_total_nonneg', sql`${t.totalPaise} >= 0`),
    check('orders_total_formula', sql`${t.totalPaise} = ${t.subtotalPaise} - ${t.discountPaise}`),
    // Integer division truncates, which equals floor for non-negative values, so this matches discount() in money.ts.
    check('orders_discount_formula', sql`${t.discountPaise} = COALESCE(${t.subtotalPaise} * ${t.percentOff} / 100, 0)`),
    check('orders_coupon_percent_pair', sql`(${t.couponId} IS NULL) = (${t.percentOff} IS NULL)`),
    check('orders_percent_off_range', sql`${t.percentOff} BETWEEN 1 AND 100`),
    check('orders_resolved_iff_not_pending', sql`(${t.status} = 'pending_payment') = (${t.resolvedAt} IS NULL)`),
    check('orders_failure_reason_iff_failed', sql`(${t.status} = 'failed') = (${t.failureReason} IS NOT NULL)`),
    check('orders_paid_has_payment_ref', sql`${t.status} <> 'paid' OR ${t.totalPaise} = 0 OR ${t.paymentRef} IS NOT NULL`),
    uniqueIndex('orders_live_cart_uq').on(t.cartId).where(sql`${t.status} <> 'failed'`),
    uniqueIndex('orders_live_coupon_uq').on(t.couponId).where(sql`${t.status} <> 'failed'`),
    index('orders_pending_created_at_idx').on(t.createdAt).where(sql`${t.status} = 'pending_payment'`),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    productId: text('product_id')
      .notNull()
      .references(() => products.id),
    productName: text('product_name').notNull(),
    unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
    quantity: integer('quantity').notNull(),
    lineTotalPaise: bigint('line_total_paise', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.productId] }),
    check('order_items_quantity_range', sql`${t.quantity} BETWEEN 1 AND ${sql.raw(String(MAX_LINE_QUANTITY))}`),
    check('order_items_line_total_formula', sql`${t.lineTotalPaise} = ${t.unitPricePaise} * ${t.quantity}`),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    requestHash: text('request_hash').notNull(),
    orderId: uuid('order_id')
      .unique()
      .references(() => orders.id),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('idempotency_keys_response_pair', sql`(${t.responseStatus} IS NULL) = (${t.responseBody} IS NULL)`),
    check('idempotency_keys_one_replay_source', sql`${t.orderId} IS NULL OR ${t.responseStatus} IS NULL`),
  ],
);
