// Guards that every user-facing command dispatch() routes is listed in HELP
// and that the header comment does not carry a stale route count.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { allTreeFlags, generateBash, generateFish, generateZsh } from "../../src/cli/completions.ts";
import { REGISTRY } from "../../src/cli/registry.ts";

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
      // A label may lead its HELP line or follow "|" in an alias row such as "pause | resume | cancel".
      (l) => !new RegExp(`(^\\s+|\\|\\s*)${l}(\\s|$)`, "m").test(help),
    );
    expect(missing).toEqual([]);
  });
  test("header no longer claims 8 highest-traffic commands", () => {
    expect(SRC.slice(0, SRC.indexOf("import "))).not.toContain("8 highest-traffic");
  });
});

describe("shell completions list registry flags", () => {
  const bash = generateBash();
  const zsh = generateZsh();
  const fish = generateFish();
  const flagsOf = (name: string): string[] => (REGISTRY.find((c) => c.name === name)?.flags ?? []).map((f) => f.name);

  test("flags added after the table was written are registered on their command", () => {
    expect(flagsOf("status")).toEqual(expect.arrayContaining(["--probe", "--badge"]));
    expect(flagsOf("start")).toContain("--cost");
  });
  test("every registry flag appears in every generated shell script", () => {
    for (const { flag } of allTreeFlags()) {
      expect(bash.includes(flag.name)).toBe(true);
      expect(zsh.includes(flag.name)).toBe(true);
      expect(fish.includes(flag.name.replace(/^--?/, ""))).toBe(true);
    }
  });
  test("start --cost completes through the real loki completion route", () => {
    const r = Bun.spawnSync(["bash", resolve(import.meta.dir, "..", "..", "..", "bin", "loki"), "completion", "bash"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("--cost");
  });
});
