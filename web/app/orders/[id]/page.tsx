'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api, formatPaise } from '@/lib/api';
import { QueryState } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const order = useQuery({ queryKey: ['orders', id], queryFn: () => api.getOrder(id) });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Order</CardTitle>
        <CardAction>
          <Button variant="outline" size="sm" disabled={order.isFetching} onClick={() => order.refetch()}>
            Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <QueryState query={order}>
          {(data) => (
            <div className="space-y-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Id</dt>
                <dd className="font-mono text-xs">{data.id}</dd>
                <dt className="text-muted-foreground">Status</dt>
                <dd>
                  <Badge variant={data.status === 'failed' ? 'destructive' : 'secondary'}>{data.status}</Badge>
                </dd>
                <dt className="text-muted-foreground">Payment ref</dt>
                <dd className="font-mono text-xs">{data.paymentRef ?? '—'}</dd>
                <dt className="text-muted-foreground">Failure reason</dt>
                <dd>{data.failureReason ?? '—'}</dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd>{new Date(data.createdAt).toLocaleString()}</dd>
                <dt className="text-muted-foreground">Resolved</dt>
                <dd>{data.resolvedAt ? new Date(data.resolvedAt).toLocaleString() : '—'}</dd>
              </dl>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Unit (frozen)</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead className="text-right">Line total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.lines.map((line) => (
                    <TableRow key={line.productId}>
                      <TableCell>{line.productName}</TableCell>
                      <TableCell className="text-right">{formatPaise(line.unitPricePaise)}</TableCell>
                      <TableCell className="text-right">{line.quantity}</TableCell>
                      <TableCell className="text-right">{formatPaise(line.lineTotalPaise)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
                <dt>Subtotal</dt>
                <dd className="text-right">{formatPaise(data.subtotalPaise)}</dd>
                <dt>
                  Coupon{' '}
                  {data.coupon ? (
                    <>
                      <code className="font-mono">{data.coupon.code}</code> ({data.coupon.percentOff}% off)
                    </>
                  ) : (
                    '—'
                  )}
                </dt>
                <dd className="text-right">−{formatPaise(data.discountPaise)}</dd>
                <dt className="font-semibold">Total</dt>
                <dd className="text-right font-semibold">{formatPaise(data.totalPaise)}</dd>
              </dl>
            </div>
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}
