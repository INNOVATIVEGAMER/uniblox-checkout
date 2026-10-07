import type { PaymentGateway } from '../../src/modules/payments/gateway';
import { within } from './within';

export type Gate = {
  gateway: PaymentGateway;
  /** Resolves when the first charge reaches the gate, or fails with WaitTimeout. */
  entered: () => Promise<void>;
  release: () => void;
  readonly calls: number;
};

function untilReleased(released: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    void released.then(resolve);
  });
}

/**
 * Holds every charge until release(): `before` holds it before the inner gateway records the charge,
 * `after` holds it once the charge is recorded. A held charge still aborts on its signal. retrieve()
 * and cancel() pass straight through, so recovery can run while a charge is held.
 */
export function gated(inner: PaymentGateway, { at }: { at: 'before' | 'after' }): Gate {
  let markEntered = () => {};
  const entered = new Promise<void>((resolve) => (markEntered = resolve));
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;

  const gateway: PaymentGateway = {
    async charge(input, signal) {
      calls++;
      markEntered();
      if (at === 'before') {
        await untilReleased(released, signal);
        return inner.charge(input, signal);
      }
      const result = await inner.charge(input, signal);
      await untilReleased(released, signal);
      return result;
    },
    retrieve: (orderId, signal) => inner.retrieve(orderId, signal),
    cancel: (orderId, signal) => inner.cancel(orderId, signal),
  };

  return {
    gateway,
    entered: () => within(entered, 'no charge reached the gate'),
    release: () => release(),
    get calls() {
      return calls;
    },
  };
}
