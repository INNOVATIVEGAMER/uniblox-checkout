import { type SQL, asc, eq, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { coupons, orderItems, orders, products } from '../../db/schema';
import { milestonesReached } from '../../domain/milestones';

// node-postgres returns bigint and numeric as strings, so every aggregate is cast to bigint and read as a number.
const asNumber = (aggregate: SQL) => sql`${aggregate}::bigint`.mapWith(Number);

const isPaid = eq(orders.status, 'paid');
const countWhere = (where: SQL) => asNumber(sql`count(*) FILTER (WHERE ${where})`);
const paidSum = (column: AnyPgColumn) => asNumber(sql`coalesce(sum(${column}) FILTER (WHERE ${isPaid}), 0)`);

function onlyRow<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error('an aggregate without GROUP BY returned no row');
  return row;
}

/** Every figure is read from one snapshot, so a checkout committing mid-report is either in all of them or in none. */
export function loadReport(db: Db, config: Pick<Config, 'COUPON_EVERY_N_ORDERS'>) {
  return db.transaction(
    async (tx) => {
      const orderTotals = onlyRow(
        await tx
          .select({
            paid: countWhere(isPaid),
            pending_payment: countWhere(eq(orders.status, 'pending_payment')),
            failed: countWhere(eq(orders.status, 'failed')),
            grossRevenuePaise: paidSum(orders.subtotalPaise),
            discountsPaise: paidSum(orders.discountPaise),
            netRevenuePaise: paidSum(orders.totalPaise),
          })
          .from(orders),
      );

      const quantityByProduct = await tx
        .select({ productId: orderItems.productId, name: products.name, quantity: asNumber(sql`sum(${orderItems.quantity})`) })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .innerJoin(products, eq(products.id, orderItems.productId))
        .where(isPaid)
        .groupBy(orderItems.productId, products.name)
        .orderBy(asc(orderItems.productId));

      const couponTotals = onlyRow(
        await tx
          .select({
            generated: asNumber(sql`count(*)`),
            available: countWhere(eq(coupons.status, 'available')),
            reserved: countWhere(eq(coupons.status, 'reserved')),
            redeemed: countWhere(eq(coupons.status, 'redeemed')),
            lastMilestone: asNumber(sql`coalesce(max(${coupons.milestone}), 0)`),
          })
          .from(coupons),
      );

      const { grossRevenuePaise, discountsPaise, netRevenuePaise, ...ordersByStatus } = orderTotals;
      const { lastMilestone, ...couponsByStatus } = couponTotals;
      const n = config.COUPON_EVERY_N_ORDERS;
      const reached = milestonesReached(ordersByStatus.paid, n);
      return {
        paidOrders: ordersByStatus.paid,
        ordersByStatus,
        quantityByProduct,
        grossRevenuePaise,
        discountsPaise,
        netRevenuePaise,
        coupons: couponsByStatus,
        milestones: { n, reached, rewarded: lastMilestone, unrewarded: reached - lastMilestone },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
