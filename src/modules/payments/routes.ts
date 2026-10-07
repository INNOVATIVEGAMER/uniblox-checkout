import { Hono } from 'hono';
import { type RecoveryDeps, reconcile } from './recovery';

export function paymentsRoutes(deps: RecoveryDeps) {
  return new Hono().post('/admin/payments/reconcile', async (c) => c.json(await reconcile(deps)));
}
