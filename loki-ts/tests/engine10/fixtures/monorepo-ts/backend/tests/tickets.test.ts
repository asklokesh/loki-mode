import { describe, expect, test } from "vitest";
import { countOpen } from "../src/tickets";
describe("tickets", () => { test("counts open", () => { expect(countOpen([{ open: true }, { open: false }])).toBe(1); }); });
