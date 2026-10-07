import { z } from 'zod';
import { logCall } from './response-log';

export const CART_STATUSES = ['open', 'pending_payment', 'checked_out'] as const;
export const ORDER_STATUSES = ['pending_payment', 'paid', 'failed'] as const;
export const COUPON_STATUSES = ['available', 'reserved', 'redeemed'] as const;

export const PAYMENT_TOKENS = [
  'pm_card_visa',
  'pm_card_chargeDeclined',
  'pm_card_chargeDeclinedInsufficientFunds',
  'tok_timeout_approved',
  'tok_timeout_declined',
] as const;

const couponViewSchema = z.object({ code: z.string(), percentOff: z.number() });

const productSchema = z.object({ id: z.string(), name: z.string(), pricePaise: z.number(), stock: z.number() });

const cartSchema = z.object({
  id: z.uuid(),
  status: z.enum(CART_STATUSES),
  orderId: z.uuid().nullable(),
  lines: z.array(
    z.object({
      productId: z.string(),
      name: z.string(),
      unitPricePaise: z.number(),
      quantity: z.number(),
      available: z.boolean(),
      lineTotalPaise: z.number(),
    }),
  ),
  subtotalPaise: z.number(),
  coupon: couponViewSchema.nullable(),
  discountPaise: z.number(),
  totalPaise: z.number(),
});

const orderSchema = z.object({
  id: z.uuid(),
  cartId: z.uuid(),
  status: z.enum(ORDER_STATUSES),
  subtotalPaise: z.number(),
  discountPaise: z.number(),
  totalPaise: z.number(),
  coupon: couponViewSchema.nullable(),
  paymentRef: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  lines: z.array(
    z.object({
      productId: z.string(),
      productName: z.string(),
      unitPricePaise: z.number(),
      quantity: z.number(),
      lineTotalPaise: z.number(),
    }),
  ),
});

const couponSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  milestone: z.number(),
  percentOff: z.number(),
  status: z.enum(COUPON_STATUSES),
  createdAt: z.string(),
  redeemedAt: z.string().nullable(),
});

const generatedCouponSchema = z.object({ coupon: couponSchema, remainingEligible: z.number() });

const reportSchema = z.object({
  paidOrders: z.number(),
  ordersByStatus: z.object({ paid: z.number(), pending_payment: z.number(), failed: z.number() }),
  quantityByProduct: z.array(z.object({ productId: z.string(), name: z.string(), quantity: z.number() })),
  grossRevenuePaise: z.number(),
  discountsPaise: z.number(),
  netRevenuePaise: z.number(),
  coupons: z.object({ generated: z.number(), available: z.number(), reserved: z.number(), redeemed: z.number() }),
  milestones: z.object({ n: z.number(), reached: z.number(), rewarded: z.number(), unrewarded: z.number() }),
});

const reconcileSchema = z.object({
  resolved: z.array(z.object({ orderId: z.uuid(), status: z.enum(['paid', 'failed']) })),
  stillPending: z.number(),
});

const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

const orderRefSchema = z.object({ orderId: z.uuid() });

export type Product = z.infer<typeof productSchema>;
export type Cart = z.infer<typeof cartSchema>;
export type Order = z.infer<typeof orderSchema>;
export type OrderStatus = Order['status'];
export type Coupon = z.infer<typeof couponSchema>;
export type PaymentToken = (typeof PAYMENT_TOKENS)[number];
export type CheckoutBody = { expectedTotalPaise: number; paymentToken: PaymentToken; couponCode?: string };
export type ProductPatch = { pricePaise?: number; stock?: number };

/** A response in the API's error envelope. Anything else that fails is a plain Error. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
    readonly replayed: boolean,
  ) {
    super(message);
  }
}

export type ApiResponse<T> = { status: number; replayed: boolean; data: T };

function parseBody(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request<T>(
  method: string,
  path: string,
  schema: z.ZodType<T>,
  { body, idempotencyKey }: { body?: unknown; idempotencyKey?: string } = {},
): Promise<ApiResponse<T>> {
  const headers = new Headers();
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (idempotencyKey !== undefined) headers.set('Idempotency-Key', idempotencyKey);

  const response = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const parsedBody = parseBody(text);
  const replayed = response.headers.get('Idempotent-Replayed') === 'true';
  logCall({
    method,
    path,
    status: response.status,
    idempotencyKey,
    replayed,
    retryAfter: response.headers.get('Retry-After'),
    body: parsedBody,
  });

  if (response.ok) {
    const parsed = schema.safeParse(parsedBody);
    if (!parsed.success) {
      throw new Error(`${method} ${path} returned ${response.status} with an unexpected body:\n${z.prettifyError(parsed.error)}`);
    }
    return { status: response.status, replayed, data: parsed.data };
  }

  const envelope = errorEnvelopeSchema.safeParse(parsedBody);
  if (!envelope.success) {
    throw new Error(`${method} ${path} returned ${response.status} without an error envelope. Is the API running?\n${text.slice(0, 300)}`);
  }
  const { code, message, details } = envelope.data.error;
  throw new ApiError(response.status, code, message, details, replayed);
}

const data = async <T>(response: Promise<ApiResponse<T>>) => (await response).data;

export const api = {
  listProducts: () => data(request('GET', '/products', z.array(productSchema))),
  patchProduct: (id: string, patch: ProductPatch) =>
    data(request('PATCH', `/admin/products/${encodeURIComponent(id)}`, productSchema, { body: patch })),

  createCart: () => data(request('POST', '/carts', cartSchema)),
  getCart: (id: string, couponCode?: string) => {
    const query = couponCode === undefined ? '' : `?couponCode=${encodeURIComponent(couponCode)}`;
    return data(request('GET', `/carts/${encodeURIComponent(id)}${query}`, cartSchema));
  },
  setQuantity: (cartId: string, productId: string, quantity: number) =>
    data(request('PUT', `/carts/${encodeURIComponent(cartId)}/items/${encodeURIComponent(productId)}`, cartSchema, { body: { quantity } })),
  removeItem: (cartId: string, productId: string) =>
    data(request('DELETE', `/carts/${encodeURIComponent(cartId)}/items/${encodeURIComponent(productId)}`, cartSchema)),
  checkout: (cartId: string, idempotencyKey: string, body: CheckoutBody) =>
    request('POST', `/carts/${encodeURIComponent(cartId)}/checkout`, orderSchema, { body, idempotencyKey }),

  getOrder: (id: string) => data(request('GET', `/orders/${encodeURIComponent(id)}`, orderSchema)),
  listOrders: (status?: OrderStatus) =>
    data(request('GET', status === undefined ? '/admin/orders' : `/admin/orders?status=${status}`, z.array(orderSchema))),

  generateCoupon: () => data(request('POST', '/admin/coupons', generatedCouponSchema)),
  listCoupons: () => data(request('GET', '/admin/coupons', z.array(couponSchema))),
  getReport: () => data(request('GET', '/admin/report', reportSchema)),
  reconcile: () => data(request('POST', '/admin/payments/reconcile', reconcileSchema)),
};

/** The order an error points at: PAYMENT_FAILED, CART_CHECKED_OUT and CART_PAYMENT_PENDING carry one. */
export function orderIdOf(error: ApiError): string | null {
  return orderRefSchema.safeParse(error.details).data?.orderId ?? null;
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

export function formatPaise(paise: number): string {
  return inr.format(paise / 100);
}
