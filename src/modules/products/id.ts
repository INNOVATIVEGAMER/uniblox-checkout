import { z } from 'zod';

export const productIdSchema = z.string().regex(/^p_[a-z0-9_]{1,60}$/, 'Invalid product id');
