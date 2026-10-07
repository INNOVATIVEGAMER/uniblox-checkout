import { asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { products } from '../../db/schema';
import { MAX_UNIT_PRICE_PAISE } from '../../domain/money';
import { AppError, validate } from '../../errors';

const productIdSchema = z.string().regex(/^p_[a-z0-9_]{1,60}$/, 'Invalid product id');

const productParamsSchema = z.object({ id: productIdSchema });

const patchProductSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    pricePaise: z.int().min(0).max(MAX_UNIT_PRICE_PAISE),
    stock: z.int32().min(0),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'At least one of name, pricePaise or stock is required');

const productColumns = {
  id: products.id,
  name: products.name,
  pricePaise: products.pricePaise,
  stock: products.stock,
};

export function productsRoutes({ db }: { db: Db }) {
  return new Hono()
    .get('/products', async (c) => {
      const rows = await db.select(productColumns).from(products).orderBy(asc(products.id));
      return c.json(rows);
    })
    .patch(
      '/admin/products/:id',
      validate('param', productParamsSchema),
      validate('json', patchProductSchema),
      async (c) => {
        const { id } = c.req.valid('param');
        const [product] = await db
          .update(products)
          .set({ ...c.req.valid('json'), updatedAt: sql`now()` })
          .where(eq(products.id, id))
          .returning(productColumns);
        if (!product) throw new AppError('PRODUCT_NOT_FOUND');
        return c.json(product);
      },
    );
}
