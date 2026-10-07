'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import {
  ApiError,
  type ApiResponse,
  type Cart,
  type CheckoutBody,
  type Order,
  PAYMENT_TOKENS,
  type PaymentToken,
  api,
  formatPaise,
} from '@/lib/api';
import { ErrorNotice } from '@/components/error-notice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type Quote = Omit<CheckoutBody, 'paymentToken'>;

type Attempt = { cartId: string; key: string; body: CheckoutBody };

/**
 * One attempt is one Idempotency-Key and the exact body it was first sent with. Retry resends both; Change body
 * resends the key with a different total, which the API rejects once the key has a stored outcome.
 */
export function CheckoutPanel({ cart, quote }: { cart: Cart; quote: Quote | null }) {
  const [paymentToken, setPaymentToken] = useState<PaymentToken>('pm_card_visa');
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const send = useMutation({
    mutationFn: (requests: Attempt[]) =>
      Promise.allSettled(requests.map(({ cartId, key, body }) => api.checkout(cartId, key, body))),
  });

  const canStart = cart.status === 'open' && quote !== null && !send.isPending;
  const sent = send.variables?.[0];

  function newAttempt(): Attempt | null {
    if (quote === null) return null;
    const next = { cartId: cart.id, key: crypto.randomUUID(), body: { ...quote, paymentToken } };
    setAttempt(next);
    return next;
  }

  function pay(times: 1 | 2) {
    const next = newAttempt();
    if (next) send.mutate(Array.from({ length: times }, () => next));
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <h3 className="font-semibold">Checkout</h3>
      <div className="flex flex-wrap items-center gap-2">
        <Select<PaymentToken> value={paymentToken} onValueChange={(token) => token && setPaymentToken(token)}>
          <SelectTrigger className="w-80 font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAYMENT_TOKENS.map((token) => (
              <SelectItem key={token} value={token} className="font-mono text-xs">
                {token}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!canStart} onClick={() => pay(1)}>
          Pay (new attempt)
        </Button>
        <Button variant="outline" disabled={!canStart} onClick={() => pay(2)}>
          Double submit
        </Button>
        <Button variant="outline" disabled={attempt === null || send.isPending} onClick={() => attempt && send.mutate([attempt])}>
          Retry same key
        </Button>
        <Button
          variant="outline"
          disabled={attempt === null || send.isPending}
          onClick={() =>
            attempt && send.mutate([{ ...attempt, body: { ...attempt.body, expectedTotalPaise: attempt.body.expectedTotalPaise + 1 } }])
          }
        >
          Change body, same key
        </Button>
      </div>
      {sent && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
          <dt className="text-muted-foreground">Idempotency-Key</dt>
          <dd className="break-all">{sent.key}</dd>
          <dt className="text-muted-foreground">Body</dt>
          <dd className="break-all">{JSON.stringify(sent.body)}</dd>
        </dl>
      )}
      {send.isPending && <p className="text-sm text-muted-foreground">Sending…</p>}
      {send.data?.map((result, index) => (
        <CheckoutResult key={index} result={result} />
      ))}
    </div>
  );
}

function CheckoutResult({ result }: { result: PromiseSettledResult<ApiResponse<Order>> }) {
  if (result.status === 'rejected') {
    const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
    return (
      <div className="space-y-1">
        <ErrorNotice error={error} />
        {error instanceof ApiError && error.status === 503 && (
          <p className="text-xs text-muted-foreground">Nothing was stored for this key: Retry same key.</p>
        )}
      </div>
    );
  }

  const { status, replayed, data: order } = result.value;
  return (
    <div className="space-y-1 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{status}</Badge>
        <span>
          Order is <strong>{order.status}</strong>, total {formatPaise(order.totalPaise)}
        </span>
        {replayed && <Badge variant="outline">Idempotent-Replayed</Badge>}
      </div>
      {order.status === 'pending_payment' && (
        <p className="text-xs text-muted-foreground">
          The payment outcome is unknown. Retry same key to poll, or reconcile on the admin page after the TTL.
        </p>
      )}
      <Link href={`/orders/${order.id}`} className="text-primary underline">
        View order {order.id}
      </Link>
    </div>
  );
}
