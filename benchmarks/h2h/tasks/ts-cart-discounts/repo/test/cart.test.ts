import { expect, test } from "bun:test";
import { cartTotal, subtotal } from "../src/cart";
import { checkoutSummary } from "../src/checkout";

const small = [{ sku: "mug", priceCents: 1200, qty: 2 }];
const big = [{ sku: "lamp", priceCents: 6000, qty: 1 }];

test("subtotal multiplies price by quantity", () => {
  expect(subtotal(small)).toBe(2400);
});

test("shipping is added under the free shipping minimum", () => {
  expect(cartTotal(small)).toBe(2899);
});

test("shipping is free at or over the minimum", () => {
  expect(cartTotal(big)).toBe(6000);
});

test("empty cart costs nothing", () => {
  expect(cartTotal([])).toBe(0);
});

test("checkout summary", () => {
  expect(checkoutSummary(small)).toBe("Total: $28.99");
});
