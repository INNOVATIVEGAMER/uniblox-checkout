import { z } from 'zod';

// Lowercased so the same cart always hashes to the same checkout request.
export const cartParamsSchema = z.object({ id: z.uuid().toLowerCase() });
