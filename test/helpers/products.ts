import { SEED_PRODUCTS } from '../../src/db/seed';

export function priceOf(productId: string): number {
  const product = SEED_PRODUCTS.find((p) => p.id === productId);
  if (!product) throw new Error(`${productId} is not a seed product`);
  return product.pricePaise;
}
