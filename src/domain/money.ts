export const MAX_UNIT_PRICE_PAISE = 1_000_000_000;
export const MAX_LINE_QUANTITY = 1000;
export const MAX_CART_LINES = 50;

export function lineTotal(unitPricePaise: number, quantity: number): number {
  return unitPricePaise * quantity;
}

// Rounds down once, at order level. Exact while subtotalPaise * percentOff stays below 2^53,
// which MAX_UNIT_PRICE_PAISE, MAX_LINE_QUANTITY and MAX_CART_LINES keep it under.
export function discount(subtotalPaise: number, percentOff: number): number {
  return Math.floor((subtotalPaise * percentOff) / 100);
}

export function total(subtotalPaise: number, discountPaise: number): number {
  return subtotalPaise - discountPaise;
}

export function priceLines<Line extends { unitPricePaise: number; quantity: number }>(lines: Line[]) {
  const priced = lines.map((line) => ({ ...line, lineTotalPaise: lineTotal(line.unitPricePaise, line.quantity) }));
  const subtotalPaise = priced.reduce((sum, line) => sum + line.lineTotalPaise, 0);
  const discountPaise = 0;
  return { lines: priced, subtotalPaise, discountPaise, totalPaise: total(subtotalPaise, discountPaise) };
}
