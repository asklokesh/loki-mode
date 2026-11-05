import { test } from "node:test";
import assert from "node:assert/strict";
import { ExitError, MultiError, exitCodeFor } from "./errors.mjs";
test("null is 0", () => assert.equal(exitCodeFor(null), 0));
test("ExitError code", () => assert.equal(exitCodeFor(new ExitError("x", 3)), 3));
test("plain error is 1", () => assert.equal(exitCodeFor(new Error("x")), 1));
test("MultiError uses last ExitError code", () => assert.equal(exitCodeFor(new MultiError([new ExitError("a", 2), new Error("b")])), 2));
