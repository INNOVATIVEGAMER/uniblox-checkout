import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { coupons, orderItems, orders } from '../../db/schema';
import { AppError, toErrorBody } from '../../errors';

export const RETRY_AFTER_SECONDS = 5;

const orderColumns = {
  id: orders.id,
  cartId: orders.cartId,
  status: orders.status,
  subtotalPaise: orders.subtotalPaise,
  discountPaise: orders.discountPaise,
  totalPaise: orders.totalPaise,
  couponCode: coupons.code,
  percentOff: orders.percentOff,
  paymentRef: orders.paymentRef,
  failureReason: orders.failureReason,
  createdAt: orders.createdAt,
  resolvedAt: orders.resolvedAt,
};

const lineColumns = {
  productId: orderItems.productId,
  productName: orderItems.productName,
  unitPricePaise: orderItems.unitPricePaise,
  quantity: orderItems.quantity,
  lineTotalPaise: orderItems.lineTotalPaise,
};

// percentOff comes from the order, not the coupon, so the view shows the discount that was actually applied.
function toCouponView(code: string | null, percentOff: number | null) {
  if (code === null || percentOff === null) return null;
  return { code, percentOff };
}

export async function loadOrderView(db: Db, orderId: string) {
  const [row] = await db.select(orderColumns).from(orders).leftJoin(coupons, eq(coupons.id, orders.couponId)).where(eq(orders.id, orderId));
  if (!row) throw new AppError('ORDER_NOT_FOUND');
  const lines = await db.select(lineColumns).from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.productId));
  const { couponCode, percentOff, ...order } = row;
  return { ...order, coupon: toCouponView(couponCode, percentOff), lines };
}

export type OrderView = Awaited<ReturnType<typeof loadOrderView>>;

export type CheckoutResponse = { status: number; body: unknown; headers: Record<string, string> };

/** The checkout status comes from the order as it is now, so the first response and every replay agree. */
export function toCheckoutResponse(view: OrderView): CheckoutResponse {
  switch (view.status) {
    case 'paid':
      return { status: 201, body: view, headers: {} };
    case 'pending_payment':
      return { status: 202, body: view, headers: { 'Retry-After': String(RETRY_AFTER_SECONDS) } };
    case 'failed': {
      const err = new AppError('PAYMENT_FAILED', { orderId: view.id, reason: view.failureReason });
      return { status: err.status, body: toErrorBody(err), headers: {} };
    }
  }
}
