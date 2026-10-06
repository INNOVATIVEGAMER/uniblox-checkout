import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp } from './helpers/app';
import { resetDb, snapshotDb } from './helpers/db';

const { app, db, pool } = createTestApp();

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

const JSON_HEADERS = { 'content-type': 'application/json' };
const VALID_BODY = JSON.stringify({ stock: 1 });

type Row = {
  label: string;
  method: string;
  path: string;
  init?: RequestInit;
  status: 400 | 404;
  code: string;
  detailPath?: string;
};

const errorBodySchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});

const patchLamp = (body: string): RequestInit => ({ headers: JSON_HEADERS, body });

// T25: every malformed or unknown request is rejected inside the envelope, with nothing changed.
const rows: Row[] = [
  ...['P_LAMP', 'lamp', 'p_', `p_${'a'.repeat(61)}`].map((id) => ({
    label: `malformed product id ${id.slice(0, 12)}`,
    method: 'PATCH',
    path: `/admin/products/${id}`,
    init: patchLamp(VALID_BODY),
    status: 400 as const,
    code: 'VALIDATION_ERROR',
    detailPath: 'param.id',
  })),
  {
    label: 'unknown product',
    method: 'PATCH',
    path: '/admin/products/p_nope',
    init: patchLamp(VALID_BODY),
    status: 404,
    code: 'PRODUCT_NOT_FOUND',
  },
  ...(
    [
      ['empty PATCH', '{}'],
      ['unknown field beside a valid one', '{"stock":5,"bogus":1}'],
      ['null body', 'null'],
      ['array body', '[]'],
      ['negative price', '{"pricePaise":-1}'],
      ['fractional price', '{"pricePaise":1.5}'],
      ['price as a string', '{"pricePaise":"100"}'],
      ['price above the cap', '{"pricePaise":1000000001}'],
      ['negative stock', '{"stock":-1}'],
      ['stock above int32', '{"stock":2147483648}'],
      ['blank name', '{"name":"   "}'],
      ['name over 200 characters', JSON.stringify({ name: 'a'.repeat(201) })],
      ['malformed JSON', '{"stock":'],
      ['empty body', ''],
    ] satisfies [string, string][]
  ).map(([label, body]) => ({
    label,
    method: 'PATCH',
    path: '/admin/products/p_lamp',
    init: patchLamp(body),
    status: 400 as const,
    code: 'VALIDATION_ERROR',
  })),
  {
    label: 'non-JSON Content-Type',
    method: 'PATCH',
    path: '/admin/products/p_lamp',
    init: { headers: { 'content-type': 'text/plain' }, body: VALID_BODY },
    status: 400,
    code: 'VALIDATION_ERROR',
    detailPath: 'header.content-type',
  },
  {
    label: 'missing Content-Type',
    method: 'PATCH',
    path: '/admin/products/p_lamp',
    init: { body: new TextEncoder().encode(VALID_BODY) },
    status: 400,
    code: 'VALIDATION_ERROR',
    detailPath: 'header.content-type',
  },
  { label: 'unknown route', method: 'GET', path: '/nope', status: 404, code: 'NOT_FOUND' },
  { label: 'wrong method on a known path', method: 'DELETE', path: '/products', status: 404, code: 'NOT_FOUND' },
];

describe('T25 validation and not-found', () => {
  it.each(rows)('$label → $status $code', async ({ method, path, init, status, code, detailPath }) => {
    const before = await snapshotDb(db);

    const res = await app.request(path, { method, ...init });

    expect(res.status).toBe(status);
    const { error } = errorBodySchema.parse(await res.json());
    expect(error.code).toBe(code);
    if (detailPath) expect(error.details).toContainEqual(expect.objectContaining({ path: detailPath }));
    expect(await snapshotDb(db)).toEqual(before);
  });
});
