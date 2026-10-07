import { and, asc, eq, ne } from 'drizzle-orm';
import type { Db, Tx } from '../../db/client';
import { cartItems, carts, orders, products } from '../../db/schema';
import { MAX_CART_LINES, priceLines } from '../../domain/money';
import { AppError } from '../../errors';

type Cart = Pick<typeof carts.$inferSelect, 'id' | 'status'> & { orderId: string | null };

const cartColumns = { id: carts.id, status: carts.status };

const liveOrderOf = (cartId: typeof carts.id | string) => and(eq(orders.cartId, cartId), ne(orders.status, 'failed'));

async function toCartView(db: Db | Tx, cart: Cart) {
  const rows = await db
    .select({
      productId: cartItems.productId,
      name: products.name,
      unitPricePaise: products.pricePaise,
      quantity: cartItems.quantity,
      stock: products.stock,
    })
    .from(cartItems)
    .innerJoin(products, eq(products.id, cartItems.productId))
    .where(eq(cartItems.cartId, cart.id))
    .orderBy(asc(cartItems.productId));

  const priced = priceLines(
    rows.map(({ stock, ...line }) => ({ ...line, available: stock >= line.quantity })),
    null,
  );
  return { id: cart.id, status: cart.status, orderId: cart.orderId, ...priced };
}

export async function createCart(db: Db) {
  const [cart] = await db.insert(carts).values({}).returning(cartColumns);
  if (!cart) throw new Error('INSERT … RETURNING produced no row');
  return toCartView(db, { ...cart, orderId: null });
}

export async function loadCartView(db: Db, cartId: string) {
  const [cart] = await db
    .select({ ...cartColumns, orderId: orders.id })
    .from(carts)
    .leftJoin(orders, liveOrderOf(carts.id))
    .where(eq(carts.id, cartId));
  if (!cart) throw new AppError('CART_NOT_FOUND');
  return toCartView(db, cart);
}

/**
 * Locks the cart and requires it to be open. The live order is read in a second statement: after a lock
 * wait, a joined row would come from the snapshot taken before the wait, and miss an order that the
 * previous lock holder just created.
 */
export async function lockOpenCart(tx: Tx, cartId: string): Promise<Cart> {
  const [cart] = await tx.select(cartColumns).from(carts).where(eq(carts.id, cartId)).for('no key update');
  if (!cart) throw new AppError('CART_NOT_FOUND');
  // Every order on an open cart has failed.
  if (cart.status === 'open') return { ...cart, orderId: null };

  const [order] = await tx.select({ id: orders.id }).from(orders).where(liveOrderOf(cartId));
  if (!order) throw new Error(`cart ${cartId} is ${cart.status} with no live order`);
  throw new AppError(cart.status === 'checked_out' ? 'CART_CHECKED_OUT' : 'CART_PAYMENT_PENDING', { orderId: order.id });
}

export function setItemQuantity(db: Db, cartId: string, productId: string, quantity: number) {
  return db.transaction(
    async (tx) => {
      const cart = await lockOpenCart(tx, cartId);

      const [product] = await tx.select({ stock: products.stock }).from(products).where(eq(products.id, productId));
      if (!product) throw new AppError('PRODUCT_NOT_FOUND');
      if (product.stock < quantity) {
        throw new AppError('INSUFFICIENT_STOCK', [{ productId, requested: quantity, available: product.stock }]);
      }

      const updated = await tx
        .update(cartItems)
        .set({ quantity })
        .where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId)))
        .returning({ productId: cartItems.productId });
      if (updated.length > 0) return { created: false, view: await toCartView(tx, cart) };

      const lineCount = await tx.$count(cartItems, eq(cartItems.cartId, cartId));
      if (lineCount >= MAX_CART_LINES) throw new AppError('CART_LINE_LIMIT', { maxLines: MAX_CART_LINES });

      await tx.insert(cartItems).values({ cartId, productId, quantity });
      return { created: true, view: await toCartView(tx, cart) };
    },
    { isolationLevel: 'read committed' },
  );
}

export function removeItem(db: Db, cartId: string, productId: string) {
  return db.transaction(
    async (tx) => {
      const cart = await lockOpenCart(tx, cartId);
      await tx.delete(cartItems).where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId)));
      return toCartView(tx, cart);
    },
    { isolationLevel: 'read committed' },
  );
}
