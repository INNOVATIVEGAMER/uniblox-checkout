import Link from 'next/link';
import { ApiError, orderIdOf } from '@/lib/api';
import { Badge } from '@/components/ui/badge';

export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** Shows an error exactly as the API sent it: status, code, message and details. */
export function ErrorNotice({ error }: { error: Error }) {
  if (!(error instanceof ApiError)) {
    return (
      <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
        <pre className="font-mono text-xs whitespace-pre-wrap">{error.message}</pre>
      </div>
    );
  }

  const orderId = orderIdOf(error);
  return (
    <div className="space-y-2 rounded-md border border-destructive/40 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="destructive">{error.status}</Badge>
        <code className="font-mono font-semibold">{error.code}</code>
        {error.replayed && <Badge variant="outline">Idempotent-Replayed</Badge>}
      </div>
      <p>{error.message}</p>
      {error.details !== undefined && <JsonBlock value={error.details} />}
      {orderId && (
        <Link href={`/orders/${orderId}`} className="text-primary underline">
          View order {orderId}
        </Link>
      )}
    </div>
  );
}
