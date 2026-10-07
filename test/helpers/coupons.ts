import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { z } from 'zod';
import type { Db } from '../../src/db/client';
import { COUPON_STATUSES, coupons } from '../../src/db/schema';
import type { TestApp } from './app';
import { cartRequests } from './carts';
import { expectOrder, newKey, postCheckout, visa } from './checkout';

export const couponSchema = z.strictObject({
  id: z.uuid(),
  code: z.string(),
  milestone: z.int(),
  percentOff: z.int(),
  status: z.enum(COUPON_STATUSES),
  createdAt: z.iso.datetime(),
  redeemedAt: z.iso.datetime().nullable(),
});

export const generatedSchema = z.strictObject({ coupon: couponSchema, remainingEligible: z.int() });

export const generateCoupon = async (app: TestApp) => app.request('/admin/coupons', { method: 'POST' });

const MOUSE_PAISE = 129_950;

/** Places `count` paid orders of one mouse each, each on its own cart. */
export async function payOrders(app: TestApp, count: number): Promise<void> {
  const { cartWith } = cartRequests(app);
  for (let i = 0; i < count; i++) {
    const cartId = await cartWith({ p_mouse: 1 });
    await expectOrder(await postCheckout(app, cartId, newKey(), visa(MOUSE_PAISE)), 201);
  }
}

let nextMilestone = 1;

/** Inserts a coupon directly, skipping the milestone rule, for tests about redemption. */
export async function insertCoupon(db: Db, { percentOff = 10, code }: { percentOff?: number; code?: string } = {}) {
  const milestone = nextMilestone++;
  const [coupon] = await db
    .insert(coupons)
    .values({ code: code ?? `SAVE${percentOff}-M${milestone}-TEST0000`, milestone, percentOff })
    .returning({ id: coupons.id, code: coupons.code, percentOff: coupons.percentOff });
  if (!coupon) throw new Error('INSERT … RETURNING produced no row');
  return coupon;
}

export async function couponRow(db: Db, code: string) {
  const [row] = await db.select({ status: coupons.status, redeemedAt: coupons.redeemedAt }).from(coupons).where(eq(coupons.code, code));
  expect(row).toBeDefined();
  return row;
}
