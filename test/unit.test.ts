import { DrizzleQueryError } from 'drizzle-orm/errors';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { onError } from '../src/errors';
import { MAX_CART_LINES, MAX_LINE_QUANTITY, MAX_UNIT_PRICE_PAISE, discount, lineTotal, total } from '../src/domain/money';
import { withCleanup } from './helpers/cleanup';
import { assertTestDatabaseUrl } from './helpers/test-db-url';

describe('T27 money', () => {
  it('floors the discount: the cable at 34999 with 10% off gives 3499, not 3500', () => {
    expect(discount(34_999, 10)).toBe(3499);
    expect(total(34_999, discount(34_999, 10))).toBe(31_500);
  });

  it('gives a total of 0 at 100% off', () => {
    const subtotal = lineTotal(34_999, 3);
    expect(total(subtotal, discount(subtotal, 100))).toBe(0);
  });

  it('never produces a negative total and always rounds down', () => {
    for (const subtotal of [0, 1, 99, 100, 101, 34_999, 129_950, 1_899_900]) {
      for (let percent = 1; percent <= 100; percent++) {
        const d = discount(subtotal, percent);
        expect(Number.isInteger(d)).toBe(true);
        expect(d * 100).toBeLessThanOrEqual(subtotal * percent);
        expect((d + 1) * 100).toBeGreaterThan(subtotal * percent);
        expect(total(subtotal, d)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('stays exact for a full cart at the price, quantity and line caps', () => {
    const subtotal = lineTotal(MAX_UNIT_PRICE_PAISE - 1, MAX_LINE_QUANTITY) * MAX_CART_LINES;
    expect(subtotal * 100).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    const exact = (BigInt(subtotal) * 33n) / 100n;
    expect(BigInt(discount(subtotal, 33))).toBe(exact);
  });
});

describe('T29 config', () => {
  const valid = {
    COUPON_EVERY_N_ORDERS: '5',
    COUPON_PERCENT_OFF: '10',
    PAYMENT_PENDING_TTL_SECONDS: '600',
    GATEWAY_TIMEOUT_MS: '60000',
  };

  it.each([
    ['n = 0', { COUPON_EVERY_N_ORDERS: '0' }],
    ['n = 1.5', { COUPON_EVERY_N_ORDERS: '1.5' }],
    ['n = "abc"', { COUPON_EVERY_N_ORDERS: 'abc' }],
    ['n = ""', { COUPON_EVERY_N_ORDERS: '' }],
    ['x = 0', { COUPON_PERCENT_OFF: '0' }],
    ['x = 101', { COUPON_PERCENT_OFF: '101' }],
    ['TTL below 10 × gateway timeout', { PAYMENT_PENDING_TTL_SECONDS: '599' }],
  ])('rejects %s', (_label, override) => {
    expect(() => loadConfig({ ...valid, ...override })).toThrow(/Invalid configuration/);
  });

  it.each([
    ['x = 100', { COUPON_PERCENT_OFF: '100' }],
    ['x = 1', { COUPON_PERCENT_OFF: '1' }],
    ['n = 1', { COUPON_EVERY_N_ORDERS: '1' }],
    ['TTL exactly 10 × gateway timeout', { PAYMENT_PENDING_TTL_SECONDS: '600' }],
  ])('accepts %s', (_label, override) => {
    expect(() => loadConfig({ ...valid, ...override })).not.toThrow();
  });

  it('applies defaults to an empty environment', () => {
    expect(loadConfig({})).toMatchObject({
      COUPON_EVERY_N_ORDERS: 5,
      COUPON_PERCENT_OFF: 10,
      PAYMENT_PENDING_TTL_SECONDS: 300,
      GATEWAY_TIMEOUT_MS: 10_000,
      LOCK_TIMEOUT_MS: 5_000,
      PORT: 3000,
    });
  });
});

describe('test database guard', () => {
  it.each([
    'postgres://checkout:checkout@localhost:5432/checkout',
    'postgres://checkout:checkout@localhost:5432/checkout_testing',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => assertTestDatabaseUrl(url)).toThrow(/Refusing to run tests/);
  });

  it.each([
    'postgres://checkout:checkout@localhost:5432/checkout_test',
    'postgres://checkout:checkout@localhost:5432/checkout_test?sslmode=disable',
  ])('accepts %s', (url) => {
    expect(assertTestDatabaseUrl(url)).toBe(url);
  });
});

describe('withCleanup', () => {
  const ok = () => Promise.resolve();
  const fail = (message: string) => () => Promise.reject(new Error(message));

  it('returns the body result after running every cleanup', async () => {
    const cleanup = vi.fn(ok);
    await expect(withCleanup(() => Promise.resolve(7), cleanup, cleanup)).resolves.toBe(7);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('rethrows the body error over a failing cleanup, and still runs every cleanup', async () => {
    const cleanup = vi.fn(ok);
    await expect(withCleanup(fail('body'), fail('cleanup'), cleanup)).rejects.toThrow('body');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('throws a single cleanup failure as itself', async () => {
    await expect(withCleanup(ok, ok, fail('end'))).rejects.toThrow('end');
  });

  it('reports every cleanup failure when more than one fails', async () => {
    const err: unknown = await withCleanup(ok, fail('release'), fail('end')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect(err).toMatchObject({ errors: [{ message: 'release' }, { message: 'end' }] });
  });
});

describe('onError', () => {
  it.each([
    ['an unexpected error', new Error('secret-detail')],
    ['a database error other than a lock timeout', new DrizzleQueryError('secret-detail', [], Object.assign(new Error('secret-detail'), { code: '23505' }))],
    ['an HTTPException other than a 400', new HTTPException(401, { message: 'secret-detail' })],
  ])('maps %s to 500 INTERNAL without leaking it', async (_label, thrown) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = new Hono()
      .get('/boom', () => {
        throw thrown;
      })
      .onError(onError);

    const res = await app.request('/boom');

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL', message: expect.any(String) } });
    expect(text).not.toContain('secret-detail');
    expect(log).toHaveBeenCalledOnce();
  });
});
