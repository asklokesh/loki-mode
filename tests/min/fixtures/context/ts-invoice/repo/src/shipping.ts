import type { Cents } from "./money";

export function shippingFor(weightGrams: number, express: boolean): Cents {
  const base = weightGrams <= 500 ? 499 : 899;
  return express ? base * 2 : base;
}
