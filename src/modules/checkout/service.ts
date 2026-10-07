import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '../../db/client';
import { cartItems, carts, coupons, idempotencyKeys, orderItems, orders, products } from '../../db/schema';
import { priceLines } from '../../domain/money';
import { AppError } from '../../errors';
import { lockOpenCart } from '../carts/service';
import { lockAvailableCoupon } from '../coupons/service';
import { type CheckoutResponse, loadOrderView, toCheckoutResponse } from '../orders/view';
import { finalizeOrder } from '../payments/finalize';
import { type Resolution, zeroTotalResolution } from '../payments/gateway';
import type { PendingOrder, RecoveryDeps } from '../payments/recovery';
import { lockProducts } from '../products/lock';
import { type Claim, claimKey, completeKeyWithError, requestHash } from './idempotency';
import type { CheckoutInput } from './input';

type ReserveOutcome = Exclude<Claim, { kind: 'claimed' }> | { kind: 'reserved'; order: PendingOrder };

/**
 * Phase 1. Every check runs before the first write, inside a savepoint. A final error rolls back to the
 * savepoint, is stored on the key and committed, and only then thrown. Any other error rolls back the
 * whole transaction, key claim included, so the same key can be retried.
 */
export async function reservePhase(db: Db, input: CheckoutInput, key: string, hash: string): Promise<ReserveOutcome> {
  const outcome = await db.transaction(
    async (tx) => {
      const claim = await claimKey(tx, key, hash);
      if (claim.kind !== 'claimed') return claim;
      try {
        const order = await tx.transaction((sp) => reserve(sp, input, key));
        return { kind: 'reserved' as const, order };
      } catch (err) {
        if (!(err instanceof AppError) || !err.final) throw err;
        await completeKeyWithError(tx, key, err);
        return { kind: 'rejected' as const, error: err };
      }
    },
    { isolationLevel: 'read committed' },
  );
  if (outcome.kind === 'rejected') throw outcome.error;
  return outcome;
}

async function reserve(sp: Tx, { cartId, couponCode, expectedTotalPaise }: CheckoutInput, key: string): Promise<PendingOrder> {
  await lockOpenCart(sp, cartId);

  const lines = await sp
    .select({ productId: cartItems.productId, quantity: cartItems.quantity })
    .from(cartItems)
    .where(eq(cartItems.cartId, cartId))
    .orderBy(asc(cartItems.productId));
  if (lines.length === 0) throw new AppError('CART_EMPTY');

  const locked = new Map((await lockProducts(sp, lines.map((line) => line.productId))).map((p) => [p.id, p]));
  const items = lines.map(({ productId, quantity }) => {
    const product = locked.get(productId);
    if (!product) throw new Error(`cart line ${productId} has no product row`);
    return { productId, name: product.name, unitPricePaise: product.pricePaise, quantity, stock: product.stock };
  });

  const short = items
    .filter((item) => item.stock < item.quantity)
    .map((item) => ({ productId: item.productId, requested: item.quantity, available: item.stock }));
  if (short.length > 0) throw new AppError('INSUFFICIENT_STOCK', short);

  const coupon = couponCode === undefined ? null : await lockAvailableCoupon(sp, couponCode);
  const priced = priceLines(items, coupon?.percentOff ?? null);
  if (expectedTotalPaise !== priced.totalPaise) {
    const { subtotalPaise, discountPaise, totalPaise } = priced;
    throw new AppError('PRICE_CHANGED', { subtotalPaise, discountPaise, totalPaise });
  }

  await sp
    .update(products)
    .set({ stock: sql`${products.stock} - ${cartItems.quantity}` })
    .from(cartItems)
    .where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, products.id)));
  const [order] = await sp
    .insert(orders)
    .values({
      cartId,
      subtotalPaise: priced.subtotalPaise,
      discountPaise: priced.discountPaise,
      totalPaise: priced.totalPaise,
      couponId: coupon?.id ?? null,
      percentOff: coupon?.percentOff ?? null,
    })
    .returning({ id: orders.id, totalPaise: orders.totalPaise });
  if (!order) throw new Error('INSERT … RETURNING produced no row');
  await sp.insert(orderItems).values(
    priced.lines.map((line) => ({
      orderId: order.id,
      productId: line.productId,
      productName: line.name,
      unitPricePaise: line.unitPricePaise,
      quantity: line.quantity,
      lineTotalPaise: line.lineTotalPaise,
    })),
  );
  if (coupon) await sp.update(coupons).set({ status: 'reserved' }).where(eq(coupons.id, coupon.id));
  await sp.update(carts).set({ status: 'pending_payment' }).where(eq(carts.id, cartId));
  await sp.update(idempotencyKeys).set({ orderId: order.id }).where(eq(idempotencyKeys.key, key));
  return order;
}

/** Phase 2. Returns null when the outcome is unknown: the charge may still land, so the reservation is held. */
async function charge(
  { gateway, config }: RecoveryDeps,
  order: PendingOrder,
  paymentToken: string,
): Promise<Resolution | null> {
  if (order.totalPaise === 0) return zeroTotalResolution;
  try {
    return await gateway.charge(
      { orderId: order.id, amountPaise: order.totalPaise, paymentToken },
      AbortSignal.timeout(config.GATEWAY_TIMEOUT_MS),
    );
  } catch (err) {
    console.warn('payment outcome unknown, order stays pending', { orderId: order.id, err });
    return null;
  }
}

function replayed(response: CheckoutResponse): CheckoutResponse {
  return { ...response, headers: { ...response.headers, 'Idempotent-Replayed': 'true' } };
}

export async function checkout(deps: RecoveryDeps, input: CheckoutInput, key: string): Promise<CheckoutResponse> {
  const reserved = await reservePhase(deps.db, input, key, requestHash(input));
  if (reserved.kind === 'stored') return replayed({ status: reserved.status, body: reserved.body, headers: {} });
  if (reserved.kind === 'order') return replayed(toCheckoutResponse(await loadOrderView(deps.db, reserved.orderId)));

  const resolution = await charge(deps, reserved.order, input.paymentToken);
  if (resolution) await finalizeOrder(deps.db, reserved.order.id, resolution);
  return toCheckoutResponse(await loadOrderView(deps.db, reserved.order.id));
}
