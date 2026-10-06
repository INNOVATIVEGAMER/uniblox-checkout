export const MAX_UNIT_PRICE_PAISE = 1_000_000_000;
export const MAX_LINE_QUANTITY = 1000;

export function lineTotal(unitPricePaise: number, quantity: number): number {
  return unitPricePaise * quantity;
}

// Rounds down once, at order level. Exact while subtotalPaise * percentOff stays below 2^53,
// which MAX_UNIT_PRICE_PAISE and MAX_LINE_QUANTITY keep it far under.
export function discount(subtotalPaise: number, percentOff: number): number {
  return Math.floor((subtotalPaise * percentOff) / 100);
}

export function total(subtotalPaise: number, discountPaise: number): number {
  return subtotalPaise - discountPaise;
}
