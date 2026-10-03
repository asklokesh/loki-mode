// Guards that every user-facing command dispatch() routes is listed in HELP
// and that the header comment does not carry a stale route count.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(import.meta.dir, "..", "..", "src", "cli.ts"), "utf8");
const EXCLUDED = new Set(["help", "--help", "-h", "--version", "-v", "receipt", "internal", "completion", "__complete"]);

function helpText(): string {
  const m = SRC.match(/const HELP = `([\s\S]*?)`;/);
  if (!m) throw new Error("HELP not found");
  return m[1]!;
}

function dispatchLabels(): string[] {
  const start = SRC.indexOf("async function dispatch");
  if (start < 0) throw new Error("dispatch not found");
  const body = SRC.slice(start);
  const labels = [...body.matchAll(/^ {4}case "([^"]+)":/gm)].map((m) => m[1]!);
  return labels.filter((l) => !EXCLUDED.has(l));
}

describe("cli HELP covers dispatch routes", () => {
  test("finds dispatch labels", () => {
    expect(dispatchLabels().length).toBeGreaterThan(10);
  });
  test("every user-facing case label appears in HELP", () => {
    const help = helpText();
    const missing = dispatchLabels().filter(
      (l) => !new RegExp(`^\\s+${l}(\\s|$)`, "m").test(help),
    );
    expect(missing).toEqual([]);
  });
  test("header no longer claims 8 highest-traffic commands", () => {
    expect(SRC.slice(0, SRC.indexOf("import "))).not.toContain("8 highest-traffic");
  });
});
