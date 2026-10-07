import { randomUUID } from 'node:crypto';
import type { CancelResult, ChargeInput, ChargeResult, PaymentGateway, RetrieveResult } from './gateway';

const DECLINE_REASONS = new Map([
  ['pm_card_chargeDeclined', 'card_declined'],
  ['pm_card_chargeDeclinedInsufficientFunds', 'insufficient_funds'],
  ['tok_timeout_declined', 'card_declined'],
]);

const APPROVING_TOKENS = new Set(['pm_card_visa', 'tok_timeout_approved']);

const TIMEOUT_TOKENS = new Set(['tok_timeout_approved', 'tok_timeout_declined']);

const CANCELLED: ChargeResult = { outcome: 'declined', reason: 'cancelled' };

function outcomeFor(paymentToken: string): ChargeResult {
  if (APPROVING_TOKENS.has(paymentToken)) return { outcome: 'approved', paymentRef: `ch_${randomUUID()}` };
  return { outcome: 'declined', reason: DECLINE_REASONS.get(paymentToken) ?? 'invalid_payment_method' };
}

/**
 * An in-memory gateway shaped like Stripe's test mode. Charges are idempotent per orderId. A cancel
 * records a declined tombstone, so a charge arriving after it is declined. Every method is a
 * synchronous check-and-set on the map, so a charge and a cancel can't interleave.
 */
export class FakeGateway implements PaymentGateway {
  readonly charges = new Map<string, ChargeResult>();

  charge({ orderId, paymentToken }: ChargeInput): Promise<ChargeResult> {
    const recorded = this.charges.get(orderId);
    if (recorded) return Promise.resolve(recorded);
    const result = outcomeFor(paymentToken);
    this.charges.set(orderId, result);
    if (TIMEOUT_TOKENS.has(paymentToken)) return Promise.reject(new Error('gateway timed out after recording the charge'));
    return Promise.resolve(result);
  }

  retrieve(orderId: string): Promise<RetrieveResult> {
    return Promise.resolve(this.charges.get(orderId) ?? { outcome: 'not_found' });
  }

  cancel(orderId: string): Promise<CancelResult> {
    const recorded = this.charges.get(orderId);
    if (recorded) return Promise.resolve(recorded);
    this.charges.set(orderId, CANCELLED);
    return Promise.resolve({ outcome: 'cancelled' });
  }
}
