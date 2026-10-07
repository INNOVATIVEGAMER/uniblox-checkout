import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { carts } from '../src/db/schema';
import type { ErrorCode } from '../src/errors';
import { createTestApp } from './helpers/app';
import { resetDb, snapshotDb } from './helpers/db';

const { app, db, pool } = createTestApp();

const CART_ID = '5f0c6a0e-3b1d-4c2a-9e7f-1a2b3c4d5e6f';
const UNKNOWN_CART_ID = '0b8f2d4e-6a1c-4e3b-8d5f-7a9c1e3b5d7f';

beforeEach(async () => {
  await resetDb(db);
  await db.insert(carts).values({ id: CART_ID });
});
afterAll(() => pool.end());

const JSON_HEADERS = { 'content-type': 'application/json' };
const VALID_BODY = JSON.stringify({ stock: 1 });

type Row = {
  label: string;
  method: string;
  path: string;
  init?: RequestInit;
  status: 400 | 404;
  code: ErrorCode;
  detailPath?: string;
};

const errorBodySchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});

const jsonBody = (body: string): RequestInit => ({ headers: JSON_HEADERS, body });
const ONE = JSON.stringify({ quantity: 1 });

const CHECKOUT_BODY = { expectedTotalPaise: 0, paymentToken: 'pm_card_visa' };
const checkoutInit = (body: unknown, headers: Record<string, string> = { ...JSON_HEADERS, 'Idempotency-Key': 'k-1' }) => ({
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const checkoutPath = `/carts/${CART_ID}/checkout`;

// T25: every malformed or unknown request is rejected inside the envelope, with nothing changed.
const rows: Row[] = [
  ...['P_LAMP', 'lamp', 'p_', `p_${'a'.repeat(61)}`].map((id): Row => ({
    label: `malformed product id ${id.slice(0, 12)}`,
    method: 'PATCH',
    path: `/admin/products/${id}`,
    init: jsonBody(VALID_BODY),
    status: 400,
    code: 'VALIDATION_ERROR',
    detailPath: 'param.id',
  })),
  {
    label: 'unknown product',
    method: 'PATCH',
    path: '/admin/products/p_nope',
    init: jsonBody(VALID_BODY),
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
  ).map(([label, body]): Row => ({
    label,
    method: 'PATCH',
    path: '/admin/products/p_lamp',
    init: jsonBody(body),
    status: 400,
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
  ...(
    [
      ['quantity 0', '{"quantity":0}'],
      ['quantity -1', '{"quantity":-1}'],
      ['quantity 1.5', '{"quantity":1.5}'],
      ['quantity as a string', '{"quantity":"2"}'],
      ['quantity above the cap', '{"quantity":1001}'],
      ['missing quantity', '{}'],
    ] satisfies [string, string][]
  ).map(([label, body]): Row => ({
    label,
    method: 'PUT',
    path: `/carts/${CART_ID}/items/p_lamp`,
    init: jsonBody(body),
    status: 400,
    code: 'VALIDATION_ERROR',
    detailPath: 'json.quantity',
  })),
  {
    label: 'unknown field beside the quantity',
    method: 'PUT',
    path: `/carts/${CART_ID}/items/p_lamp`,
    init: jsonBody('{"quantity":1,"note":"gift"}'),
    status: 400,
    code: 'VALIDATION_ERROR',
  },
  ...[
    { id: 'not-a-uuid', why: 'not a UUID' },
    { id: '5f0c6a0e-3b1d-4c2a-7e7f-1a2b3c4d5e6f', why: 'UUID variant nibble 7' },
  ].flatMap(({ id, why }) => [
    { label: `malformed cart id (${why}) on GET`, method: 'GET', path: `/carts/${id}` },
    { label: `malformed cart id (${why}) on PUT`, method: 'PUT', path: `/carts/${id}/items/p_lamp`, init: jsonBody(ONE) },
    { label: `malformed cart id (${why}) on DELETE`, method: 'DELETE', path: `/carts/${id}/items/p_lamp` },
    { label: `malformed cart id (${why}) on checkout`, method: 'POST', path: `/carts/${id}/checkout`, init: checkoutInit(CHECKOUT_BODY) },
  ].map((row): Row => ({ ...row, status: 400, code: 'VALIDATION_ERROR', detailPath: 'param.id' }))),
  ...[
    { label: 'unknown cart on GET', method: 'GET', path: `/carts/${UNKNOWN_CART_ID}` },
    { label: 'unknown cart on PUT', method: 'PUT', path: `/carts/${UNKNOWN_CART_ID}/items/p_lamp`, init: jsonBody(ONE) },
    { label: 'unknown cart on DELETE', method: 'DELETE', path: `/carts/${UNKNOWN_CART_ID}/items/p_lamp` },
  ].map((row): Row => ({ ...row, status: 404, code: 'CART_NOT_FOUND' })),
  {
    label: 'unknown product on PUT',
    method: 'PUT',
    path: `/carts/${CART_ID}/items/p_nope`,
    init: jsonBody(ONE),
    status: 404,
    code: 'PRODUCT_NOT_FOUND',
  },
  ...[
    { label: 'malformed product id on PUT', method: 'PUT', path: `/carts/${CART_ID}/items/LAMP`, init: jsonBody(ONE) },
    { label: 'malformed product id on DELETE', method: 'DELETE', path: `/carts/${CART_ID}/items/LAMP` },
  ].map((row): Row => ({ ...row, status: 400, code: 'VALIDATION_ERROR', detailPath: 'param.productId' })),
  ...(
    [
      ['missing Idempotency-Key', JSON_HEADERS],
      ['empty Idempotency-Key', { ...JSON_HEADERS, 'Idempotency-Key': '' }],
      ['Idempotency-Key over 255 characters', { ...JSON_HEADERS, 'Idempotency-Key': 'k'.repeat(256) }],
    ] satisfies [string, Record<string, string>][]
  ).map(([label, headers]): Row => ({
    label,
    method: 'POST',
    path: checkoutPath,
    init: checkoutInit(CHECKOUT_BODY, headers),
    status: 400,
    code: 'IDEMPOTENCY_KEY_INVALID',
  })),
  ...(
    [
      ['missing expectedTotalPaise', { paymentToken: 'pm_card_visa' }, 'json.expectedTotalPaise'],
      ['negative expectedTotalPaise', { ...CHECKOUT_BODY, expectedTotalPaise: -1 }, 'json.expectedTotalPaise'],
      ['fractional expectedTotalPaise', { ...CHECKOUT_BODY, expectedTotalPaise: 1.5 }, 'json.expectedTotalPaise'],
      ['expectedTotalPaise as a string', { ...CHECKOUT_BODY, expectedTotalPaise: '100' }, 'json.expectedTotalPaise'],
      ['missing paymentToken', { expectedTotalPaise: 0 }, 'json.paymentToken'],
      ['unknown field beside the checkout body', { ...CHECKOUT_BODY, note: 'gift' }, undefined],
    ] satisfies [string, unknown, string | undefined][]
  ).map(([label, body, detailPath]): Row => ({
    label,
    method: 'POST',
    path: checkoutPath,
    init: checkoutInit(body),
    status: 400,
    code: 'VALIDATION_ERROR',
    detailPath,
  })),
  {
    label: 'non-JSON Content-Type on checkout',
    method: 'POST',
    path: checkoutPath,
    init: checkoutInit(CHECKOUT_BODY, { 'content-type': 'text/plain', 'Idempotency-Key': 'k-1' }),
    status: 400,
    code: 'VALIDATION_ERROR',
    detailPath: 'header.content-type',
  },
  { label: 'malformed order id', method: 'GET', path: '/orders/not-a-uuid', status: 400, code: 'VALIDATION_ERROR', detailPath: 'param.id' },
  { label: 'unknown order', method: 'GET', path: `/orders/${UNKNOWN_CART_ID}`, status: 404, code: 'ORDER_NOT_FOUND' },
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

describe('the Idempotency-Key length bound', () => {
  it('accepts a 255-character key: the empty cart then gets 422 CART_EMPTY', async () => {
    const res = await app.request(checkoutPath, { method: 'POST', ...checkoutInit(CHECKOUT_BODY, { ...JSON_HEADERS, 'Idempotency-Key': 'k'.repeat(255) }) });
    expect(res.status).toBe(422);
    expect(errorBodySchema.parse(await res.json()).error.code).toBe('CART_EMPTY');
  });
});
