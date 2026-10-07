'use client';

import { skipToken, useQuery } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { setCartId, useCartId } from '@/lib/cart-id';
import { CartPanel } from '@/components/shop/cart-panel';
import { ProductList } from '@/components/shop/product-list';

export default function ShopPage() {
  const id = useCartId();
  const cart = useQuery({
    queryKey: ['cart', id],
    queryFn:
      id === null
        ? skipToken
        : async () => {
            try {
              return await api.getCart(id);
            } catch (err) {
              if (err instanceof ApiError && err.code === 'CART_NOT_FOUND') setCartId(null);
              throw err;
            }
          },
  });

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <ProductList cart={cart.data ?? null} cartId={id} onCartCreated={setCartId} />
      <CartPanel cartId={id} cart={cart} onNewCart={() => setCartId(null)} />
    </div>
  );
}
