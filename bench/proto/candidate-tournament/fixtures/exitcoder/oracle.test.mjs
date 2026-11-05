import { test } from "node:test";
import assert from "node:assert/strict";
import { ExitError, MultiError, exitCodeFor } from "./errors.mjs";
const wrap = (e) => new Error("w", { cause: e });
test("oracle: wrapped ExitError", () => assert.equal(exitCodeFor(wrap(new ExitError("b", 4))), 4));
test("oracle: wrapped MultiError", () => assert.equal(exitCodeFor(wrap(new MultiError([new ExitError("a", 5)]))), 5));
test("oracle: MultiError member wrapped", () => assert.equal(exitCodeFor(new MultiError([wrap(new ExitError("a", 6))])), 6));
