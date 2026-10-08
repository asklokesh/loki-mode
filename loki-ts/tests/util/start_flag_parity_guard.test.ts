// D91 finding class 2 guard: a `loki start` flag accepted on one route (bash cmd_start in autonomy/loki, or Bun parseStartArgs in
// src/commands/start.ts) and silently dropped on the other. Every flag in the union of both sets must appear in
// guard-allowlists/start-flags.txt as `both` or `bash-only | reason` or `bun-only | reason`. Adding a flag to one route only
// fails until the table says so, with a reason.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, loadAllowlist } from "./_guard_lib.ts";

function bashFlags(): Set<string> {
  const lines = readFileSync(join(REPO, "autonomy", "loki"), "utf8").split("\n");
  const s = lines.findIndex((l) => l.startsWith("cmd_start() {"));
  const e = lines.findIndex((l, i) => i > s && l === "}");
  const out = new Set<string>();
  for (const l of lines.slice(s, e)) {
    const m = l.match(/^\s+(-[-a-zA-Z0-9|=*]+)\)/);
    if (!m) continue;
    for (const alt of m[1].split("|")) out.add(alt.replace(/=\*$/, ""));
  }
  return out;
}

function bunFlags(): Set<string> {
  const src = readFileSync(join(REPO, "loki-ts", "src", "commands", "start.ts"), "utf8");
  const out = new Set<string>(["--help", "-h"]);
  for (const name of ["VALUE_FLAGS", "NOOP_BOOL_FLAGS"]) {
    const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
    expect(m).not.toBeNull();
    for (const f of (m as RegExpMatchArray)[1].matchAll(/"(-[-a-zA-Z0-9]+)"/g)) out.add(f[1]);
  }
  for (const f of src.matchAll(/BOOL_ENV_FLAGS\.set\(\s*"(-[-a-zA-Z0-9]+)"/g)) out.add(f[1]);
  return out;
}

test("every loki start flag is declared in the parity table and matches its real route coverage", () => {
  const table = loadAllowlist("start-flags.txt");
  const bash = bashFlags();
  const bun = bunFlags();
  expect(bash.size).toBeGreaterThan(20);
  expect(bun.size).toBeGreaterThan(8);
  const actual: Record<string, string> = {};
  for (const f of new Set([...bash, ...bun])) actual[f] = bash.has(f) && bun.has(f) ? "both" : bash.has(f) ? "bash-only" : "bun-only";
  const undeclared = Object.keys(actual).filter((f) => !(f in table));
  const stale = Object.keys(table).filter((f) => !(f in actual));
  const wrong = Object.keys(actual).filter((f) => f in table && table[f].split(" ")[0] !== actual[f]);
  const noReason = Object.keys(table).filter((f) => table[f].split(" ")[0] !== "both" && table[f].replace(/^\S+\s*/, "").length < 10);
  expect({ undeclared, stale, wrong, noReason }).toEqual({ undeclared: [], stale: [], wrong: [], noReason: [] });
});
