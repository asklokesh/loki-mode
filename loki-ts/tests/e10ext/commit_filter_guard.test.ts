import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedBackstop, validBase } from "../../src/e10ext/commit_filter.ts";

let dir = "";
let env: NodeJS.ProcessEnv = {};
const calls = () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : "");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "d50f4b-"));
  writeFileSync(join(dir, "git"), `#!/bin/sh\necho "$@" >> "${dir}/calls.log"\nexit 0\n`);
  chmodSync(join(dir, "git"), 0o755);
  env = { PATH: `${dir}:/usr/bin:/bin` };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("validBase accepts only 40-64 lowercase hex", () => {
  expect(validBase("a".repeat(40))).toBe("a".repeat(40));
  expect(validBase("b".repeat(64))).toBe("b".repeat(64));
  for (const bad of ["--output=x", "HEAD", "a".repeat(39), "a".repeat(65), "A".repeat(40), null, 7]) expect(validBase(bad)).toBeNull();
});

test("a base of --output=x is refused with zero git spawns", () => {
  const why = guardedBackstop(true, dir, env, "run1", "--output=x", undefined);
  expect(why).toContain("not a full object id");
  expect(calls()).toBe("");
});

test("a tampered log runs no backstop (zero git spawns)", () => {
  const why = guardedBackstop(false, dir, env, "run1", "a".repeat(40), undefined);
  expect(why).toContain("failed verification");
  expect(calls()).toBe("");
});

test("an intact log with a valid base still runs the backstop", () => {
  expect(guardedBackstop(true, dir, env, "run1", "a".repeat(40), undefined)).toBeNull();
  expect(calls()).toContain("add -A");
});
