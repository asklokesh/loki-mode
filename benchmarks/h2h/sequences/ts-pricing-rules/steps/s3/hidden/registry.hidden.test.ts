import { expect, test } from "bun:test";
import type { Cart } from "../src/cart";
import { priceCart } from "../src/pricing";
import { RuleError, parseRule, parseRules, ruleNames } from "../src/rules/index";
import { thresholdRule } from "../src/rules/threshold";

const cart: Cart = {
  items: [
    { sku: "TEE", category: "shirts", unitCents: 1500, qty: 3 },
    { sku: "CAP", category: "hats", unitCents: 1200, qty: 1 },
  ],
};

test("threshold applies once the running total reaches the minimum", () => {
  expect(thresholdRule(5000, 500)(cart, 5700)).toEqual({ rule: "threshold:5000", amountCents: -500 });
  expect(thresholdRule(5700, 500)(cart, 5700)).toEqual({ rule: "threshold:5700", amountCents: -500 });
  expect(thresholdRule(5701, 500)(cart, 5700)).toBeNull();
  expect(thresholdRule(0, 500)(cart, 300)).toEqual({ rule: "threshold:0", amountCents: -300 });
  expect(thresholdRule(0, 500)(cart, 0)).toBeNull();
});

test("threshold uses the running total after earlier rules", () => {
  // 5700 - 1500 (buy 2 get 1) = 4200, below 5000: no threshold discount
  const q = priceCart(cart, parseRules(["buy-x-get-y:TEE:2:1", "threshold:5000:500"]));
  expect(q.adjustments).toEqual([{ rule: "buy-2-get-1:TEE", amountCents: -1500 }]);
  expect(q.totalCents).toBe(4200);
  const q2 = priceCart(cart, parseRules(["threshold:5000:500", "buy-x-get-y:TEE:2:1"]));
  expect(q2.totalCents).toBe(3700);
});

test("threshold factory validation", () => {
  expect(() => thresholdRule(-1, 500)).toThrow(RangeError);
  expect(() => thresholdRule(100, 0)).toThrow(RangeError);
  expect(() => thresholdRule(10.5, 5)).toThrow(RangeError);
});

test("rule names", () => {
  expect(ruleNames()).toEqual(["bulk", "buy-x-get-y", "percent-off", "threshold"]);
});

test("every spec builds the matching rule", () => {
  const q = priceCart(cart, parseRules([" bulk:3:100 ", "percent-off:hats:50", "buy-x-get-y:TEE:2:1", "threshold:1000:250"]));
  expect(q.adjustments).toEqual([
    { rule: "bulk:3", amountCents: -300 },
    { rule: "percent-off:hats", amountCents: -600 },
    { rule: "buy-2-get-1:TEE", amountCents: -1500 },
    { rule: "threshold:1000", amountCents: -250 },
  ]);
  expect(q.totalCents).toBe(5700 - 300 - 600 - 1500 - 250);
  expect(parseRule("percent-off:shirts:10")(cart, 0)).toEqual({ rule: "percent-off:shirts", amountCents: -450 });
});

test("unknown rule names", () => {
  expect(() => parseRule("coupon:SAVE10")).toThrow(RuleError);
  expect(() => parseRule("coupon:SAVE10")).toThrow('unknown rule "coupon"');
  expect(() => parseRule("toString:1:2")).toThrow('unknown rule "toString"');
});

test("bad specs", () => {
  for (const spec of ["bulk:3", "bulk:3:100:7", "bulk:x:100", "percent-off::10", "percent-off:shirts:150", "threshold:100:-5", "buy-x-get-y:TEE:0:1", "bulk:1.5:100"]) {
    expect(() => parseRule(spec)).toThrow(`bad rule spec "${spec}"`);
  }
  let err: unknown;
  try {
    parseRules(["bulk:3:100", "percent-off:shirts"]);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(RuleError);
  expect((err as Error).name).toBe("RuleError");
});
