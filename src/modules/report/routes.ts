import { Hono } from 'hono';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { loadReport } from './service';

export function reportRoutes({ db, config }: { db: Db; config: Pick<Config, 'COUPON_EVERY_N_ORDERS'> }) {
  return new Hono().get('/admin/report', async (c) => c.json(await loadReport(db, config)));
}
