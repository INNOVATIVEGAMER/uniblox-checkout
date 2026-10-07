import { randomInt } from 'node:crypto';
import { z } from 'zod';

// Crockford decoding: a typed I or L reads as 1 and O as 0. No generated code contains those letters.
export const couponCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .toUpperCase()
  .overwrite((code) => code.replace(/[IL]/g, '1').replace(/O/g, '0'));

// Crockford base32: uppercase only, so a generated code survives couponCodeSchema unchanged.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SUFFIX_LENGTH = 8;

export function generateCouponCode(percentOff: number, milestone: number): string {
  const suffix = Array.from({ length: SUFFIX_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `SAVE${percentOff}-M${milestone}-${suffix}`;
}
