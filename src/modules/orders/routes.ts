import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { ORDER_STATUSES, orders } from '../../db/schema';
import { validate } from '../../errors';
import { loadOrderView, selectOrderViews } from './view';

const orderParamsSchema = z.object({ id: z.uuid() });

const ordersQuerySchema = z.object({ status: z.enum(ORDER_STATUSES).optional() });

export function ordersRoutes({ db }: { db: Db }) {
  return new Hono()
    .get('/orders/:id', validate('param', orderParamsSchema), async (c) => {
      return c.json(await loadOrderView(db, c.req.valid('param').id));
    })
    .get('/admin/orders', validate('query', ordersQuerySchema), async (c) => {
      const { status } = c.req.valid('query');
      return c.json(await selectOrderViews(db, status && eq(orders.status, status)));
    });
}
