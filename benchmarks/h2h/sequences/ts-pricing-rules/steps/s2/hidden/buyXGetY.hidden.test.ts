import { expect, test } from "bun:test";
import type { Cart } from "../src/cart";
import { priceCart } from "../src/pricing";
import { buyXGetYRule } from "../src/rules/buyXGetY";

const tees = (qty: number): Cart => ({
  items: [
    { sku: "TEE", category: "shirts", unitCents: 1500, qty },
    { sku: "CAP", category: "hats", unitCents: 1200, qty: 1 },
  ],
});

test("buy 2 get 1: every third unit is free", () => {
  expect(priceCart(tees(3), [buyXGetYRule("TEE", 2, 1)])).toEqual({
    subtotalCents: 5700,
    adjustments: [{ rule: "buy-2-get-1:TEE", amountCents: -1500 }],
    totalCents: 4200,
  });
  expect(buyXGetYRule("TEE", 2, 1)(tees(7), 0)).toEqual({ rule: "buy-2-get-1:TEE", amountCents: -3000 });
});

test("an incomplete group gets nothing", () => {
  expect(buyXGetYRule("TEE", 2, 1)(tees(2), 0)).toBeNull();
  expect(buyXGetYRule("TEE", 3, 2)(tees(4), 0)).toBeNull();
});

test("buy 3 get 2 counts free units per full group", () => {
  // 10 units = 2 groups of 5 -> 4 free
  expect(buyXGetYRule("TEE", 3, 2)(tees(10), 0)).toEqual({ rule: "buy-3-get-2:TEE", amountCents: -6000 });
});

test("units of the sku on several lines are pooled and priced at the lowest unit price", () => {
  const cart: Cart = {
    items: [
      { sku: "MUG", category: "home", unitCents: 900, qty: 1 },
      { sku: "MUG", category: "home", unitCents: 800, qty: 1 },
      { sku: "TEE", category: "shirts", unitCents: 1500, qty: 5 },
    ],
  };
  expect(buyXGetYRule("MUG", 1, 1)(cart, 0)).toEqual({ rule: "buy-1-get-1:MUG", amountCents: -800 });
});

test("sku match is exact and a missing sku gives null", () => {
  expect(buyXGetYRule("tee", 1, 1)(tees(4), 0)).toBeNull();
  expect(buyXGetYRule("SOCK", 1, 1)(tees(4), 0)).toBeNull();
});

test("rejects non-positive or fractional buy and free", () => {
  for (const [b, f] of [[0, 1], [1, 0], [2.5, 1], [2, -1]]) {
    expect(() => buyXGetYRule("TEE", b, f)).toThrow(RangeError);
  }
});
