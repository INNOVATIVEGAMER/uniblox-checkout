import { defineConfig } from 'drizzle-kit';
import { loadConfig } from './src/config';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: loadConfig(process.env).DATABASE_URL },
});
