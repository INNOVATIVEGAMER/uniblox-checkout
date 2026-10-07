import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { carts, coupons, orderItems, orders, products } from '../../db/schema';
import { lockProducts } from '../products/lock';
import type { Resolution } from './gateway';

function resolvedColumns(resolution: Resolution) {
  if (resolution.outcome === 'approved') {
    return { status: 'paid' as const, paymentRef: resolution.paymentRef, resolvedAt: sql`now()` };
  }
  return { status: 'failed' as const, failureReason: resolution.reason, resolvedAt: sql`now()` };
}

function couponColumns(resolution: Resolution) {
  if (resolution.outcome === 'approved') return { status: 'redeemed' as const, redeemedAt: sql`now()` };
  return { status: 'available' as const };
}

/**
 * Moves a pending order to paid or failed, exactly once. A decline adds the reserved units back on top of
 * the current stock, reopens the cart and releases the coupon. Safe to race: whichever caller loses the
 * conditional update changes nothing. The coupon is written last on both paths, after the products, to
 * keep the lock order reserve uses.
 */
export function finalizeOrder(db: Db, orderId: string, resolution: Resolution): Promise<void> {
  return db.transaction(
    async (tx) => {
      const [order] = await tx
        .select({ cartId: orders.cartId, couponId: orders.couponId })
        .from(orders)
        .where(eq(orders.id, orderId));
      if (!order) throw new Error(`order ${orderId} to finalize has no row`);
      await tx.select({ id: carts.id }).from(carts).where(eq(carts.id, order.cartId)).for('no key update');

      const claimed = await tx
        .update(orders)
        .set(resolvedColumns(resolution))
        .where(and(eq(orders.id, orderId), eq(orders.status, 'pending_payment')))
        .returning({ id: orders.id });
      if (claimed.length === 0) return;

      if (resolution.outcome === 'approved') {
        await tx.update(carts).set({ status: 'checked_out' }).where(eq(carts.id, order.cartId));
      } else {
        const items = await tx.select({ productId: orderItems.productId }).from(orderItems).where(eq(orderItems.orderId, orderId));
        await lockProducts(tx, items.map((item) => item.productId));
        await tx
          .update(products)
          .set({ stock: sql`${products.stock} + ${orderItems.quantity}` })
          .from(orderItems)
          .where(and(eq(orderItems.orderId, orderId), eq(orderItems.productId, products.id)));
        await tx.update(carts).set({ status: 'open' }).where(eq(carts.id, order.cartId));
      }

      if (order.couponId) await tx.update(coupons).set(couponColumns(resolution)).where(eq(coupons.id, order.couponId));
    },
    { isolationLevel: 'read committed' },
  );
}
