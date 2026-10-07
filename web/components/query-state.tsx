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
  if (query.isError) return <ErrorNotice error={query.error} />;
  if (isEmpty?.(query.data)) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return children(query.data);
}
