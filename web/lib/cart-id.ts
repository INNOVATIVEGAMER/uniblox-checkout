import { useSyncExternalStore } from 'react';
import { z } from 'zod';

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

export function setCartId(id: string | null) {
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

export function useCartId(): string | null {
  return useSyncExternalStore(subscribe, readCartId, () => null);
}
