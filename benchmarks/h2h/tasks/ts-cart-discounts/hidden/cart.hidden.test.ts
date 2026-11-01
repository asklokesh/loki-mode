import { expect, test } from "bun:test";
import { cartTotal, InvalidDiscountError } from "../src/cart";
import { checkoutSummary } from "../src/checkout";

const small = [{ sku: "mug", priceCents: 1200, qty: 2 }]; // 2400 + 499 shipping
const big = [{ sku: "lamp", priceCents: 6000, qty: 1 }]; // 6000, free shipping
const odd = [{ sku: "pen", priceCents: 1007, qty: 1 }]; // 10% = 100.7 cents, so 906 either way you round

test("no code is unchanged", () => {
  expect(cartTotal(small)).toBe(2899);
  expect(cartTotal(small, undefined)).toBe(2899);
  expect(cartTotal(small, "")).toBe(2899);
  expect(cartTotal(big)).toBe(6000);
});

test("SAVE10 takes 10% off the subtotal only", () => {
  expect(cartTotal(small, "SAVE10")).toBe(2160 + 499);
  expect(cartTotal(big, "SAVE10")).toBe(5400);
});

test("SAVE10 rounds to the nearest cent", () => {
  expect(cartTotal(odd, "SAVE10")).toBe(906 + 499);
});

test("free shipping is decided before the discount", () => {
  const edge = [{ sku: "kettle", priceCents: 5000, qty: 1 }];
  expect(cartTotal(edge, "SAVE10")).toBe(4500);
  expect(cartTotal(edge, "FLAT5")).toBe(4500);
});

test("FLAT5 takes 500 cents off but never below zero", () => {
  expect(cartTotal(small, "FLAT5")).toBe(1900 + 499);
  const cheap = [{ sku: "sticker", priceCents: 300, qty: 1 }];
  expect(cartTotal(cheap, "FLAT5")).toBe(0 + 499);
});

test("FREESHIP waives shipping", () => {
  expect(cartTotal(small, "FREESHIP")).toBe(2400);
  expect(cartTotal(big, "FREESHIP")).toBe(6000);
});

test("codes are case-insensitive and trimmed", () => {
  expect(cartTotal(small, "save10")).toBe(2659);
  expect(cartTotal(small, "  FreeShip ")).toBe(2400);
});

test("unknown codes throw InvalidDiscountError", () => {
  expect(() => cartTotal(small, "BOGUS")).toThrow(InvalidDiscountError);
  let caught: unknown;
  try { cartTotal(small, "SAVE100"); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(InvalidDiscountError);
  expect(caught).toBeInstanceOf(Error);
});

test("empty cart with a code still costs nothing", () => {
  expect(cartTotal([], "FLAT5")).toBe(0);
});

test("checkoutSummary passes the code through", () => {
  expect(checkoutSummary(small, "FREESHIP")).toBe("Total: $24.00");
  expect(checkoutSummary(small)).toBe("Total: $28.99");
});
