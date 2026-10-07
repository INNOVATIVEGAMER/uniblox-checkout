'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api, formatPaise } from '@/lib/api';
import { CouponsTab } from '@/components/admin/coupons-tab';
import { OrdersTab } from '@/components/admin/orders-tab';
import { ProductsTab } from '@/components/admin/products-tab';
import { ErrorNotice } from '@/components/error-notice';
import { QueryState } from '@/components/query-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function AdminPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="products" className="space-y-4">
          <TabsList>
            <TabsTrigger value="products">Products</TabsTrigger>
            <TabsTrigger value="coupons">Coupons</TabsTrigger>
            <TabsTrigger value="orders">Orders</TabsTrigger>
            <TabsTrigger value="report">Report</TabsTrigger>
            <TabsTrigger value="reconcile">Reconcile</TabsTrigger>
          </TabsList>
          <TabsContent value="products">
            <ProductsTab />
          </TabsContent>
          <TabsContent value="coupons">
            <CouponsTab />
          </TabsContent>
          <TabsContent value="orders">
            <OrdersTab />
          </TabsContent>
          <TabsContent value="report">
            <ReportTab />
          </TabsContent>
          <TabsContent value="reconcile">
            <ReconcileTab />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function ReportTab() {
  const report = useQuery({ queryKey: ['admin', 'report'], queryFn: api.getReport });

  return (
    <QueryState query={report}>
      {(data) => (
        <div className="grid gap-6 md:grid-cols-2">
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
            <dt>Paid orders</dt>
            <dd className="text-right">{data.paidOrders}</dd>
            <dt>Pending / failed orders</dt>
            <dd className="text-right">
              {data.ordersByStatus.pending_payment} / {data.ordersByStatus.failed}
            </dd>
            <dt>Gross revenue</dt>
            <dd className="text-right">{formatPaise(data.grossRevenuePaise)}</dd>
            <dt>Discounts</dt>
            <dd className="text-right">−{formatPaise(data.discountsPaise)}</dd>
            <dt className="font-semibold">Net revenue</dt>
            <dd className="text-right font-semibold">{formatPaise(data.netRevenuePaise)}</dd>
            <dt>Coupons generated</dt>
            <dd className="text-right">{data.coupons.generated}</dd>
            <dt>Available / reserved / redeemed</dt>
            <dd className="text-right">
              {data.coupons.available} / {data.coupons.reserved} / {data.coupons.redeemed}
            </dd>
            <dt>Milestones (every {data.milestones.n} paid orders)</dt>
            <dd className="text-right">
              {data.milestones.reached} reached, {data.milestones.rewarded} rewarded, {data.milestones.unrewarded} waiting
            </dd>
          </dl>
          <div className="text-sm">
            <p className="mb-1 font-semibold">Units sold</p>
            {data.quantityByProduct.length === 0 ? (
              <p className="text-muted-foreground">No paid orders yet.</p>
            ) : (
              <dl className="grid grid-cols-[1fr_auto] gap-y-1">
                {data.quantityByProduct.map((row) => (
                  <div key={row.productId} className="contents">
                    <dt>{row.name}</dt>
                    <dd className="text-right">{row.quantity}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
      )}
    </QueryState>
  );
}

function ReconcileTab() {
  const reconcile = useMutation({ mutationFn: api.reconcile });

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Resolves every pending payment older than PAYMENT_PENDING_TTL_SECONDS by asking the gateway for its outcome.
      </p>
      <Button disabled={reconcile.isPending} onClick={() => reconcile.mutate()}>
        Reconcile pending payments
      </Button>
      {reconcile.error && <ErrorNotice error={reconcile.error} />}
      {reconcile.data && (
        <div className="space-y-1 rounded-md border p-3">
          <p>
            Resolved {reconcile.data.resolved.length}, still pending {reconcile.data.stillPending}.
          </p>
          {reconcile.data.resolved.map(({ orderId, status }) => (
            <p key={orderId}>
              <Link href={`/orders/${orderId}`} className="font-mono text-xs text-primary underline">
                {orderId}
              </Link>{' '}
              → {status}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
