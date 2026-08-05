// self_heal_context.test.ts -- SLICE 6c TS-side guard.
//
// buildSelfHealContext (build_prompt.ts) reads the prior iteration's classified
// LAST_ERROR.json, emits a one-shot SELF_HEAL_HINT, and LEARN-FORWARD-archives
// the consumed record to failure-history.jsonl before clearing the single file.
//
// The council CONCERN this test locks: the archive MUST mirror bash
// _loki_archive_last_error (run.sh:1180) -- bounded to the most recent 50
// entries and written atomically (temp file + rename), NOT an unbounded raw
// append. Without the bound, a long-running project grows failure-history.jsonl
// without limit. This test proves the hint fires once, is gated on
// LOKI_SELF_HEAL, clears the source, and the archive stays bounded at 50.
//
// Hermetic: mkdtemp scratch dir, no network, no API. No emojis. No em dashes.

import { test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { _internals } from "../../src/runner/build_prompt.ts";

const { buildSelfHealContext } = _internals as {
  buildSelfHealContext: (cwd: string) => string;
};

let dir: string;
const prevEnv = process.env["LOKI_SELF_HEAL"];

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "loki-selfheal-"));
  mkdirSync(resolve(dir, ".loki/state"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env["LOKI_SELF_HEAL"];
  else process.env["LOKI_SELF_HEAL"] = prevEnv;
});

const lastErrorPath = () => resolve(dir, ".loki/state/LAST_ERROR.json");
const histPath = () => resolve(dir, ".loki/state/failure-history.jsonl");
const writeLastError = (rec: object) => writeFileSync(lastErrorPath(), JSON.stringify(rec));

test("gated off: LOKI_SELF_HEAL unset -> no hint, source untouched", () => {
  delete process.env["LOKI_SELF_HEAL"];
  writeLastError({ iteration: 2, error_class: "test_failure", brief: "x" });
  expect(buildSelfHealContext(dir)).toBe("");
  expect(existsSync(lastErrorPath())).toBe(true); // not consumed when gated off
});

test("actionable error -> emits hint naming the class, then clears the source", () => {
  process.env["LOKI_SELF_HEAL"] = "1";
  writeLastError({ iteration: 3, error_class: "build_timeout", brief: "ran out of time" });
  const hint = buildSelfHealContext(dir);
  expect(hint).toContain("SELF_HEAL_HINT");
  expect(hint).toContain("build_timeout");
  expect(hint).toContain("#3");
  // one-shot: the source is consumed so it does not re-inject next iteration.
  expect(existsSync(lastErrorPath())).toBe(false);
});

test('non-actionable ("unknown"/empty) -> no hint', () => {
  process.env["LOKI_SELF_HEAL"] = "1";
  writeLastError({ iteration: 4, error_class: "unknown", brief: "" });
  expect(buildSelfHealContext(dir)).toBe("");
});

test("learn-forward: consumed record is archived to failure-history.jsonl", () => {
  process.env["LOKI_SELF_HEAL"] = "1";
  writeLastError({ iteration: 5, error_class: "provider_empty_output", brief: "" });
  buildSelfHealContext(dir);
  expect(existsSync(histPath())).toBe(true);
  const hist = readFileSync(histPath(), "utf-8");
  expect(hist).toContain("provider_empty_output");
});

test("archive is BOUNDED to the most recent 50 entries (the council CONCERN)", () => {
  process.env["LOKI_SELF_HEAL"] = "1";
  // Pre-seed 60 old entries so a fresh archive must trim to 50.
  const seed = Array.from({ length: 60 }, (_, i) => JSON.stringify({ n: i })).join("\n") + "\n";
  writeFileSync(histPath(), seed);
  writeLastError({ iteration: 9, error_class: "test_failure", brief: "boom" });
  buildSelfHealContext(dir);
  const lines = readFileSync(histPath(), "utf-8").split("\n").filter((l) => l.trim() !== "");
  expect(lines.length).toBe(50); // bounded, not 61
  // The newest record is retained; the oldest seed entries are dropped.
  expect(lines[lines.length - 1]).toContain("test_failure");
  expect(lines.some((l) => l.includes('"n":0'))).toBe(false); // oldest trimmed
});

test("archive write leaves no temp file behind (atomic rename)", () => {
  process.env["LOKI_SELF_HEAL"] = "1";
  writeLastError({ iteration: 1, error_class: "test_failure", brief: "b" });
  buildSelfHealContext(dir);
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const leftovers = readdirSync(resolve(dir, ".loki/state")).filter((f: string) => f.includes(".tmp"));
  expect(leftovers).toEqual([]);
});
