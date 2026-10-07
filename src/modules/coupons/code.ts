import { randomInt } from 'node:crypto';
import { z } from 'zod';

export const couponCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .toUpperCase()
  .overwrite((code) => code.replace(/[IL]/g, '1').replace(/O/g, '0'));

// Crockford base32: uppercase, with no I, L or O, so couponCodeSchema parses a generated code unchanged.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SUFFIX_LENGTH = 8;

export function generateCouponCode(percentOff: number, milestone: number): string {
  const suffix = Array.from({ length: SUFFIX_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `SAVE${percentOff}-M${milestone}-${suffix}`;
}
