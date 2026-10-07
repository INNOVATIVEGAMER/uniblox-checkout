'use client';

import { type LoggedCall, useCallLog } from '@/lib/response-log';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { JsonBlock } from './error-notice';

function StatusBadge({ status }: { status: number }) {
  return <Badge variant={status >= 400 ? 'destructive' : 'secondary'}>{status}</Badge>;
}

function CallLine({ call }: { call: LoggedCall }) {
  return (
    <div className="flex items-center gap-2 font-mono text-xs">
      <StatusBadge status={call.status} />
      <span className="font-semibold">{call.method}</span>
      <span className="truncate">{call.path}</span>
      {call.replayed && <Badge variant="outline">replayed</Badge>}
    </div>
  );
}

/**
 * The latest call that changed something, in full, then every recent call on one line. Each mutation refetches the
 * page's queries, so "the latest call" alone would almost always be a GET.
 */
export function ResponsePanel() {
  const calls = useCallLog();
  const latestChange = calls.find((call) => call.method !== 'GET') ?? calls[0];

  return (
    <Card size="sm" className="lg:sticky lg:top-4">
      <CardHeader>
        <CardTitle>Last response</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!latestChange && <p className="text-sm text-muted-foreground">No calls yet.</p>}
        {latestChange && (
          <div className="space-y-2">
            <CallLine call={latestChange} />
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
              <dt className="text-muted-foreground">Idempotency-Key</dt>
              <dd className="break-all">{latestChange.idempotencyKey ?? '—'}</dd>
              <dt className="text-muted-foreground">Idempotent-Replayed</dt>
              <dd>{latestChange.replayed ? 'true' : '—'}</dd>
              <dt className="text-muted-foreground">Retry-After</dt>
              <dd>{latestChange.retryAfter ?? '—'}</dd>
            </dl>
            <JsonBlock value={latestChange.body} />
          </div>
        )}
        {calls.length > 0 && (
          <div className="space-y-1 border-t pt-2">
            <p className="text-xs text-muted-foreground">Recent calls, newest first</p>
            {calls.map((call) => (
              <CallLine key={call.id} call={call} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
