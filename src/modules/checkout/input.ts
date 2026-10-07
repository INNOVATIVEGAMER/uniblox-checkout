import { z } from 'zod';

export const checkoutBodySchema = z.strictObject({
  expectedTotalPaise: z.int().min(0),
  paymentToken: z.string().min(1).max(255),
});

export type CheckoutInput = { cartId: string } & z.infer<typeof checkoutBodySchema>;
