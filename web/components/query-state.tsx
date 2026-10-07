import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ErrorNotice } from './error-notice';

/** Renders a query's loading, error and empty states, and hands the data to `children` otherwise. */
export function QueryState<T>({
  query,
  isEmpty,
  empty,
  children,
}: {
  query: UseQueryResult<T>;
  isEmpty?: (data: T) => boolean;
  empty?: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (query.isLoadingError) return <ErrorNotice error={query.error} />;

  // A failed refetch keeps the last data mounted in the same slot, so state below it (an attempt's Idempotency-Key) survives.
  return (
    <>
      {query.isRefetchError && (
        <div className="mb-3">
          <ErrorNotice error={query.error} />
        </div>
      )}
      {isEmpty?.(query.data) ? <p className="text-sm text-muted-foreground">{empty}</p> : children(query.data)}
    </>
  );
}
