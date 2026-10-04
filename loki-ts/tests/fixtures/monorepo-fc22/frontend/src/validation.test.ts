import { test } from "bun:test";
import { check } from "./validation";
test("frontend validation", () => { check("x"); });
