import { createApp } from '../../src/app';
import { createDb } from '../../src/db/client';
import { FakeGateway } from '../../src/modules/payments/fake-gateway';
import type { PaymentGateway } from '../../src/modules/payments/gateway';
import { testConfig } from './db';

export type TestApp = ReturnType<typeof createApp>;

// The widest fan-out is 20 concurrent checkouts. Barrier and poller connections are separate clients.
const TEST_POOL_MAX = 22;

/**
 * `app` uses a FakeGateway shared by the file. A test that asserts on the gateway builds its own app
 * with `appWith`, on the same pool.
 */
export function createTestApp(overrides: Record<string, string> = {}) {
  const config = testConfig(overrides);
  const { db, pool } = createDb(config, { max: TEST_POOL_MAX });
  const appWith = (gateway: PaymentGateway) => createApp({ config, gateway, db });
  return { app: appWith(new FakeGateway()), appWith, db, pool, config };
}

export async function sendJson(
  app: TestApp,
  method: 'PATCH' | 'PUT' | 'POST',
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
