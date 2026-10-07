'use client';

import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';

// Every mutation refreshes every query, success or not: a declined checkout has still released stock and its coupon.
// Focus refetch is off so a page keeps showing what the customer last saw, which is what PRICE_CHANGED guards.
function createQueryClient() {
  const queryClient: QueryClient = new QueryClient({
    mutationCache: new MutationCache({ onSettled: () => queryClient.invalidateQueries() }),
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return queryClient;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
