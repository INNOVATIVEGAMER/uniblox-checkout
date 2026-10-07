import { asc } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../../db/client';
import { coupons } from '../../db/schema';
import { type CouponConfig, couponColumns, generateCoupon } from './service';

export function couponsRoutes({ db, config }: { db: Db; config: CouponConfig }) {
  return new Hono()
    .post('/admin/coupons', async (c) => c.json(await generateCoupon(db, config), 201))
    .get('/admin/coupons', async (c) => {
      return c.json(await db.select(couponColumns).from(coupons).orderBy(asc(coupons.milestone)));
    });
}
