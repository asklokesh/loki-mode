import { expect, test } from "bun:test";

// E-154b: the preload default must survive earlier files that override and
// restore it. Run as: bun test tests/engine10/seal.test.ts tests/zz/probe.test.ts
test("preload signing-key default survives", () => {
  expect(process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]).toBeTruthy();
});
