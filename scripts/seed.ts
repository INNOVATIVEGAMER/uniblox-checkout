import { loadConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { seed } from '../src/db/seed';

const { db, pool } = createDb(loadConfig(process.env));
await seed(db);
await pool.end();
