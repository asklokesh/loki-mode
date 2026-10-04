import { test } from "bun:test";
import { validate } from "./validation";
test("backend validation", () => { validate("x"); });
