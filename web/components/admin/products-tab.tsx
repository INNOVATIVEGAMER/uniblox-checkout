'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type Product, type ProductPatch, api, formatPaise } from '@/lib/api';
import { ErrorNotice } from '@/components/error-notice';
import { QueryState } from '@/components/query-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function ProductsTab() {
  const products = useQuery({ queryKey: ['products'], queryFn: api.listProducts });
  const patch = useMutation({ mutationFn: ({ id, changes }: { id: string; changes: ProductPatch }) => api.patchProduct(id, changes) });

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Prices are in paise. Change a carted product&apos;s price, or drop its stock below the cart&apos;s quantity, then pay
        in the shop tab to get PRICE_CHANGED or INSUFFICIENT_STOCK.
      </p>
      {patch.error && <ErrorNotice error={patch.error} />}
      <QueryState query={products} isEmpty={(rows) => rows.length === 0} empty="No products. Run pnpm db:seed.">
        {(rows) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Price (paise)</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((product) => (
                <ProductRow
                  key={`${product.id}:${product.pricePaise}:${product.stock}`}
                  product={product}
                  saving={patch.isPending}
                  onSave={(changes) => patch.mutate({ id: product.id, changes })}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </QueryState>
    </div>
  );
}

function ProductRow({ product, saving, onSave }: { product: Product; saving: boolean; onSave: (changes: ProductPatch) => void }) {
  const [price, setPrice] = useState(String(product.pricePaise));
  const [stock, setStock] = useState(String(product.stock));

  const changes: ProductPatch = {};
  if (Number(price) !== product.pricePaise) changes.pricePaise = Number(price);
  if (Number(stock) !== product.stock) changes.stock = Number(stock);
  const valid = price !== '' && stock !== '';

  return (
    <TableRow>
      <TableCell>
        <div>{product.name}</div>
        <div className="text-xs text-muted-foreground">{formatPaise(product.pricePaise)}</div>
      </TableCell>
      <TableCell>
        <Input type="number" className="w-32" value={price} onChange={(event) => setPrice(event.target.value)} />
      </TableCell>
      <TableCell>
        <Input type="number" className="w-24" value={stock} onChange={(event) => setStock(event.target.value)} />
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" disabled={saving || !valid || Object.keys(changes).length === 0} onClick={() => onSave(changes)}>
          Save
        </Button>
      </TableCell>
    </TableRow>
  );
}
