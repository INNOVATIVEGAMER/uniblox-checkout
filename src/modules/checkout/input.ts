import { z } from 'zod';
import { couponCodeSchema } from '../coupons/code';

export const checkoutBodySchema = z.strictObject({
  expectedTotalPaise: z.int().min(0),
  paymentToken: z.string().min(1).max(255),
  couponCode: couponCodeSchema.optional(),
});

export type CheckoutInput = { cartId: string } & z.infer<typeof checkoutBodySchema>;
