import { and, asc, eq, exists, inArray, lt, or, sql } from 'drizzle-orm';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { coupons, orderItems, orders } from '../../db/schema';
import { finalizeOrder } from './finalize';
import { type PaymentGateway, type Resolution, zeroTotalResolution } from './gateway';

export type RecoveryDeps = {
  db: Db;
  gateway: PaymentGateway;
  config: Pick<Config, 'PAYMENT_PENDING_TTL_SECONDS' | 'GATEWAY_TIMEOUT_MS'>;
};

export type PendingOrder = { id: string; totalPaise: number };

/** A union, so a caller that forgets the request's filters fails to compile instead of recovering every order. */
export type StaleScope =
  | { scope: 'all' }
  | { scope: 'request'; cartId: string; couponCode?: string; productIds: string[] };

function scopeFilter(db: Db, s: StaleScope) {
  if (s.scope === 'all') return undefined;
  const holdsProduct = exists(
    db
      .select({ one: sql`1` })
      .from(orderItems)
      .where(and(eq(orderItems.orderId, orders.id), inArray(orderItems.productId, s.productIds))),
  );
  const holdsCoupon = s.couponCode === undefined ? undefined : eq(coupons.code, s.couponCode);
  return or(eq(orders.cartId, s.cartId), holdsCoupon, holdsProduct);
}

/** Pending orders older than the TTL, measured on the database clock. */
export function findStalePending(db: Db, ttlSeconds: number, s: StaleScope): Promise<PendingOrder[]> {
  return db
    .select({ id: orders.id, totalPaise: orders.totalPaise })
    .from(orders)
    .leftJoin(coupons, eq(coupons.id, orders.couponId))
    .where(
      and(
        eq(orders.status, 'pending_payment'),
        lt(orders.createdAt, sql`now() - make_interval(secs => ${ttlSeconds})`),
        scopeFilter(db, s),
      ),
    )
    .orderBy(asc(orders.createdAt));
}

/** Not found means nothing landed yet, and the cancel makes sure nothing lands later, so release is safe. */
async function resolutionFor(gateway: PaymentGateway, order: PendingOrder): Promise<Resolution> {
  if (order.totalPaise === 0) return zeroTotalResolution;
  const retrieved = await gateway.retrieve(order.id);
  if (retrieved.outcome !== 'not_found') return retrieved;
  const cancelled = await gateway.cancel(order.id);
  if (cancelled.outcome !== 'cancelled') return cancelled;
  return { outcome: 'declined', reason: 'abandoned' };
}

/** Resolves one order from the gateway's record. A gateway error propagates and leaves the order pending. */
export async function resolvePendingOrder({ db, gateway }: Pick<RecoveryDeps, 'db' | 'gateway'>, order: PendingOrder) {
  const resolution = await resolutionFor(gateway, order);
  await finalizeOrder(db, order.id, resolution);
  return resolution.outcome === 'approved' ? ('paid' as const) : ('failed' as const);
}

/**
 * Resolves the stale orders in scope one at a time, outside any transaction, so no connection is held
 * while the gateway answers. A failure on one order is logged and leaves it pending.
 */
export async function recoverStale(deps: RecoveryDeps, s: StaleScope) {
  const resolved: { orderId: string; status: 'paid' | 'failed' }[] = [];
  for (const order of await findStalePending(deps.db, deps.config.PAYMENT_PENDING_TTL_SECONDS, s)) {
    try {
      resolved.push({ orderId: order.id, status: await resolvePendingOrder(deps, order) });
    } catch (err) {
      console.error('pending order recovery failed, order stays pending', { orderId: order.id, err });
    }
  }
  return resolved;
}

export async function reconcile(deps: RecoveryDeps) {
  const resolved = await recoverStale(deps, { scope: 'all' });
  const stillPending = await deps.db.$count(orders, eq(orders.status, 'pending_payment'));
  return { resolved, stillPending };
}
