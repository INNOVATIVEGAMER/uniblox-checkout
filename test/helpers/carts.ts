import { expect } from 'vitest';
import { z } from 'zod';
import type { Db } from '../../src/db/client';
import { CART_STATUSES, cartItems, products } from '../../src/db/schema';
import { MAX_CART_LINES } from '../../src/domain/money';
import { type TestApp, sendJson } from './app';

export const cartViewSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(CART_STATUSES),
  orderId: z.uuid().nullable(),
  lines: z.array(
    z.strictObject({
      productId: z.string(),
      name: z.string(),
      unitPricePaise: z.int(),
      quantity: z.int(),
      lineTotalPaise: z.int(),
      available: z.boolean(),
    }),
  ),
  subtotalPaise: z.int(),
  discountPaise: z.int(),
  totalPaise: z.int(),
});

export function cartRequests(app: TestApp) {
  async function newCart(): Promise<string> {
    const res = await app.request('/carts', { method: 'POST' });
    expect(res.status).toBe(201);
    return cartViewSchema.parse(await res.json()).id;
  }
  const putItem = async (cartId: string, productId: string, quantity: number) =>
    sendJson(app, 'PUT', `/carts/${cartId}/items/${productId}`, { quantity });
  const deleteItem = async (cartId: string, productId: string) =>
    app.request(`/carts/${cartId}/items/${productId}`, { method: 'DELETE' });

  return {
    newCart,
    putItem,
    deleteItem,
    async getCart(cartId: string) {
      const res = await app.request(`/carts/${cartId}`);
      expect(res.status).toBe(200);
      return cartViewSchema.parse(await res.json());
    },
    /** A new cart holding `lines`, as { productId: quantity }. */
    async cartWith(lines: Record<string, number>): Promise<string> {
      const cartId = await newCart();
      for (const [productId, quantity] of Object.entries(lines)) {
        expect((await putItem(cartId, productId, quantity)).status).toBe(201);
      }
      return cartId;
    },
  };
}

export const bulkId = (i: number) => `p_bulk_${String(i).padStart(2, '0')}`;

/** Inserts MAX_CART_LINES + 1 bulk products, and the first `lineCount` of them as lines of the cart. */
export async function fillCart(db: Db, cartId: string, lineCount: number): Promise<void> {
  await db.insert(products).values(
    Array.from({ length: MAX_CART_LINES + 1 }, (_, i) => ({
      id: bulkId(i + 1),
      name: `Bulk ${i + 1}`,
      pricePaise: 100,
      stock: 10,
    })),
  );
  await db
    .insert(cartItems)
    .values(Array.from({ length: lineCount }, (_, i) => ({ cartId, productId: bulkId(i + 1), quantity: 1 })));
}
