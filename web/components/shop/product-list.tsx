'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { type Cart, api, formatPaise } from '@/lib/api';
import { ErrorNotice } from '@/components/error-notice';
import { QueryState } from '@/components/query-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function ProductList({
  cart,
  cartId,
  onCartCreated,
}: {
  cart: Cart | null;
  cartId: string | null;
  onCartCreated: (id: string) => void;
}) {
  const products = useQuery({ queryKey: ['products'], queryFn: api.listProducts });
  const addToCart = useMutation({
    mutationFn: async (productId: string) => {
      let id = cartId;
      if (id === null) {
        id = (await api.createCart()).id;
        onCartCreated(id);
      }
      const inCart = cart?.lines.find((line) => line.productId === productId)?.quantity ?? 0;
      return api.setQuantity(id, productId, inCart + 1);
    },
  });

  const cartClosed = cart !== null && cart.status !== 'open';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Products</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {addToCart.error && <ErrorNotice error={addToCart.error} />}
        <QueryState query={products} isEmpty={(rows) => rows.length === 0} empty="No products. Run pnpm db:seed.">
          {(rows) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((product) => (
                  <TableRow key={product.id}>
                    <TableCell>
                      <div>{product.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{product.id}</div>
                    </TableCell>
                    <TableCell className="text-right">{formatPaise(product.pricePaise)}</TableCell>
                    <TableCell className="text-right">{product.stock}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" disabled={addToCart.isPending || cartClosed}onClick={() => addToCart.mutate(product.id)}>
                        Add
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}
