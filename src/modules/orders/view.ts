import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { orderItems, orders } from '../../db/schema';
import { AppError, toErrorBody } from '../../errors';

export const RETRY_AFTER_SECONDS = 5;

const orderColumns = {
  id: orders.id,
  cartId: orders.cartId,
  status: orders.status,
  subtotalPaise: orders.subtotalPaise,
  discountPaise: orders.discountPaise,
  totalPaise: orders.totalPaise,
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

type OrderRow = { [K in keyof typeof orderColumns]: (typeof orders.$inferSelect)[K] };
type OrderLine = { [K in keyof typeof lineColumns]: (typeof orderItems.$inferSelect)[K] };

export function toOrderView(order: OrderRow, lines: OrderLine[]) {
  return {
    id: order.id,
    cartId: order.cartId,
    status: order.status,
    lines,
    subtotalPaise: order.subtotalPaise,
    discountPaise: order.discountPaise,
    totalPaise: order.totalPaise,
    paymentRef: order.paymentRef,
    failureReason: order.failureReason,
    createdAt: order.createdAt,
    resolvedAt: order.resolvedAt,
  };
}

export type OrderView = ReturnType<typeof toOrderView>;

export async function loadOrderView(db: Db, orderId: string): Promise<OrderView> {
  const [order] = await db.select(orderColumns).from(orders).where(eq(orders.id, orderId));
  if (!order) throw new AppError('ORDER_NOT_FOUND');
  const lines = await db.select(lineColumns).from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.productId));
  return toOrderView(order, lines);
}

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
