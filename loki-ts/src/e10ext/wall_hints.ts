// A-103: the brief names the detected runner and one exact example, so a node:test repo never gets Jest globals.
export const RUNNER_HINT: Partial<Record<string, string>> = {
  node: "node:test. Start with: const test = require('node:test'); const assert = require('node:assert');\nExample: test('name', () => { assert.strictEqual(fn(1), 2); });  Run: node --test <file>. Never use Jest globals (describe, it, expect).",
  jest: "Jest. Example: test('name', () => { expect(fn(1)).toBe(2); });  Run: npx jest <file>.",
  vitest: "Vitest. Example: import { test, expect } from 'vitest'; test('name', () => { expect(fn(1)).toBe(2); });  Run: npx vitest run <file>.",
  bun: "bun:test. Example: import { test, expect } from 'bun:test'; test('name', () => { expect(fn(1)).toBe(2); });  Run: bun test <file>.",
  pytest: "pytest. Example: def test_name(): assert fn(1) == 2  Run: python -m pytest <file>.",
};
// D77 (W1-S2): the Wall manifest wiring lives in features/; re-exported here so wall.ts needs no extra import line (core budget).
export { wallManifestFor } from "../features/wall_manifest_wire.ts";
