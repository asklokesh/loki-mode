import { expect, test } from "bun:test";
import type { Cart } from "../src/cart";
import { priceCart } from "../src/pricing";
import { bulkDiscountRule } from "../src/rules/bulkDiscount";

const cart: Cart = {
  items: [
    { sku: "TEE", category: "shirts", unitCents: 1500, qty: 4 },
    { sku: "CAP", category: "hats", unitCents: 1200, qty: 1 },
  ],
};

test("no rules: total is the subtotal", () => {
  expect(priceCart(cart, [])).toEqual({ subtotalCents: 7200, adjustments: [], totalCents: 7200 });
});

test("bulk discount applies per qualifying line", () => {
  expect(priceCart(cart, [bulkDiscountRule(3, 100)])).toEqual({
    subtotalCents: 7200,
    adjustments: [{ rule: "bulk:3", amountCents: -400 }],
    totalCents: 6800,
  });
});

test("a rule that does not apply leaves no adjustment", () => {
  expect(priceCart(cart, [bulkDiscountRule(10, 100)]).adjustments).toEqual([]);
});

test("rules see the running total and the total never goes below zero", () => {
  const seen: number[] = [];
  const spy = (_c: Cart, running: number) => {
    seen.push(running);
    return { rule: "spy", amountCents: -10000 };
  };
  const q = priceCart(cart, [bulkDiscountRule(3, 100), spy]);
  expect(seen).toEqual([6800]);
  expect(q.totalCents).toBe(0);
});

test("bulkDiscountRule rejects bad arguments", () => {
  expect(() => bulkDiscountRule(0, 100)).toThrow(RangeError);
});
