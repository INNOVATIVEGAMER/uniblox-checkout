'use client';

import { skipToken, useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { ApiError, api } from '@/lib/api';
import { CartPanel } from '@/components/shop/cart-panel';
import { ProductList } from '@/components/shop/product-list';

const CART_ID_KEY = 'uniblox-cart-id';

// The id lives in memory first, so the shop still works when localStorage is blocked.
let cartId: string | null | undefined;
const listeners = new Set<() => void>();

function readCartId(): string | null {
  if (cartId !== undefined) return cartId;
  try {
    cartId = z.uuid().safeParse(localStorage.getItem(CART_ID_KEY)).data ?? null;
  } catch {
    cartId = null;
  }
  return cartId;
}

function setCartId(id: string | null) {
  cartId = id;
  try {
    if (id === null) localStorage.removeItem(CART_ID_KEY);
    else localStorage.setItem(CART_ID_KEY, id);
  } catch {
    // Not persisted: the cart lasts until the page reloads.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export default function ShopPage() {
  const id = useSyncExternalStore(subscribe, readCartId, () => null);
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
