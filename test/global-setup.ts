import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { TestProject } from 'vitest/node';
import { createDb } from '../src/db/client';
import { DEFAULT_TEST_DATABASE_URL, assertTestDatabaseUrl } from './helpers/test-db-url';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const databaseUrl = assertTestDatabaseUrl(process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);
  const { db, pool } = createDb({ DATABASE_URL: databaseUrl, LOCK_TIMEOUT_MS: 10_000 });
  try {
    await migrate(db, { migrationsFolder: 'drizzle' });
  } finally {
    await pool.end();
  }
  project.provide('databaseUrl', databaseUrl);
}
