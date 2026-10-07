import { randomUUID } from 'node:crypto';
import type { ChargeInput, ChargeResult, PaymentGateway } from './gateway';

const DECLINE_REASONS = new Map([
  ['pm_card_chargeDeclined', 'card_declined'],
  ['pm_card_chargeDeclinedInsufficientFunds', 'insufficient_funds'],
]);

function outcomeFor(paymentToken: string): ChargeResult {
  if (paymentToken === 'pm_card_visa') return { outcome: 'approved', paymentRef: `ch_${randomUUID()}` };
  return { outcome: 'declined', reason: DECLINE_REASONS.get(paymentToken) ?? 'invalid_payment_method' };
}

/** An in-memory gateway shaped like Stripe's test mode. Charges are idempotent per orderId. */
export class FakeGateway implements PaymentGateway {
  readonly charges = new Map<string, ChargeResult>();

  charge({ orderId, paymentToken }: ChargeInput): Promise<ChargeResult> {
    const recorded = this.charges.get(orderId);
    if (recorded) return Promise.resolve(recorded);
    const result = outcomeFor(paymentToken);
    this.charges.set(orderId, result);
    return Promise.resolve(result);
  }
}
