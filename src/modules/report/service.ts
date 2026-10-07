import { type SQL, asc, eq, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Config } from '../../config';
import { type Db, onlyRow } from '../../db/client';
import { type COUPON_STATUSES, type ORDER_STATUSES, coupons, orderItems, orders, products } from '../../db/schema';
import { milestoneProgress } from '../../domain/milestones';
import { lastMilestone } from '../coupons/service';

export type ReportConfig = Pick<Config, 'COUPON_EVERY_N_ORDERS'>;

// node-postgres returns bigint and numeric as strings, so every count and sum is cast to bigint and read as a number.
const asNumber = (aggregate: SQL) => sql`${aggregate}::bigint`.mapWith(Number);

const isPaid = eq(orders.status, 'paid');
const countWhere = (where: SQL) => asNumber(sql`count(*) FILTER (WHERE ${where})`);
const paidSum = (column: AnyPgColumn) => asNumber(sql`coalesce(sum(${column}) FILTER (WHERE ${isPaid}), 0)`);

/** Every figure is read from one snapshot, so a checkout committing mid-report is either in all of them or in none. */
export function loadReport(db: Db, config: ReportConfig) {
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
            lastMilestone,
          })
          .from(coupons),
      );

      const { grossRevenuePaise, discountsPaise, netRevenuePaise, ...ordersByStatus } = orderTotals;
      const { lastMilestone: rewarded, ...couponsByStatus } = couponTotals;
      const n = config.COUPON_EVERY_N_ORDERS;
      const { reached, unrewarded } = milestoneProgress({ paidOrders: ordersByStatus.paid, n, lastMilestone: rewarded });
      return {
        paidOrders: ordersByStatus.paid,
        ordersByStatus: ordersByStatus satisfies Record<(typeof ORDER_STATUSES)[number], number>,
        quantityByProduct,
        grossRevenuePaise,
        discountsPaise,
        netRevenuePaise,
        coupons: couponsByStatus satisfies Record<(typeof COUPON_STATUSES)[number], number>,
        milestones: { n, reached, rewarded, unrewarded },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
