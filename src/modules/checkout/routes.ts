import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { AppError, validate } from '../../errors';
import { cartParamsSchema } from '../carts/id';
import { type CheckoutDeps, checkout } from './service';

const idempotencyHeaderSchema = z.object({ 'Idempotency-Key': z.string().min(1).max(255) });

const checkoutBodySchema = z.strictObject({
  expectedTotalPaise: z.int().min(0),
  paymentToken: z.string().min(1).max(255),
});

const requireIdempotencyKey = zValidator('header', idempotencyHeaderSchema, (result) => {
  if (!result.success) throw new AppError('IDEMPOTENCY_KEY_INVALID');
});

export function checkoutRoutes(deps: CheckoutDeps) {
  return new Hono().post(
    '/carts/:id/checkout',
    validate('param', cartParamsSchema),
    requireIdempotencyKey,
    validate('json', checkoutBodySchema),
    async (c) => {
      const input = { cartId: c.req.valid('param').id, ...c.req.valid('json') };
      const { status, body, headers } = await checkout(deps, input, c.req.valid('header')['Idempotency-Key']);
      return Response.json(body, { status, headers });
    },
  );
}
