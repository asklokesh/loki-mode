import { expect, test } from "bun:test";

// C2-F: guards tests/preload.ts. Spawned by control_default.test.ts with no LOKI_CONTROL in env.
test("preload defaults LOKI_CONTROL to 0 when the caller sets nothing", () => {
  expect(process.env["LOKI_CONTROL"]).toBe("0");
});
