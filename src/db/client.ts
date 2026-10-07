import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Config } from '../config';
import * as schema from './schema';

export function createDb(config: Pick<Config, 'DATABASE_URL' | 'LOCK_TIMEOUT_MS'>) {
  const pool = new Pool({ connectionString: config.DATABASE_URL, lock_timeout: config.LOCK_TIMEOUT_MS });
  pool.on('error', (err) => console.error('idle database client failed', err));
  const db = drizzle({ client: pool, schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>['db'];
