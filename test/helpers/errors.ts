import { expect } from 'vitest';
import { z } from 'zod';
import type { ErrorCode } from '../../src/errors';

export const errorBodySchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

export async function expectError(res: Response, status: number, code: ErrorCode) {
  expect(res.status).toBe(status);
  const { error } = errorBodySchema.parse(await res.json());
  expect(error.code).toBe(code);
  return error;
}
