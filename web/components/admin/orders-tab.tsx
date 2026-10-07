'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ORDER_STATUSES, type OrderStatus, api, formatPaise } from '@/lib/api';
import { QueryState } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Filter = OrderStatus | 'all';

const FILTERS: Filter[] = ['all', ...ORDER_STATUSES];

export function OrdersTab() {
  const [filter, setFilter] = useState<Filter>('all');
  const orders = useQuery({
    queryKey: ['admin', 'orders', filter],
    queryFn: () => api.listOrders(filter === 'all' ? undefined : filter),
  });

  return (
    <div className="space-y-3">
      <Select<Filter> value={filter} onValueChange={(value) => value && setFilter(value)}>
        <SelectTrigger className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FILTERS.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <QueryState query={orders} isEmpty={(rows) => rows.length === 0} empty="No orders with this status.">
        {(rows) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Coupon</TableHead>
                <TableHead className="text-right">Discount</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>
                    <Link href={`/orders/${order.id}`} className="font-mono text-xs text-primary underline">
                      {order.id.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={order.status === 'failed' ? 'destructive' : 'secondary'}>{order.status}</Badge>
                    {order.failureReason && <span className="ml-1 text-xs text-muted-foreground">{order.failureReason}</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{order.coupon?.code ?? '—'}</TableCell>
                  <TableCell className="text-right">{formatPaise(order.discountPaise)}</TableCell>
                  <TableCell className="text-right">{formatPaise(order.totalPaise)}</TableCell>
                  <TableCell>{new Date(order.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </QueryState>
    </div>
  );
}
