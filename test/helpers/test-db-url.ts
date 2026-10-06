import { z } from 'zod';

export const DEFAULT_TEST_DATABASE_URL = 'postgres://checkout:checkout@localhost:5432/checkout_test';

const testDatabaseUrlSchema = z
  .url()
  .refine((url) => URL.parse(url)?.pathname.endsWith('_test') === true, 'database name must end in _test');

export function assertTestDatabaseUrl(url: string): string {
  const parsed = testDatabaseUrlSchema.safeParse(url);
  if (!parsed.success) throw new Error(`Refusing to run tests against ${url}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
