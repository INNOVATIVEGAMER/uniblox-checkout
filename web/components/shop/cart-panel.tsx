'use client';

import { type UseQueryResult, skipToken, useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { type Cart, api, formatPaise } from '@/lib/api';
import { ErrorNotice } from '@/components/error-notice';
import { QueryState } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CheckoutPanel, type Quote } from './checkout-panel';

const MAX_LINE_QUANTITY = 1000;

export function CartPanel({ cartId, cart, onNewCart }: { cartId: string | null; cart: UseQueryResult<Cart>; onNewCart: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cart</CardTitle>
        <CardAction>
          <Button variant="outline" size="sm" disabled={cartId === null} onClick={onNewCart}>
            New cart
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {cartId === null ? (
          <p className="text-sm text-muted-foreground">The cart is empty. Add a product to start one.</p>
        ) : (
          <QueryState query={cart}>{(data) => <CartBody key={data.id} cart={data} />}</QueryState>
        )}
      </CardContent>
    </Card>
  );
}

function CartBody({ cart }: { cart: Cart }) {
  const [couponInput, setCouponInput] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: ['cart', cart.id, appliedCoupon],
    queryFn: appliedCoupon === null ? skipToken : () => api.getCart(cart.id, appliedCoupon),
  });
  const editLine = useMutation({
    mutationFn: ({ productId, quantity }: { productId: string; quantity: number | null }) =>
      quantity === null ? api.removeItem(cart.id, productId) : api.setQuantity(cart.id, productId, quantity),
  });

  const open = cart.status === 'open';
  const priced = appliedCoupon !== null && preview.data && !preview.isError ? preview.data : cart;

  function applyCoupon(event: FormEvent) {
    event.preventDefault();
    setAppliedCoupon(couponInput.trim());
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono text-muted-foreground">{cart.id}</span>
        <Badge variant={open ? 'secondary' : 'outline'}>{cart.status}</Badge>
      </div>

      {!open && <ClosedCartNotice cart={cart} />}
      {editLine.error && <ErrorNotice error={editLine.error} />}

      {cart.lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No lines yet. Add a product.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Unit</TableHead>
              <TableHead>Quantity</TableHead>
              <TableHead className="text-right">Line total</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {cart.lines.map((line) => (
              <CartLineRow
                key={`${line.productId}:${line.quantity}`}
                line={line}
                disabled={!open || editLine.isPending}
                onSet={(quantity) => editLine.mutate({ productId: line.productId, quantity })}
              />
            ))}
          </TableBody>
        </Table>
      )}

      <form onSubmit={applyCoupon} className="flex gap-2">
        <Input placeholder="Coupon code" value={couponInput} onChange={(event) => setCouponInput(event.target.value)} />
        <Button type="submit" variant="outline" disabled={couponInput.trim() === ''}>
          Apply
        </Button>
        <Button type="button" variant="ghost" disabled={appliedCoupon === null} onClick={() => setAppliedCoupon(null)}>
          Clear
        </Button>
      </form>
      {appliedCoupon !== null && preview.isFetching && <p className="text-sm text-muted-foreground">Checking the coupon…</p>}
      {appliedCoupon !== null && preview.error && <ErrorNotice error={preview.error} />}

      <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
        <dt>Subtotal</dt>
        <dd className="text-right">{formatPaise(priced.subtotalPaise)}</dd>
        {priced.coupon && (
          <>
            <dt>
              Coupon <code className="font-mono">{priced.coupon.code}</code> ({priced.coupon.percentOff}% off)
            </dt>
            <dd className="text-right">−{formatPaise(priced.discountPaise)}</dd>
          </>
        )}
        <dt className="font-semibold">Total</dt>
        <dd className="text-right font-semibold">
          {formatPaise(priced.totalPaise)} <span className="font-mono text-xs text-muted-foreground">({priced.totalPaise} paise)</span>
        </dd>
      </dl>

      <CheckoutPanel cart={cart} quote={quoteFor(cart, appliedCoupon, preview)} />
    </div>
  );
}

/**
 * What checkout sends: the total on screen, with the coupon only when its preview priced that total. Null while the
 * preview is loading, so Pay can't send a coupon with the undiscounted total.
 */
function quoteFor(cart: Cart, appliedCoupon: string | null, preview: UseQueryResult<Cart>): Quote | null {
  if (appliedCoupon === null || preview.isError) return { expectedTotalPaise: cart.totalPaise };
  if (preview.isFetching || !preview.data?.coupon) return null;
  return { expectedTotalPaise: preview.data.totalPaise, couponCode: preview.data.coupon.code };
}

function ClosedCartNotice({ cart }: { cart: Cart }) {
  const text =
    cart.status === 'pending_payment'
      ? 'A payment for this cart is in progress. Its stock and coupon stay held until it resolves: reconcile it on the admin page once the TTL has passed.'
      : 'This cart is checked out. Start a new cart to shop again.';
  return (
    <div className="space-y-1 rounded-md border p-3 text-sm">
      <p>{text}</p>
      {cart.orderId && (
        <Link href={`/orders/${cart.orderId}`} className="text-primary underline">
          View order {cart.orderId}
        </Link>
      )}
    </div>
  );
}

function CartLineRow({
  line,
  disabled,
  onSet,
}: {
  line: Cart['lines'][number];
  disabled: boolean;
  onSet: (quantity: number | null) => void;
}) {
  const [quantity, setQuantity] = useState(String(line.quantity));
  const parsed = Number(quantity);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_LINE_QUANTITY;

  return (
    <TableRow>
      <TableCell>
        <div>{line.name}</div>
        {!line.available && <Badge variant="destructive">not enough stock</Badge>}
      </TableCell>
      <TableCell className="text-right">{formatPaise(line.unitPricePaise)}</TableCell>
      <TableCell>
        <div className="flex gap-1">
          <Input
            type="number"
            min={1}
            max={MAX_LINE_QUANTITY}
            className="w-20"
            value={quantity}
            disabled={disabled}
            onChange={(event) => setQuantity(event.target.value)}
          />
          <Button size="sm" variant="outline" disabled={disabled || !valid || parsed === line.quantity} onClick={() => onSet(parsed)}>
            Set
          </Button>
        </div>
      </TableCell>
      <TableCell className="text-right">{formatPaise(line.lineTotalPaise)}</TableCell>
      <TableCell className="text-right">
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onSet(null)}>
          Remove
        </Button>
      </TableCell>
    </TableRow>
  );
}
