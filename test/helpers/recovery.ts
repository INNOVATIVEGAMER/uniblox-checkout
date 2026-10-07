import { eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { z } from 'zod';
import type { Db } from '../../src/db/client';
import { orders } from '../../src/db/schema';
import type { TestApp } from './app';

export const reconcileBodySchema = z.strictObject({
  resolved: z.array(z.strictObject({ orderId: z.uuid(), status: z.enum(['paid', 'failed']) })),
  stillPending: z.int(),
});

export async function postReconcile(app: TestApp) {
  const res = await app.request('/admin/payments/reconcile', { method: 'POST' });
  expect(res.status).toBe(200);
  return reconcileBodySchema.parse(await res.json());
}

/** Moves the order's created_at a day back, past any TTL the tests configure. */
export async function backdate(db: Db, orderId: string): Promise<void> {
  await db
    .update(orders)
    .set({ createdAt: sql`${orders.createdAt} - interval '1 day'` })
    .where(eq(orders.id, orderId));
}

/** The order's resolution columns, with resolved_at as text so a rewrite within the same millisecond still shows. */
export async function resolutionRow(db: Db, orderId: string) {
  const [row] = await db
    .select({
      status: orders.status,
      failureReason: orders.failureReason,
      paymentRef: orders.paymentRef,
      resolvedAt: sql<string | null>`${orders.resolvedAt}::text`,
    })
    .from(orders)
    .where(eq(orders.id, orderId));
  expect(row).toBeDefined();
  return row;
}
