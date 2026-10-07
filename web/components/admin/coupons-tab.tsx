'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ErrorNotice } from '@/components/error-notice';
import { QueryState } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function CouponsTab() {
  const coupons = useQuery({ queryKey: ['admin', 'coupons'], queryFn: api.listCoupons });
  const generate = useMutation({ mutationFn: api.generateCoupon });

  return (
    <div className="space-y-3">
      <Button disabled={generate.isPending} onClick={() => generate.mutate()}>
        Generate coupon
      </Button>
      {generate.error && <ErrorNotice error={generate.error} />}
      {generate.data && (
        <p className="rounded-md border p-3 text-sm">
          Generated <code className="font-mono font-semibold">{generate.data.coupon.code}</code> for milestone{' '}
          {generate.data.coupon.milestone}. Milestones still eligible: {generate.data.remainingEligible}.
        </p>
      )}
      <QueryState query={coupons} isEmpty={(rows) => rows.length === 0} empty="No coupons yet.">
        {(rows) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead className="text-right">Milestone</TableHead>
                <TableHead className="text-right">% off</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Redeemed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((coupon) => (
                <TableRow key={coupon.id}>
                  <TableCell className="font-mono text-xs">{coupon.code}</TableCell>
                  <TableCell className="text-right">{coupon.milestone}</TableCell>
                  <TableCell className="text-right">{coupon.percentOff}</TableCell>
                  <TableCell>
                    <Badge variant={coupon.status === 'available' ? 'secondary' : 'outline'}>{coupon.status}</Badge>
                  </TableCell>
                  <TableCell>{coupon.redeemedAt ? new Date(coupon.redeemedAt).toLocaleString() : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </QueryState>
    </div>
  );
}
