import { Hono } from 'hono';
import type { Db } from '../../db/client';
import { type ReportConfig, loadReport } from './service';

export function reportRoutes({ db, config }: { db: Db; config: ReportConfig }) {
  return new Hono().get('/admin/report', async (c) => c.json(await loadReport(db, config)));
}
