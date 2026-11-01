export interface Discount {
  /** New subtotal in cents. */
  apply(subtotalCents: number): number;
  freeShipping: boolean;
}

export const DISCOUNTS: Record<string, Discount> = {
  SAVE10: { apply: (s) => Math.round(s * 0.9), freeShipping: false },
  FLAT5: { apply: (s) => Math.max(0, s - 500), freeShipping: false },
  FREESHIP: { apply: (s) => s, freeShipping: true },
};

export function lookupDiscount(code: string): Discount | undefined {
  return DISCOUNTS[code.trim().toUpperCase()];
}
