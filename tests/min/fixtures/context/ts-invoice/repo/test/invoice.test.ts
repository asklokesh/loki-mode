import { expect, test } from "bun:test";
import { invoiceTotal } from "../src/invoice";

test("US invoice adds 7% tax", () => {
  expect(invoiceTotal({ id: "c1", name: "Ann", country: "US" }, [{ sku: "a", unitCents: 1000, qty: 1 }])).toBe(1070);
});
