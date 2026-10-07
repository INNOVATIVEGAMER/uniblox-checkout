import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { validate } from '../../errors';
import { loadOrderView } from './view';

const orderParamsSchema = z.object({ id: z.uuid() });

export function ordersRoutes({ db }: { db: Db }) {
  return new Hono().get('/orders/:id', validate('param', orderParamsSchema), async (c) => {
    return c.json(await loadOrderView(db, c.req.valid('param').id));
  });
}
