import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { idempotencyKeys } from '../../db/schema';
import { AppError, toErrorBody } from '../../errors';

export type CheckoutInput = { cartId: string; expectedTotalPaise: number; paymentToken: string };

/** Hashes the parsed and normalised request, so a key reused with any other cart, total or token is a mismatch. */
export function requestHash({ cartId, expectedTotalPaise, paymentToken }: CheckoutInput): string {
  return createHash('sha256').update(JSON.stringify([cartId, expectedTotalPaise, paymentToken])).digest('hex');
}

export type Claim =
  | { kind: 'claimed' }
  | { kind: 'order'; orderId: string }
  | { kind: 'stored'; status: number; body: unknown };

/**
 * Claims the key as the transaction's first statement. A request racing on the same key waits on the
 * uncommitted insert while holding no other lock, then sees the committed row in the separate load.
 */
export async function claimKey(tx: Tx, key: string, hash: string): Promise<Claim> {
  const claimed = await tx
    .insert(idempotencyKeys)
    .values({ key, requestHash: hash })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (claimed.length > 0) return { kind: 'claimed' };

  const [row] = await tx
    .select({
      requestHash: idempotencyKeys.requestHash,
      orderId: idempotencyKeys.orderId,
      responseStatus: idempotencyKeys.responseStatus,
      responseBody: idempotencyKeys.responseBody,
    })
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key));
  if (!row) throw new Error(`idempotency key ${key} conflicted but has no row`);
  if (row.requestHash !== hash) throw new AppError('IDEMPOTENCY_KEY_REUSED');
  if (row.orderId) return { kind: 'order', orderId: row.orderId };
  if (row.responseStatus === null) throw new Error(`idempotency key ${key} has neither an order nor a response`);
  return { kind: 'stored', status: row.responseStatus, body: row.responseBody };
}

export async function completeKeyWithError(tx: Tx, key: string, err: AppError): Promise<void> {
  await tx
    .update(idempotencyKeys)
    .set({ responseStatus: err.status, responseBody: toErrorBody(err) })
    .where(eq(idempotencyKeys.key, key));
}
