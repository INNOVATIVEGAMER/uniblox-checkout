import { Hono } from 'hono';
import { z } from 'zod';
import { MAX_LINE_QUANTITY } from '../../domain/money';
import { validate } from '../../errors';
import { couponCodeSchema } from '../coupons/code';
import { type RecoveryDeps, recoverStale } from '../payments/recovery';
import { productIdSchema } from '../products/id';
import { cartParamsSchema } from './id';
import { createCart, loadCartView, removeItem, setItemQuantity } from './service';

const cartItemParamsSchema = cartParamsSchema.extend({ productId: productIdSchema });

const cartQuerySchema = z.object({ couponCode: couponCodeSchema.optional() });

const setQuantitySchema = z.strictObject({ quantity: z.int().min(1).max(MAX_LINE_QUANTITY) });

export function cartsRoutes(deps: RecoveryDeps) {
  const { db } = deps;
  return new Hono()
    .post('/carts', async (c) => c.json(await createCart(db), 201))
    .get('/carts/:id', validate('param', cartParamsSchema), validate('query', cartQuerySchema), async (c) => {
      return c.json(await loadCartView(db, c.req.valid('param').id, c.req.valid('query').couponCode));
    })
    .put(
      '/carts/:id/items/:productId',
      validate('param', cartItemParamsSchema),
      validate('json', setQuantitySchema),
      async (c) => {
        const { id, productId } = c.req.valid('param');
        await recoverStale(deps, { scope: 'request', cartId: id, productIds: [productId] });
        const { created, view } = await setItemQuantity(db, id, productId, c.req.valid('json').quantity);
        return c.json(view, created ? 201 : 200);
      },
    )
    .delete('/carts/:id/items/:productId', validate('param', cartItemParamsSchema), async (c) => {
      const { id, productId } = c.req.valid('param');
      await recoverStale(deps, { scope: 'request', cartId: id, productIds: [] });
      return c.json(await removeItem(db, id, productId));
    });
}
