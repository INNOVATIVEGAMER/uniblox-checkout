import { type SQL, asc, eq, sql } from 'drizzle-orm';
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

/**
 * Order views matching `where`, oldest first. The lines are read by the fetched ids, not by `where`: an order's
 * status can change between the two reads, but its lines commit with it and never change.
 */
export async function selectOrderViews(db: Db, where?: SQL) {
  const rows = await db
    .select(orderColumns)
    .from(orders)
    .leftJoin(coupons, eq(coupons.id, orders.couponId))
    .where(where)
    .orderBy(asc(orders.createdAt), asc(orders.id));
  const lines = await db
    .select({ orderId: orderItems.orderId, line: lineColumns })
    .from(orderItems)
    .where(sql`${orderItems.orderId} = ANY(${sql.param(rows.map((r) => r.id))})`)
    .orderBy(asc(orderItems.orderId), asc(orderItems.productId));

  const linesByOrder = new Map<string, (typeof lines)[number]['line'][]>();
  for (const { orderId, line } of lines) {
    const group = linesByOrder.get(orderId);
    if (group) group.push(line);
    else linesByOrder.set(orderId, [line]);
  }
  return rows.map(({ couponCode, percentOff, ...order }) => ({
    ...order,
    coupon: toCouponView(couponCode, percentOff),
    lines: linesByOrder.get(order.id) ?? [],
  }));
}

export async function loadOrderView(db: Db, orderId: string) {
  const [view] = await selectOrderViews(db, eq(orders.id, orderId));
  if (!view) throw new AppError('ORDER_NOT_FOUND');
  return view;
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
