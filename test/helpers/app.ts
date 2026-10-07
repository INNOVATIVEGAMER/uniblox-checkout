import { createApp } from '../../src/app';
import { createDb } from '../../src/db/client';
import { testConfig } from './db';

export type TestApp = ReturnType<typeof createApp>;

export function createTestApp(overrides: Record<string, string> = {}) {
  const config = testConfig(overrides);
  const { db, pool } = createDb(config);
  return { app: createApp({ db }), db, pool, config };
}

export function patchJson(app: TestApp, path: string, body: unknown) {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
