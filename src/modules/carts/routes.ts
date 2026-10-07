import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { MAX_LINE_QUANTITY } from '../../domain/money';
import { validate } from '../../errors';
import { productIdSchema } from '../products/id';
import { cartParamsSchema } from './id';
import { createCart, loadCartView, removeItem, setItemQuantity } from './service';

const cartItemParamsSchema = cartParamsSchema.extend({ productId: productIdSchema });

const setQuantitySchema = z.strictObject({ quantity: z.int().min(1).max(MAX_LINE_QUANTITY) });

export function cartsRoutes({ db }: { db: Db }) {
  return new Hono()
    .post('/carts', async (c) => c.json(await createCart(db), 201))
    .get('/carts/:id', validate('param', cartParamsSchema), async (c) => {
      return c.json(await loadCartView(db, c.req.valid('param').id));
    })
    .put(
      '/carts/:id/items/:productId',
      validate('param', cartItemParamsSchema),
      validate('json', setQuantitySchema),
      async (c) => {
        const { id, productId } = c.req.valid('param');
        const { created, view } = await setItemQuantity(db, id, productId, c.req.valid('json').quantity);
        return c.json(view, created ? 201 : 200);
      },
    )
    .delete('/carts/:id/items/:productId', validate('param', cartItemParamsSchema), async (c) => {
      const { id, productId } = c.req.valid('param');
      return c.json(await removeItem(db, id, productId));
    });
}
