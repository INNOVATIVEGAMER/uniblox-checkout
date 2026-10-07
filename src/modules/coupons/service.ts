import { eq, sql } from 'drizzle-orm';
import type { Config } from '../../config';
import { type Db, type Tx, onlyRow } from '../../db/client';
import { coupons, orders } from '../../db/schema';
import { milestoneProgress } from '../../domain/milestones';
import { AppError } from '../../errors';
import { generateCouponCode } from './code';

export type CouponConfig = Pick<Config, 'COUPON_EVERY_N_ORDERS' | 'COUPON_PERCENT_OFF'>;

export const COUPON_GENERATION_LOCK = 4_004;

const MAX_CODE_ATTEMPTS = 3;

/** The highest milestone with a coupon, 0 before the first. Coupon generation and the report both read this. */
export const lastMilestone = sql`coalesce(max(${coupons.milestone}), 0)`.mapWith(Number);

export const couponColumns = {
  id: coupons.id,
  code: coupons.code,
  milestone: coupons.milestone,
  percentOff: coupons.percentOff,
  status: coupons.status,
  createdAt: coupons.createdAt,
  redeemedAt: coupons.redeemedAt,
};

/** The availability rule shared by checkout and the cart preview, so both return the same error. */
function availableCoupon(coupon: typeof coupons.$inferSelect | undefined) {
  if (!coupon) throw new AppError('COUPON_INVALID');
  if (coupon.status === 'redeemed') throw new AppError('COUPON_ALREADY_REDEEMED');
  if (coupon.status === 'reserved') throw new AppError('COUPON_RESERVED');
  return coupon;
}

export async function findAvailableCoupon(db: Db, code: string) {
  const [coupon] = await db.select(couponColumns).from(coupons).where(eq(coupons.code, code));
  return availableCoupon(coupon);
}

export async function lockAvailableCoupon(tx: Tx, code: string) {
  const [coupon] = await tx.select(couponColumns).from(coupons).where(eq(coupons.code, code)).for('no key update');
  return availableCoupon(coupon);
}

/**
 * Generates one coupon, for the oldest unrewarded milestone. The advisory lock queues concurrent calls,
 * so each one sees the milestones its predecessors committed; UNIQUE (milestone) is the guarantee.
 */
export function generateCoupon(db: Db, config: CouponConfig, newCode = generateCouponCode) {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${COUPON_GENERATION_LOCK})`);

      const paidOrders = await tx.$count(orders, eq(orders.status, 'paid'));
      const last = onlyRow(await tx.select({ lastMilestone }).from(coupons));
      const progress = milestoneProgress({ paidOrders, n: config.COUPON_EVERY_N_ORDERS, lastMilestone: last.lastMilestone });
      if (!progress.eligible) {
        throw new AppError('NO_ELIGIBLE_MILESTONE', { paidOrders, nextMilestoneAt: progress.nextMilestoneAt });
      }

      for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
        const [coupon] = await tx
          .insert(coupons)
          .values({ code: newCode(config.COUPON_PERCENT_OFF, progress.next), milestone: progress.next, percentOff: config.COUPON_PERCENT_OFF })
          .onConflictDoNothing({ target: coupons.code })
          .returning(couponColumns);
        if (coupon) return { coupon, remainingEligible: progress.remainingEligible };
      }
      throw new Error(`coupon code collided ${MAX_CODE_ATTEMPTS} times for milestone ${progress.next}`);
    },
    { isolationLevel: 'read committed' },
  );
}
