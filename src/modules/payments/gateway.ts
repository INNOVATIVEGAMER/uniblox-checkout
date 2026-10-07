export type ChargeInput = { orderId: string; amountPaise: number; paymentToken: string };

export type ChargeResult = { outcome: 'approved'; paymentRef: string } | { outcome: 'declined'; reason: string };

export type RetrieveResult = ChargeResult | { outcome: 'not_found' };

export type CancelResult = ChargeResult | { outcome: 'cancelled' };

// paymentRef is null for a zero total, which is never charged.
export type Resolution = { outcome: 'approved'; paymentRef: string | null } | { outcome: 'declined'; reason: string };

export const zeroTotalResolution: Resolution = { outcome: 'approved', paymentRef: null };

export interface PaymentGateway {
  /** Throwing means the outcome is unknown: the charge may or may not have landed. */
  charge(input: ChargeInput, signal: AbortSignal): Promise<ChargeResult>;
  retrieve(orderId: string): Promise<RetrieveResult>;
  /** Returns the charge if one landed. Otherwise no charge for this order can land from now on. */
  cancel(orderId: string): Promise<CancelResult>;
}
