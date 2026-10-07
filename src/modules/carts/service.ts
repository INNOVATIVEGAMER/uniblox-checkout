import { and, asc, count, eq } from 'drizzle-orm';
import type { Db, Tx } from '../../db/client';
import { cartItems, carts, products } from '../../db/schema';
import { MAX_CART_LINES, lineTotal, total } from '../../domain/money';
import { AppError } from '../../errors';

type Cart = Pick<typeof carts.$inferSelect, 'id' | 'status'>;

const cartColumns = { id: carts.id, status: carts.status };

export async function toCartView(db: Db | Tx, cart: Cart) {
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

  const lines = rows.map(({ stock, ...line }) => ({
    ...line,
    lineTotalPaise: lineTotal(line.unitPricePaise, line.quantity),
    available: stock >= line.quantity,
  }));
  const subtotalPaise = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);
  return { id: cart.id, status: cart.status, lines, subtotalPaise, discountPaise: 0, totalPaise: total(subtotalPaise, 0) };
}

export async function createCart(db: Db) {
  const [cart] = await db.insert(carts).values({}).returning(cartColumns);
  if (!cart) throw new Error('INSERT … RETURNING produced no row');
  return toCartView(db, cart);
}

export async function loadCartView(db: Db, cartId: string) {
  const [cart] = await db.select(cartColumns).from(carts).where(eq(carts.id, cartId));
  if (!cart) throw new AppError('CART_NOT_FOUND');
  return toCartView(db, cart);
}

async function lockOpenCart(tx: Tx, cartId: string): Promise<Cart> {
  const [cart] = await tx.select(cartColumns).from(carts).where(eq(carts.id, cartId)).for('no key update');
  if (!cart) throw new AppError('CART_NOT_FOUND');
  if (cart.status === 'checked_out') throw new AppError('CART_CHECKED_OUT');
  if (cart.status === 'pending_payment') throw new AppError('CART_PAYMENT_PENDING');
  return cart;
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

      const line = and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId));
      const [existing] = await tx.select({ quantity: cartItems.quantity }).from(cartItems).where(line);
      if (existing) {
        await tx.update(cartItems).set({ quantity }).where(line);
        return { created: false, view: await toCartView(tx, cart) };
      }

      const [lines] = await tx.select({ n: count() }).from(cartItems).where(eq(cartItems.cartId, cartId));
      if (lines && lines.n >= MAX_CART_LINES) throw new AppError('CART_LINE_LIMIT', { maxLines: MAX_CART_LINES });

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
