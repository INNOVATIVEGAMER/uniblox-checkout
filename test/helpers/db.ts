import { sql } from 'drizzle-orm';
import { inject } from 'vitest';
import { loadConfig } from '../../src/config';
import type { Db } from '../../src/db/client';
import { seed } from '../../src/db/seed';

export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: inject('databaseUrl'),
    LOCK_TIMEOUT_MS: '10000',
    GATEWAY_TIMEOUT_MS: '60000',
    PAYMENT_PENDING_TTL_SECONDS: '600',
    ...overrides,
  });
}

export async function resetDb(db: Db): Promise<void> {
  const tables = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const names = tables.rows.map((t) => `"public"."${t.tablename}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE ${names} RESTART IDENTITY CASCADE`));
  await seed(db);
}
