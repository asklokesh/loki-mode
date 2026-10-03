import { expect, test } from "bun:test";
import { fmtUsd } from "../../ui/src/format";

test("fmtUsd: 2 decimals at or above a cent, 3 below, never 4", () => {
  expect(fmtUsd(0.1234)).toBe("$0.12");
  expect(fmtUsd(12)).toBe("$12.00");
  expect(fmtUsd(0.01)).toBe("$0.01");
  expect(fmtUsd(0.0042)).toBe("$0.004");
  expect(fmtUsd(0.00004)).toBe("$0.000");
});

test("fmtUsd: a measured zero is not the unmeasured placeholder", () => {
  expect(fmtUsd(0)).toBe("$0.000");
  expect(fmtUsd(0)).not.toBe("$0.00");
});
