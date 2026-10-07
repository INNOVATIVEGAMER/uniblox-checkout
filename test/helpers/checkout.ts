import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { z } from 'zod';
import type { Db } from '../../src/db/client';
import { ORDER_STATUSES, idempotencyKeys, orders, products } from '../../src/db/schema';
import type { checkoutBodySchema } from '../../src/modules/checkout/input';
import type { PaymentGateway } from '../../src/modules/payments/gateway';
import { type TestApp, sendJson } from './app';

export const orderViewSchema = z.strictObject({
  id: z.uuid(),
  cartId: z.uuid(),
  status: z.enum(ORDER_STATUSES),
  lines: z.array(
    z.strictObject({
      productId: z.string(),
      productName: z.string(),
      unitPricePaise: z.int(),
      quantity: z.int(),
      lineTotalPaise: z.int(),
    }),
  ),
  subtotalPaise: z.int(),
  discountPaise: z.int(),
  totalPaise: z.int(),
  paymentRef: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});

export type OrderView = z.infer<typeof orderViewSchema>;

export const newKey = () => `key-${randomUUID()}`;

export type CheckoutBody = z.infer<typeof checkoutBodySchema>;

export function postCheckout(app: TestApp, cartId: string, key: string, body: CheckoutBody) {
  return sendJson(app, 'POST', `/carts/${cartId}/checkout`, body, { 'Idempotency-Key': key });
}

export const visa = (expectedTotalPaise: number): CheckoutBody => ({ expectedTotalPaise, paymentToken: 'pm_card_visa' });

/** Asserts the status and whether the response is a replay, and parses the order view. */
export async function expectOrder(res: Response, status: 201 | 202, { replayed = false } = {}): Promise<OrderView> {
  expect(res.status).toBe(status);
  expect(res.headers.get('Idempotent-Replayed')).toBe(replayed ? 'true' : null);
  expect(res.headers.get('Retry-After')).toBe(status === 202 ? '5' : null);
  return orderViewSchema.parse(await res.json());
}

export const throwingGateway: PaymentGateway = {
  charge: () => Promise.reject(new Error('connection reset')),
};

export async function keyRow(db: Db, key: string) {
  const [row] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
  return row;
}

export async function stockOf(db: Db, productId: string): Promise<number | undefined> {
  const [row] = await db.select({ stock: products.stock }).from(products).where(eq(products.id, productId));
  return row?.stock;
}

export async function orderCount(db: Db): Promise<number> {
  return db.$count(orders);
}

export async function orderStatus(db: Db, orderId: string) {
  const [row] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  return row?.status;
}

const countSchema = z.tuple([z.object({ n: z.number() })]);

/** Backends in this database sitting idle inside an open transaction. */
export async function idleInTransaction(db: Db): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE state = 'idle in transaction' AND datname = current_database()`);
  return countSchema.parse(result.rows)[0].n;
}
