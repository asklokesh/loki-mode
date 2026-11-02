import { expect, test } from "bun:test";
import type { Cart } from "../src/cart";
import { priceCart } from "../src/pricing";
import { bulkDiscountRule } from "../src/rules/bulkDiscount";
import { percentOffRule } from "../src/rules/percentOff";

const cart: Cart = {
  items: [
    { sku: "TEE", category: "shirts", unitCents: 1999, qty: 3 },
    { sku: "POLO", category: "shirts", unitCents: 2500, qty: 1 },
    { sku: "CAP", category: "hats", unitCents: 1200, qty: 1 },
  ],
};

test("percent off the whole category", () => {
  // shirts: 5997 + 2500 = 8497; 15% = 1274.55 -> 1275
  expect(priceCart(cart, [percentOffRule("shirts", 15)])).toEqual({
    subtotalCents: 9697,
    adjustments: [{ rule: "percent-off:shirts", amountCents: -1275 }],
    totalCents: 8422,
  });
});

test("rounds half up to the cent", () => {
  const one: Cart = { items: [{ sku: "A", category: "c", unitCents: 50, qty: 1 }] };
  // 50 * 5% = 2.5 -> 3, and 50 * 1% = 0.5 -> 1
  expect(percentOffRule("c", 5)(one, 50)).toEqual({ rule: "percent-off:c", amountCents: -3 });
  expect(percentOffRule("c", 1)(one, 50)).toEqual({ rule: "percent-off:c", amountCents: -1 });
  const tiny: Cart = { items: [{ sku: "A", category: "c", unitCents: 49, qty: 1 }] };
  expect(percentOffRule("c", 1)(tiny, 49)).toBeNull();
});

test("no items in the category means no adjustment", () => {
  expect(percentOffRule("shoes", 20)(cart, 9697)).toBeNull();
  expect(priceCart(cart, [percentOffRule("shoes", 20)]).adjustments).toEqual([]);
});

test("100 percent takes the whole category and category match is exact", () => {
  expect(percentOffRule("hats", 100)(cart, 9697)).toEqual({ rule: "percent-off:hats", amountCents: -1200 });
  expect(percentOffRule("Hats", 50)(cart, 9697)).toBeNull();
});

test("is based on list prices, not on the running total", () => {
  const q = priceCart(cart, [bulkDiscountRule(3, 100), percentOffRule("shirts", 10)]);
  expect(q.adjustments).toEqual([
    { rule: "bulk:3", amountCents: -300 },
    { rule: "percent-off:shirts", amountCents: -850 },
  ]);
  expect(q.totalCents).toBe(9697 - 300 - 850);
});

test("rejects percents outside 1 to 100 or not whole", () => {
  for (const p of [0, -5, 101, 12.5]) {
    expect(() => percentOffRule("shirts", p)).toThrow(RangeError);
  }
});
