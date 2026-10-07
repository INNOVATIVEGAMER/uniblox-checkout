import { DrizzleQueryError } from 'drizzle-orm/errors';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { onError } from '../src/errors';
import { milestoneProgress } from '../src/domain/milestones';
import { MAX_CART_LINES, MAX_LINE_QUANTITY, MAX_UNIT_PRICE_PAISE, discount, lineTotal, total } from '../src/domain/money';
import { couponCodeSchema, generateCouponCode } from '../src/modules/coupons/code';
import { FakeGateway } from '../src/modules/payments/fake-gateway';
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

describe('T28 milestones', () => {
  it.each([
    ['n − 1 paid orders', { paidOrders: 4, lastMilestone: 0 }, { next: 1, eligible: false, remainingEligible: 0, nextMilestoneAt: 5 }],
    ['n paid orders', { paidOrders: 5, lastMilestone: 0 }, { next: 1, eligible: true, remainingEligible: 0, nextMilestoneAt: 5 }],
    ['2n paid orders, none rewarded: the oldest first', { paidOrders: 10, lastMilestone: 0 }, { next: 1, eligible: true, remainingEligible: 1, nextMilestoneAt: 5 }],
    ['2n paid orders, the first rewarded', { paidOrders: 10, lastMilestone: 1 }, { next: 2, eligible: true, remainingEligible: 0, nextMilestoneAt: 10 }],
    ['2n + 1 paid orders, both rewarded', { paidOrders: 11, lastMilestone: 2 }, { next: 3, eligible: false, remainingEligible: 0, nextMilestoneAt: 15 }],
  ])('%s', (_label, input, expected) => {
    expect(milestoneProgress({ n: 5, ...input })).toEqual(expected);
  });
});

describe('coupon codes', () => {
  it('generates SAVE{x}-M{k}- and 8 Crockford base32 characters', () => {
    for (let i = 0; i < 200; i++) expect(generateCouponCode(10, 3)).toMatch(/^SAVE10-M3-[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it('survives the shared schema unchanged', () => {
    const code = generateCouponCode(100, 12);
    expect(couponCodeSchema.parse(code)).toBe(code);
  });

  it('normalises input by trimming and uppercasing', () => {
    expect(couponCodeSchema.parse('  save10-m1-abc  ')).toBe('SAVE10-M1-ABC');
  });

  it('reads a typed I or L as 1 and O as 0, as Crockford decoding does', () => {
    expect(couponCodeSchema.parse('save10-m1-oil0')).toBe('SAVE10-M1-0110');
  });

  it.each(['', '   ', 'A'.repeat(65)])('rejects %j', (input) => {
    expect(couponCodeSchema.safeParse(input).success).toBe(false);
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

describe('T30 fake gateway', () => {
  const charge = (gateway: FakeGateway, paymentToken: string, orderId = 'order-1') =>
    gateway.charge({ orderId, amountPaise: 34_999, paymentToken });

  it.each([
    ['pm_card_visa', { outcome: 'approved', paymentRef: expect.stringMatching(/^ch_/) }],
    ['pm_card_chargeDeclined', { outcome: 'declined', reason: 'card_declined' }],
    ['pm_card_chargeDeclinedInsufficientFunds', { outcome: 'declined', reason: 'insufficient_funds' }],
    ['tok_unknown', { outcome: 'declined', reason: 'invalid_payment_method' }],
  ])('%s gives %o', async (token, expected) => {
    expect(await charge(new FakeGateway(), token)).toEqual(expected);
  });

  it('charging the same order twice returns the first result and records one charge', async () => {
    const gateway = new FakeGateway();
    const first = await charge(gateway, 'pm_card_visa');
    expect(await charge(gateway, 'pm_card_chargeDeclined')).toEqual(first);
    expect(gateway.charges.size).toBe(1);
  });

  it('records each order separately', async () => {
    const gateway = new FakeGateway();
    const a = await charge(gateway, 'pm_card_visa', 'order-a');
    const b = await charge(gateway, 'pm_card_visa', 'order-b');
    expect(a).not.toEqual(b);
    expect(gateway.charges.size).toBe(2);
  });
});
