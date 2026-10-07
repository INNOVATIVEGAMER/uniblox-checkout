export type ChargeInput = { orderId: string; amountPaise: number; paymentToken: string };

export type ChargeResult = { outcome: 'approved'; paymentRef: string } | { outcome: 'declined'; reason: string };

// paymentRef is null for a zero total, which is never charged.
export type Resolution = { outcome: 'approved'; paymentRef: string | null } | { outcome: 'declined'; reason: string };

export interface PaymentGateway {
  /** Throwing means the outcome is unknown: the charge may or may not have landed. */
  charge(input: ChargeInput, signal: AbortSignal): Promise<ChargeResult>;
}
