import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();

const configSchema = z
  .object({
    COUPON_EVERY_N_ORDERS: positiveInt.default(5),
    COUPON_PERCENT_OFF: z.coerce.number().int().min(1).max(100).default(10),
    PAYMENT_PENDING_TTL_SECONDS: positiveInt.default(300),
    GATEWAY_TIMEOUT_MS: positiveInt.default(10_000),
    LOCK_TIMEOUT_MS: positiveInt.default(5_000),
    DATABASE_URL: z.url().default('postgres://checkout:checkout@localhost:5432/checkout'),
    PORT: positiveInt.max(65_535).default(3000),
  })
  .refine((c) => c.PAYMENT_PENDING_TTL_SECONDS * 1000 >= 10 * c.GATEWAY_TIMEOUT_MS, {
    message: 'PAYMENT_PENDING_TTL_SECONDS must be at least 10 × GATEWAY_TIMEOUT_MS',
    path: ['PAYMENT_PENDING_TTL_SECONDS'],
  });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
